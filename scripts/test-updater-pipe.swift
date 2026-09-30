import Foundation

@main
struct UpdatePipeTest {
    static func main() throws {
        let process = Process()
        let input = Pipe(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: CommandLine.arguments[1])
        process.arguments = ["-e", "process.stdout.write('ready\\n'); process.stdin.once('data', () => process.exit(0)); setTimeout(() => process.exit(2), 3000);"]
        process.standardInput = input
        process.standardOutput = output
        try process.run()
        let start = Date()
        let data = readUpdateChunk(from: output.fileHandleForReading)
        guard String(data: data, encoding: .utf8) == "ready\n", Date().timeIntervalSince(start) < 2 else {
            process.waitUntilExit()
            throw NSError(domain: "UpdatePipeTest", code: 1, userInfo: [NSLocalizedDescriptionKey: "Native update reader waited for EOF instead of delivering the ready message."])
        }
        try input.fileHandleForWriting.write(contentsOf: Data("install\n".utf8))
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw NSError(domain: "UpdatePipeTest", code: 2) }
        print("Native updater receives ready/progress before helper exit.")

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = "PanelUpdaterTest.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer {
            try? FileManager.default.removeItem(at: directory)
            defaults.removePersistentDomain(forName: suite)
        }
        for path in ["runtime/bin", "app"] {
            try FileManager.default.createDirectory(at: directory.appendingPathComponent(path), withIntermediateDirectories: true)
        }
        try FileManager.default.createSymbolicLink(atPath: directory.appendingPathComponent("runtime/bin/node").path, withDestinationPath: CommandLine.arguments[1])
        let helper = "import {readFileSync} from 'node:fs'; const state=JSON.parse(readFileSync(new URL('./result.json',import.meta.url))); console.log(JSON.stringify(state)); process.exitCode=state.phase==='error'?1:0;"
        try helper.write(to: directory.appendingPathComponent("app/updater.mjs"), atomically: true, encoding: .utf8)
        let updater = PanelUpdater(defaults: defaults, current: "0.5.1", resources: directory)
        defer { updater.shutdown() }
        var phases: [String] = []
        updater.onChange = { phases.append(updater.state["phase"] as? String ?? "") }
        func check(_ result: [String: Any], manual: Bool = false) throws {
            phases.removeAll()
            try JSONSerialization.data(withJSONObject: result).write(to: directory.appendingPathComponent("app/result.json"))
            updater.check(manual: manual, showResult: false)
            let deadline = Date().addingTimeInterval(5)
            while updater.busy && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
            precondition(!updater.busy, "Fixture update helper did not exit")
        }
        func nextDelay() -> TimeInterval { (defaults.object(forKey: "PanelNextUpdateCheck") as! Date).timeIntervalSinceNow }
        try check(["phase": "error", "message": "HTTP 403"])
        precondition(!phases.contains("error") && !phases.contains("checking"), "Background failure must be silent")
        precondition(updater.state["phase"] as? String == "idle")
        precondition((1780...1800).contains(nextDelay()), "First failure retries in 30 minutes")
        precondition(defaults.object(forKey: "PanelLastUpdateCheck") == nil, "Failure must not count as a successful daily check")
        try check(["phase": "error", "message": "HTTP 403", "retryAfter": 7200])
        precondition((7180...7200).contains(nextDelay()), "Respect server retry delay")
        try check(["phase": "available", "version": "v0.6"])
        precondition(defaults.integer(forKey: "PanelUpdateFailureCount") == 0)
        precondition((86380...86400).contains(nextDelay()))
        try check(["phase": "error", "message": "offline"])
        precondition(updater.state["phase"] as? String == "available" && updater.state["version"] as? String == "v0.6", "Keep a previously discovered update during a network outage")
        try check(["phase": "error", "message": "offline"], manual: true)
        precondition(updater.state["phase"] as? String == "error" && updater.state["operation"] as? String == "check")
        try check(["phase": "idle"])
        precondition(defaults.string(forKey: "PanelAvailableUpdate") == nil)
        print("Native background failures stay silent, retry with backoff, preserve updates and recover.")
    }
}
