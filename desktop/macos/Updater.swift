import AppKit

// read(upToCount:) can wait to fill its buffer on a pipe. Updates need each
// progress/ready line immediately because the helper then waits for our reply.
func readUpdateChunk(from handle: FileHandle) -> Data { handle.availableData }

// All network, archive validation and replacement work runs in the bundled
// helper. The renderer can request an update, but cannot supply URLs or paths.
final class PanelUpdater {
    private let defaults: UserDefaults
    private let current: String
    private let resources: URL?
    private var timer: Timer?
    private var worker: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var buffer = Data()
    private var receivedState = false
    private var checking = false
    private var manualCheck = false
    private(set) var committed = false
    private(set) var state: [String: Any] = ["phase": "idle"]
    var onChange: (() -> Void)?
    var onReady: (() -> Void)?
    var onManualResult: ((String) -> Void)?

    init(defaults: UserDefaults = .standard,
         current: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0",
         resources: URL? = Bundle.main.resourceURL) {
        self.defaults = defaults
        self.current = current
        self.resources = resources
    }

    var busy: Bool { worker != nil }
    var installing: Bool { ["downloading", "verifying", "ready", "installing"].contains(state["phase"] as? String ?? "") }

    func start() {
        if defaults.string(forKey: "PanelUpdateCheckedVersion") != current {
            defaults.removeObject(forKey: "PanelAvailableUpdate")
            defaults.removeObject(forKey: "PanelUpdateFailureCount")
        }
        if let version = defaults.string(forKey: "PanelAvailableUpdate"),
           defaults.string(forKey: "PanelUpdateCheckedVersion") == current {
            state = ["phase": "available", "version": version]
        }
        schedule()
    }

    private func schedule() {
        timer?.invalidate()
        let sameVersion = defaults.string(forKey: "PanelUpdateCheckedVersion") == current
        let next = sameVersion ? defaults.object(forKey: "PanelNextUpdateCheck") as? Date
            ?? (defaults.object(forKey: "PanelLastUpdateCheck") as? Date)?.addingTimeInterval(24 * 60 * 60)
            ?? .distantPast : .distantPast
        let remaining = max(0, next.timeIntervalSinceNow)
        if remaining <= 0 { check(manual: false); return }
        timer = Timer.scheduledTimer(withTimeInterval: remaining, repeats: false) { [weak self] _ in self?.check(manual: false) }
    }

    func check(manual: Bool, showResult: Bool = true) {
        guard !busy else {
            // A scheduled check must not be lost if an installation is active.
            if !manual {
                timer?.invalidate()
                timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in self?.check(manual: false) }
            }
            return
        }
        timer?.invalidate()
        checking = true
        manualCheck = manual
        let previousVersion = state["version"] as? String
        if manual {
            state = ["phase": "checking"]
            if let version = previousVersion { state["version"] = version }
            onChange?()
        }
        launch(arguments: ["check", current], manual: manual && showResult)
    }

    private func finishCheck(_ result: [String: Any]) {
        let failed = result["phase"] as? String == "error"
        let failures = failed ? min(10, defaults.integer(forKey: "PanelUpdateFailureCount") + 1) : 0
        let retry = result["retryAfter"] as? Double ?? 0
        let delay = failed ? max(min(6 * 60 * 60, 30 * 60 * pow(2, Double(failures - 1))), retry.isFinite ? retry : 0) : 24 * 60 * 60
        defaults.set(failures, forKey: "PanelUpdateFailureCount")
        defaults.set(current, forKey: "PanelUpdateCheckedVersion")
        defaults.set(Date().addingTimeInterval(delay), forKey: "PanelNextUpdateCheck")
        if !failed {
            defaults.set(Date(), forKey: "PanelLastUpdateCheck")
            if let version = result["version"] as? String { defaults.set(version, forKey: "PanelAvailableUpdate") }
            else { defaults.removeObject(forKey: "PanelAvailableUpdate") }
        }
        state = result
        if failed {
            if !manualCheck { state = ["phase": "idle"] }
            else { state["operation"] = "check" }
            if let version = defaults.string(forKey: "PanelAvailableUpdate") {
                state["version"] = version
                if !manualCheck { state["phase"] = "available" }
            }
        }
        schedule()
        onChange?()
    }

    func prepare(report: URL) {
        guard !busy, let version = state["version"] as? String else { return }
        checking = false
        state = ["phase": "downloading", "version": version, "progress": 0]
        onChange?()
        launch(arguments: ["prepare", current, Bundle.main.bundleURL.path, String(getpid()), version, report.path], manual: false)
    }

    func fail(_ message: String) {
        var next: [String: Any] = ["phase": "error", "message": message]
        if let version = state["version"] as? String { next["version"] = version }
        state = next
        onChange?()
    }

    private func launch(arguments: [String], manual: Bool) {
        guard let resources = resources else {
            if checking { finishCheck(["phase": "error", "message": "无法启动更新服务。"]) }
            else { fail("无法启动更新服务。") }
            if manual { onManualResult?("无法启动更新服务。") }
            return
        }
        let process = Process()
        process.executableURL = resources.appendingPathComponent("runtime/bin/node")
        process.arguments = [resources.appendingPathComponent("app/updater.mjs").path] + arguments
        // Do not inherit model keys, proxy code injection or Node loader flags.
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": NSHomeDirectory(), "TMPDIR": NSTemporaryDirectory()]
        let incoming = Pipe(), outgoing = Pipe()
        process.standardInput = incoming
        process.standardOutput = outgoing
        process.standardError = FileHandle.nullDevice
        input = incoming.fileHandleForWriting
        output = outgoing.fileHandleForReading
        buffer = Data()
        receivedState = false
        worker = process
        do {
            try process.run()
            let handle = outgoing.fileHandleForReading
            DispatchQueue.global(qos: .utility).async { [weak self] in
                // A single reader queues all state lines before completion.
                // This avoids losing a final result to a pipe/exit race.
                while true {
                    let bytes = readUpdateChunk(from: handle)
                    if bytes.isEmpty { break }
                    DispatchQueue.main.async { self?.consume(bytes, from: process) }
                }
                process.waitUntilExit()
                DispatchQueue.main.async {
                    guard let self = self, self.worker === process else { return }
                    self.worker = nil
                    try? self.input?.close(); self.input = nil
                    try? self.output?.close(); self.output = nil
                    if self.committed { return }
                    if !self.receivedState || (!self.checking && process.terminationStatus != 0 && self.state["phase"] as? String != "error") {
                        if self.checking { self.finishCheck(["phase": "error", "message": "更新服务暂时不可用，将稍后自动重试。"]) }
                        else { self.fail("更新服务暂时不可用，请稍后重试。") }
                    }
                    if manual {
                        let phase = self.state["phase"] as? String
                        let message = phase == "available" ? "发现 \(self.state["version"] as? String ?? "新版")，点击左下角版本旁的更新按钮即可安装。"
                            : phase == "idle" ? "当前已是最新版本（v\(self.current)）。"
                            : self.state["message"] as? String ?? "暂时无法检查更新。"
                        self.onManualResult?(message)
                    }
                }
            }
        } catch {
            worker = nil
            output?.readabilityHandler = nil
            try? input?.close(); input = nil
            try? output?.close(); output = nil
            let message = "无法启动更新服务：\(error.localizedDescription)"
            if checking { finishCheck(["phase": "error", "message": message]) }
            else { fail(message) }
            if manual { onManualResult?(message) }
        }
    }

    private func consume(_ data: Data, from process: Process) {
        guard worker === process else { return }
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: newline)
            buffer.removeSubrange(...newline)
            guard let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let phase = value["phase"] as? String,
                  ["idle", "available", "downloading", "verifying", "ready", "error"].contains(phase) else { continue }
            if checking {
                if ["idle", "available", "error"].contains(phase) {
                    receivedState = true
                    finishCheck(value)
                }
                continue
            }
            receivedState = true
            var next = value
            if phase == "error", next["version"] == nil { next["version"] = state["version"] }
            state = next
            if phase == "available" { defaults.set(value["version"], forKey: "PanelAvailableUpdate") }
            if phase == "idle" { defaults.removeObject(forKey: "PanelAvailableUpdate") }
            onChange?()
            if phase == "ready" { onReady?() }
        }
    }

    func commit() throws {
        guard state["phase"] as? String == "ready", worker?.isRunning == true, let input = input else {
            throw NSError(domain: "PanelUpdate", code: 1, userInfo: [NSLocalizedDescriptionKey: "更新进程已停止，请重试。"])
        }
        try input.write(contentsOf: Data("install\n".utf8))
        committed = true
        try? input.close()
        self.input = nil
        state["phase"] = "installing"
        onChange?()
    }

    func cancel() {
        guard !committed else { return }
        try? input?.close(); input = nil
        worker?.terminate()
    }

    func shutdown() {
        timer?.invalidate()
        cancel()
    }
}
