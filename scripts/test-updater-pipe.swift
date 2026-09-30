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
    }
}
