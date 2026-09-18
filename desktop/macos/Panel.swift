import AppKit
import WebKit
import Darwin

// The renderer has only these three capabilities. No filesystem or shell API is
// exposed to JavaScript; the local server remains responsible for tool approval.
final class PanelApp: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply, WKDownloadDelegate {
    private var window: NSWindow!
    private var container: NSView!
    private var webView: WKWebView?
    private var statusView: NSView?
    private var service: Process?
    private var serviceLog: FileHandle?
    private var serviceURL: URL?
    private var readinessTimer: Timer?
    private var forceStopWork: DispatchWorkItem?
    private var stopGeneration: UUID?
    private var stopCompletion: (() -> Void)?
    private var launchGeneration = UUID()
    private var stopping = false
    private var terminating = false
    private var checkingRestart = false
    private var lockDescriptor: Int32 = -1
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var downloadDestinations: [ObjectIdentifier: (temporary: URL, destination: URL)] = [:]
    private var cancelledDownloads: Set<ObjectIdentifier> = []
    private var directoryPicker: NSOpenPanel?

    private let files = FileManager.default
    private var supportURL: URL {
        files.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Panel", isDirectory: true)
    }
    private var dataURL: URL { supportURL.appendingPathComponent("data", isDirectory: true) }
    private var readyURL: URL { supportURL.appendingPathComponent("server.json") }
    private var logURL: URL { supportURL.appendingPathComponent("server.log") }
    private var settingsURL: URL { supportURL.appendingPathComponent(".env") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            try files.createDirectory(at: supportURL, withIntermediateDirectories: true,
                                     attributes: [.posixPermissions: 0o700])
            try files.createDirectory(at: dataURL, withIntermediateDirectories: true,
                                     attributes: [.posixPermissions: 0o700])
            guard acquireInstanceLock() else { return }
            try prepareSettings()
        } catch {
            showFatalError("无法准备 Panel 数据目录", error.localizedDescription)
            return
        }
        makeMenu()
        makeWindow()
        startService()
    }

    private func acquireInstanceLock() -> Bool {
        let lockURL = supportURL.appendingPathComponent("desktop.lock")
        lockDescriptor = Darwin.open(lockURL.path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard lockDescriptor >= 0 else { showFatalError("无法启动 Panel", "无法创建应用锁文件。"); return false }
        guard flock(lockDescriptor, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(lockDescriptor)
            lockDescriptor = -1
            let others = NSRunningApplication.runningApplications(
                withBundleIdentifier: Bundle.main.bundleIdentifier ?? "app.panel.desktop")
                .filter { $0.processIdentifier != getpid() }
            if let other = others.first {
                other.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
                if let url = other.bundleURL { NSWorkspace.shared.open(url) }
            } else {
                showAlert("Panel 已在运行", "另一个 Panel 正在使用此数据目录。请先退出已有实例。")
            }
            NSApp.terminate(nil)
            return false
        }
        ftruncate(lockDescriptor, 0)
        let pid = Data("\(getpid())\n".utf8)
        pid.withUnsafeBytes { buffer in _ = Darwin.write(lockDescriptor, buffer.baseAddress, buffer.count) }
        return true
    }

    private func makeWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 920),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Panel"
        window.minSize = NSSize(width: 1060, height: 680)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.tabbingMode = .disallowed
        window.center()
        window.setFrameAutosaveName("PanelMainWindow")
        container = NSView(frame: NSRect(origin: .zero, size: window.contentLayoutRect.size))
        container.autoresizingMask = [.width, .height]
        window.contentView = container
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func makeMenu() {
        let main = NSMenu()
        let applicationMenu = NSMenu(title: "Panel")
        applicationMenu.addItem(item("关于 Panel", #selector(about)))
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(item("模型配置…", #selector(openSettings), ","))
        applicationMenu.addItem(item("重启本地服务…", #selector(restartService)))
        applicationMenu.addItem(item("显示数据文件夹", #selector(openDataDirectory)))
        applicationMenu.addItem(.separator())
        let services = NSMenu(title: "服务")
        let servicesItem = NSMenuItem(title: "服务", action: nil, keyEquivalent: "")
        servicesItem.submenu = services
        applicationMenu.addItem(servicesItem)
        NSApp.servicesMenu = services
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(NSMenuItem(title: "隐藏 Panel", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        let hideOthers = NSMenuItem(title: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        applicationMenu.addItem(hideOthers)
        applicationMenu.addItem(NSMenuItem(title: "显示全部", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: ""))
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(NSMenuItem(title: "退出 Panel", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        attach(applicationMenu, to: main)

        let file = NSMenu(title: "文件")
        file.addItem(item("新建探索", #selector(newWorkspace), "n"))
        file.addItem(item("搜索探索", #selector(search), "k"))
        file.addItem(.separator())
        file.addItem(NSMenuItem(title: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        attach(file, to: main)

        let edit = NSMenu(title: "编辑")
        for (title, selector, key, modifiers) in [
            ("撤销", "undo:", "z", NSEvent.ModifierFlags.command),
            ("重做", "redo:", "z", NSEvent.ModifierFlags([.command, .shift])),
            ("剪切", "cut:", "x", NSEvent.ModifierFlags.command),
            ("复制", "copy:", "c", NSEvent.ModifierFlags.command),
            ("粘贴", "paste:", "v", NSEvent.ModifierFlags.command),
            ("全选", "selectAll:", "a", NSEvent.ModifierFlags.command)
        ] {
            let menuItem = NSMenuItem(title: title, action: NSSelectorFromString(selector), keyEquivalent: key)
            menuItem.keyEquivalentModifierMask = modifiers
            edit.addItem(menuItem)
            if selector == "redo:" { edit.addItem(.separator()) }
        }
        attach(edit, to: main)

        let view = NSMenu(title: "显示")
        view.addItem(item("重新加载页面", #selector(reload), "r"))
        view.addItem(item("重启本地服务…", #selector(restartService)))
        view.addItem(.separator())
        view.addItem(item("实际大小", #selector(resetZoom), "0"))
        view.addItem(item("放大", #selector(zoomIn), "+"))
        view.addItem(item("缩小", #selector(zoomOut), "-"))
        view.addItem(.separator())
        let fullscreen = NSMenuItem(title: "进入全屏", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullscreen.keyEquivalentModifierMask = [.command, .control]
        view.addItem(fullscreen)
        attach(view, to: main)

        let windows = NSMenu(title: "窗口")
        windows.addItem(NSMenuItem(title: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        windows.addItem(NSMenuItem(title: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""))
        windows.addItem(.separator())
        windows.addItem(NSMenuItem(title: "全部置于前面", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: ""))
        attach(windows, to: main)
        NSApp.windowsMenu = windows

        let help = NSMenu(title: "帮助")
        help.addItem(item("Panel 使用帮助", #selector(helpPanel)))
        help.addItem(item("显示服务日志", #selector(openLogs)))
        attach(help, to: main)
        NSApp.helpMenu = help
        NSApp.mainMenu = main
    }

    private func item(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let result = NSMenuItem(title: title, action: action, keyEquivalent: key)
        result.target = self
        return result
    }

    private func attach(_ menu: NSMenu, to parent: NSMenu) {
        let root = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
        root.submenu = menu
        parent.addItem(root)
    }

    private func prepareSettings() throws {
        guard !files.fileExists(atPath: settingsURL.path) else { return }
        guard let template = Bundle.main.resourceURL?.appendingPathComponent("app/.env.example"),
              files.fileExists(atPath: template.path) else {
            throw NSError(domain: "Panel", code: 1, userInfo: [NSLocalizedDescriptionKey: "安装包缺少模型配置模板。"])
        }
        try files.copyItem(at: template, to: settingsURL)
        try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: settingsURL.path)
    }

    private func startService() {
        guard !terminating, !stopping, service == nil else { return }
        launchGeneration = UUID()
        let generation = launchGeneration
        serviceURL = nil
        destroyWebView()
        showStatus("正在启动 Panel", "正在准备你的本地工作台…", retry: false)

        // If the previous app was killed, give its parent-watchdog time to stop
        // the orphan before opening the same database from another process.
        let oldPID = ((try? Data(contentsOf: readyURL)).flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        })?["pid"] as? Int32
        let deadline = Date().addingTimeInterval(5)
        func waitForOldService() {
            guard self.launchGeneration == generation, !self.terminating else { return }
            if let pid = oldPID, pid > 1, Darwin.kill(pid, 0) == 0 {
                guard Date() < deadline else {
                    self.showStatus("上次服务仍在退出", "请稍后重试。Panel 会等待旧服务结束，保护本地探索数据。", retry: true)
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: waitForOldService)
                return
            }
            self.launchService(generation: generation)
        }
        waitForOldService()
    }

    private func launchService(generation: UUID) {
        guard let resources = Bundle.main.resourceURL else { return }
        do {
            try? files.removeItem(at: readyURL)
            let node = resources.appendingPathComponent("runtime/bin/node")
            let app = resources.appendingPathComponent("app", isDirectory: true)
            guard files.isExecutableFile(atPath: node.path),
                  files.fileExists(atPath: app.appendingPathComponent("server/index.mjs").path) else {
                throw NSError(domain: "Panel", code: 2, userInfo: [NSLocalizedDescriptionKey: "安装包缺少 Node 运行时或本地服务，请重新构建应用。"])
            }
            try prepareLog()
            let process = Process()
            process.executableURL = node
            process.arguments = [app.appendingPathComponent("server/index.mjs").path]
            process.currentDirectoryURL = app
            var environment = ProcessInfo.processInfo.environment
            environment["NODE_ENV"] = "production"
            environment["PORT"] = "0"
            environment["PANEL_DATA_DIR"] = dataURL.path
            environment["PANEL_ENV_FILE"] = settingsURL.path
            environment["PANEL_DESKTOP"] = "1"
            environment["PANEL_DESKTOP_READY_FILE"] = readyURL.path
            environment["PANEL_DESKTOP_PARENT_PID"] = String(getpid())
            let pathComponents = [node.deletingLastPathComponent().path] +
                (environment["PATH"] ?? "").split(separator: ":").map(String.init) +
                ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
            var seenPaths = Set<String>()
            environment["PATH"] = pathComponents.filter { seenPaths.insert($0).inserted }.joined(separator: ":")
            process.environment = environment
            process.standardOutput = serviceLog
            process.standardError = serviceLog
            process.standardInput = FileHandle.nullDevice
            process.terminationHandler = { [weak self] ended in
                DispatchQueue.main.async {
                    guard let self = self, self.service === ended else { return }
                    self.readinessTimer?.invalidate()
                    self.readinessTimer = nil
                    if !self.stopping && !self.terminating {
                        self.service = nil
                        self.serviceURL = nil
                        self.closeLog()
                        self.showStatus("本地服务已停止", "服务退出（状态 \(ended.terminationStatus)）。可重新启动，或查看日志了解原因。", retry: true)
                    }
                }
            }
            service = process
            try process.run()
            let deadline = Date().addingTimeInterval(35)
            readinessTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                guard let self = self, self.launchGeneration == generation, !self.stopping else { return }
                if let data = try? Data(contentsOf: self.readyURL),
                   let ready = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let pid = ready["pid"] as? Int32, pid == process.processIdentifier,
                   let value = ready["url"] as? String, let url = URL(string: value),
                   url.scheme == "http", url.host == "127.0.0.1", let port = url.port,
                   (1...65535).contains(port), url.user == nil, url.password == nil {
                    self.readinessTimer?.invalidate()
                    self.readinessTimer = nil
                    self.serviceURL = url
                    self.makeWebView(url: url)
                } else if Date() >= deadline {
                    self.stopService {
                        self.showStatus("启动超时", "本地服务未在 35 秒内就绪。请查看服务日志后重试。", retry: true)
                    }
                }
            }
        } catch {
            service = nil
            closeLog()
            showStatus("无法启动 Panel", error.localizedDescription, retry: true)
        }
    }

    private func prepareLog() throws {
        if let attributes = try? files.attributesOfItem(atPath: logURL.path),
           let size = attributes[.size] as? NSNumber, size.intValue > 2_000_000 {
            let previous = supportURL.appendingPathComponent("server.previous.log")
            try? files.removeItem(at: previous)
            try? files.moveItem(at: logURL, to: previous)
        }
        if !files.fileExists(atPath: logURL.path) {
            files.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        serviceLog = try FileHandle(forWritingTo: logURL)
        try serviceLog?.seekToEnd()
        try serviceLog?.write(contentsOf: Data("\n[Panel \(Date())] Starting local service\n".utf8))
    }

    private func closeLog() {
        try? serviceLog?.close()
        serviceLog = nil
    }

    private func stopService(completion: @escaping () -> Void) {
        readinessTimer?.invalidate()
        readinessTimer = nil
        launchGeneration = UUID()
        serviceURL = nil
        guard let process = service else { completion(); return }
        // Quitting while a restart is stopping the service supersedes its
        // restart callback, without starting a second waiter for the process.
        stopCompletion = completion
        guard !stopping else { return }
        stopping = true
        let generation = UUID()
        stopGeneration = generation
        if process.isRunning { process.terminate() }
        let forceStop = DispatchWorkItem {
            if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
        }
        forceStopWork = forceStop
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 8, execute: forceStop)
        // AppKit's terminateLater loop does not service default-mode timers.
        // Reap the child off the main thread, then finish on the main queue.
        DispatchQueue.global(qos: .utility).async { [weak self] in
            process.waitUntilExit()
            forceStop.cancel()
            DispatchQueue.main.async {
                guard let self = self, self.service === process,
                      self.stopGeneration == generation else { return }
                self.forceStopWork = nil
                self.stopGeneration = nil
                self.service = nil
                self.stopping = false
                self.closeLog()
                try? self.files.removeItem(at: self.readyURL)
                let finished = self.stopCompletion
                self.stopCompletion = nil
                finished?()
            }
        }
    }

    private func makeWebView(url: URL) {
        destroyWebView()
        let configuration = WKWebViewConfiguration()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "panel")
        let origin = "http://127.0.0.1:\(url.port!)"
        let source = """
        if (window === window.top && location.origin === '\(origin)') {
          Object.defineProperty(window, 'panelDesktop', { value: Object.freeze({
            platform: 'macos',
            chooseDirectory: () => window.webkit.messageHandlers.panel.postMessage({action:'choose-directory'}),
            openSettings: () => window.webkit.messageHandlers.panel.postMessage({action:'open-settings'}),
            openDataDirectory: () => window.webkit.messageHandlers.panel.postMessage({action:'open-data-directory'})
          }), writable: false, configurable: false });
        }
        """
        configuration.userContentController.addUserScript(WKUserScript(source: source,
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: container.bounds, configuration: configuration)
        view.autoresizingMask = [.width, .height]
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = false
        container.addSubview(view, positioned: .below, relativeTo: statusView)
        webView = view
        view.load(URLRequest(url: url))
    }

    private func destroyWebView() {
        directoryPicker?.cancel(nil)
        directoryPicker = nil
        for download in downloads.values { download.cancel { _ in } }
        for target in downloadDestinations.values { try? files.removeItem(at: target.temporary) }
        downloads.removeAll()
        downloadDestinations.removeAll()
        cancelledDownloads.removeAll()
        webView?.stopLoading()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "panel", contentWorld: .page)
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        webView?.removeFromSuperview()
        webView = nil
    }

    private func sameOrigin(_ url: URL?) -> Bool {
        guard let url = url, let expected = serviceURL else { return false }
        return url.scheme == expected.scheme && url.host == expected.host && url.port == expected.port &&
            url.user == nil && url.password == nil
    }

    func userContentController(_ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.webView === webView, message.frameInfo.isMainFrame,
              let expected = serviceURL, sameOrigin(webView?.url),
              origin.protocol == expected.scheme, origin.host == expected.host, origin.port == expected.port,
              let body = message.body as? [String: Any], let action = body["action"] as? String else {
            replyHandler(nil, "仅允许 Panel 本机主页面调用原生功能。")
            return
        }
        switch action {
        case "choose-directory":
            guard directoryPicker == nil else { replyHandler(nil, "已有文件夹选择窗口打开。"); return }
            let panel = NSOpenPanel()
            panel.title = "选择工作目录"
            panel.prompt = "选择目录"
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.canCreateDirectories = true
            panel.allowsMultipleSelection = false
            directoryPicker = panel
            panel.beginSheetModal(for: window) { [weak self] response in
                self?.directoryPicker = nil
                replyHandler(response == .OK ? panel.url?.path : nil, nil)
            }
        case "open-settings":
            openSettings()
            replyHandler(nil, nil)
        case "open-data-directory":
            openDataDirectory()
            replyHandler(nil, nil)
        default:
            replyHandler(nil, "不支持的原生操作。")
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if sameOrigin(url) {
            if navigationAction.shouldPerformDownload { decisionHandler(.download) }
            else if navigationAction.targetFrame == nil {
                decisionHandler(.cancel)
                if let url = url { webView.load(URLRequest(url: url)) }
            } else { decisionHandler(.allow) }
            return
        }
        if navigationAction.navigationType == .linkActivated,
           let url = url, ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard sameOrigin(navigationResponse.response.url) else { decisionHandler(.cancel); return }
        let response = navigationResponse.response as? HTTPURLResponse
        let disposition = response?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        decisionHandler(disposition.lowercased().contains("attachment") || !navigationResponse.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard sameOrigin(webView.url) else { return }
        statusView?.removeFromSuperview()
        statusView = nil
        window.makeFirstResponder(webView)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }

    private func navigationFailed(_ error: Error) {
        let failure = error as NSError
        guard !stopping, !terminating, failure.code != NSURLErrorCancelled,
              !(failure.domain == "WebKitErrorDomain" && failure.code == 102) else { return }
        showStatus("页面未能加载", error.localizedDescription, retry: true)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showStatus("页面进程已停止", "你的探索已保存在本机，点击重试重新打开工作台。", retry: true)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard frame.isMainFrame, sameOrigin(frame.request.url) else { completionHandler(); return }
        showAlert("Panel", message)
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard frame.isMainFrame, sameOrigin(frame.request.url) else { completionHandler(false); return }
        completionHandler(confirm("Panel", message, button: "确定"))
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        trackDownload(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        trackDownload(download)
    }

    private func trackDownload(_ download: WKDownload) {
        downloads[ObjectIdentifier(download)] = download
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard sameOrigin(response.url) else { completionHandler(nil); return }
        let panel = NSSavePanel()
        panel.title = "导出探索"
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self = self, result == .OK, let destination = panel.url else {
                self?.cancelledDownloads.insert(ObjectIdentifier(download))
                completionHandler(nil)
                return
            }
            // WebKit requires a nonexistent destination. Write beside the chosen
            // file, then replace only after success, preserving an existing export
            // if this transfer is cancelled or fails.
            let temporary = destination.deletingLastPathComponent()
                .appendingPathComponent(".panel-export-\(UUID().uuidString).tmp")
            self.downloadDestinations[ObjectIdentifier(download)] = (temporary, destination)
            completionHandler(temporary)
        }
    }

    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(sameOrigin(request.url) ? .allow : .cancel)
    }

    func downloadDidFinish(_ download: WKDownload) {
        let id = ObjectIdentifier(download)
        downloads.removeValue(forKey: id)
        cancelledDownloads.remove(id)
        guard let target = downloadDestinations.removeValue(forKey: id) else { return }
        do {
            if files.fileExists(atPath: target.destination.path) {
                _ = try files.replaceItemAt(target.destination, withItemAt: target.temporary)
            } else {
                try files.moveItem(at: target.temporary, to: target.destination)
            }
        } catch {
            try? files.removeItem(at: target.temporary)
            showAlert("无法保存导出文件", error.localizedDescription)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let id = ObjectIdentifier(download)
        downloads.removeValue(forKey: id)
        if let target = downloadDestinations.removeValue(forKey: id) { try? files.removeItem(at: target.temporary) }
        let cancelled = cancelledDownloads.remove(id) != nil
        guard !cancelled, !stopping, !terminating, (error as NSError).code != NSURLErrorCancelled else { return }
        showAlert("导出失败", error.localizedDescription)
    }

    private func showStatus(_ title: String, _ detail: String, retry: Bool) {
        guard container != nil else { return }
        statusView?.removeFromSuperview()
        let background = NSVisualEffectView(frame: container.bounds)
        background.material = .windowBackground
        background.blendingMode = .withinWindow
        background.autoresizingMask = [.width, .height]
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        let icon = NSImageView(image: NSImage(systemSymbolName: "square.stack.3d.up", accessibilityDescription: "Panel")!)
        icon.contentTintColor = .secondaryLabelColor
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 48, weight: .light)
        let heading = NSTextField(labelWithString: title)
        heading.font = .systemFont(ofSize: 25, weight: .semibold)
        let description = NSTextField(wrappingLabelWithString: detail)
        description.font = .systemFont(ofSize: 14)
        description.textColor = .secondaryLabelColor
        description.alignment = .center
        stack.addArrangedSubview(icon)
        stack.addArrangedSubview(heading)
        stack.addArrangedSubview(description)
        if retry {
            let button = NSButton(title: "重试", target: self, action: #selector(retryService))
            button.bezelStyle = .rounded
            button.keyEquivalent = "\r"
            stack.addArrangedSubview(button)
            let logs = NSButton(title: "查看服务日志", target: self, action: #selector(openLogs))
            logs.bezelStyle = .rounded
            stack.addArrangedSubview(logs)
        } else {
            let progress = NSProgressIndicator()
            progress.style = .spinning
            progress.controlSize = .small
            progress.startAnimation(nil)
            stack.addArrangedSubview(progress)
        }
        background.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: background.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: background.centerYAnchor),
            stack.widthAnchor.constraint(equalToConstant: 480),
            description.widthAnchor.constraint(lessThanOrEqualToConstant: 480)
        ])
        container.addSubview(background)
        statusView = background
    }

    private func activeNodeCount(completion: @escaping (Int?) -> Void) {
        guard let base = serviceURL, service?.isRunning == true else { completion(0); return }
        var request = URLRequest(url: base.appendingPathComponent("api/state"))
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let state = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let workspaces = state?["workspaces"] as? [[String: Any]]
            let count = (response as? HTTPURLResponse)?.statusCode == 200 ? workspaces.map { items in
                items.flatMap { $0["nodes"] as? [[String: Any]] ?? [] }.filter {
                    ["running", "queued"].contains($0["status"] as? String ?? "")
                }.count
            } : nil
            DispatchQueue.main.async { completion(count) }
        }.resume()
    }

    @objc private func retryService() {
        guard !stopping, !terminating else { return }
        if let url = serviceURL, service?.isRunning == true {
            showStatus("正在打开 Panel", "正在连接本地工作台…", retry: false)
            makeWebView(url: url)
        } else { startService() }
    }

    @objc private func restartService() {
        guard !stopping, !terminating, !checkingRestart else { return }
        checkingRestart = true
        activeNodeCount { [weak self] count in
            guard let self = self else { return }
            self.checkingRestart = false
            guard !self.terminating else { return }
            if count == nil || count! > 0 {
                let message = count.map { "当前有 \($0) 个节点正在运行或排队。重启会中断这些任务，已经发生的文件修改会保留。" }
                    ?? "暂时无法读取任务状态。重启可能中断正在运行的任务，已经发生的文件修改会保留。"
                guard self.confirm("重启本地服务？", message, button: "重启服务") else { return }
            }
            self.destroyWebView()
            self.showStatus("正在重启 Panel", "正在保存探索并停止本地服务…", retry: false)
            self.stopService { self.startService() }
        }
    }

    @objc private func openSettings() {
        do {
            try prepareSettings()
            let editor = URL(fileURLWithPath: "/System/Applications/TextEdit.app")
            NSWorkspace.shared.open([settingsURL], withApplicationAt: editor,
                                    configuration: NSWorkspace.OpenConfiguration()) { _, error in
                if let error = error { DispatchQueue.main.async { self.showAlert("无法打开模型配置", error.localizedDescription) } }
            }
        } catch { showAlert("无法打开模型配置", error.localizedDescription) }
    }

    @objc private func openDataDirectory() { NSWorkspace.shared.open(dataURL) }
    @objc private func openLogs() { NSWorkspace.shared.activateFileViewerSelecting([logURL]) }
    @objc private func newWorkspace() { sendNativeAction("new-workspace") }
    @objc private func search() { sendNativeAction("search") }
    @objc private func reload() { webView?.reload() }
    @objc private func resetZoom() { webView?.pageZoom = 1 }
    @objc private func zoomIn() { if let view = webView { view.pageZoom = min(1.8, view.pageZoom + 0.1) } }
    @objc private func zoomOut() { if let view = webView { view.pageZoom = max(0.7, view.pageZoom - 0.1) } }
    @objc private func about() {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "Panel", .applicationVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0",
            .credits: NSAttributedString(string: "本地优先的非线性 Agent 工作台\n探索每一种可能。")
        ])
    }
    @objc private func helpPanel() {
        showAlert("开始使用 Panel", "⌘N 新建探索，⌘K 搜索，⌘W 关闭窗口。关闭窗口后任务会继续，点击 Dock 图标可再次打开。\n\n在「Panel → 模型配置」中填写模型密钥，保存后选择「Panel → 重启本地服务」。\n\n探索保存在本机 Application Support/Panel/data。编码操作沿用工作台内的审批规则。")
    }

    private func sendNativeAction(_ action: String) {
        guard let view = webView, sameOrigin(view.url) else { return }
        window.makeKeyAndOrderFront(nil)
        view.evaluateJavaScript("window.dispatchEvent(new CustomEvent('panel:native-action', {detail:{action:'\(action)'}}))", completionHandler: nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window?.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminating { return .terminateLater }
        guard service?.isRunning == true else { return .terminateNow }
        terminating = true
        activeNodeCount { [weak self] count in
            guard let self = self else { sender.reply(toApplicationShouldTerminate: true); return }
            if count == nil || count! > 0 {
                let message = count.map { "当前有 \($0) 个节点正在运行或排队。退出会中断这些任务；探索会保存，已经发生的文件修改会保留。" }
                    ?? "暂时无法读取任务状态。退出可能中断正在运行的任务；探索会保存，已经发生的文件修改会保留。"
                if !self.confirm("退出 Panel？", message, button: "退出 Panel") {
                    self.terminating = false
                    sender.reply(toApplicationShouldTerminate: false)
                    return
                }
            }
            self.destroyWebView()
            self.showStatus("正在退出 Panel", "正在保存探索并停止本地服务…", retry: false)
            self.stopService { sender.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        readinessTimer?.invalidate()
        forceStopWork?.cancel()
        if let process = service, process.isRunning { process.terminate() }
        closeLog()
        if lockDescriptor >= 0 {
            flock(lockDescriptor, LOCK_UN)
            Darwin.close(lockDescriptor)
            lockDescriptor = -1
        }
    }

    private func showAlert(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.runModal()
    }

    private func confirm(_ title: String, _ message: String, button: String) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "取消")
        alert.addButton(withTitle: button)
        return alert.runModal() == .alertSecondButtonReturn
    }

    private func showFatalError(_ title: String, _ detail: String) {
        showAlert(title, detail)
        NSApp.terminate(nil)
    }
}

let application = NSApplication.shared
let delegate = PanelApp()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
