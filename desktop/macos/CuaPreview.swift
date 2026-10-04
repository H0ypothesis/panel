import AppKit
import ScreenCaptureKit
import CoreImage
import CoreMedia

private final class CuaPreviewPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class CuaPreviewImageView: NSImageView {
    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
    }
}

private final class CuaPreviewSurface: NSView {
    var hoverChanged: ((Bool) -> Void)?
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking = tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.inVisibleRect, .mouseEnteredAndExited, .activeAlways, .enabledDuringMouseDrag], owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hoverChanged?(true) }
    override func mouseExited(with event: NSEvent) { hoverChanged?(false) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let hit = super.hitTest(point) else { return nil }
        var ancestor: NSView? = hit
        while let view = ancestor, view !== self {
            if view is NSButton || view is CuaPreviewResizeHandle { return hit }
            ancestor = view.superview
        }
        return self
    }
}

private final class CuaPreviewButton: NSButton {
    init(symbol: String, label: String, size: CGFloat, target: AnyObject?, action: Selector) {
        super.init(frame: .zero)
        image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: size, weight: .semibold))
        imagePosition = .imageOnly
        imageScaling = .scaleProportionallyDown
        isBordered = false
        focusRingType = .none
        contentTintColor = .white
        setButtonType(.momentaryChange)
        self.target = target
        self.action = action
        toolTip = label
        setAccessibilityLabel(label)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.withAlphaComponent(0.36).cgColor
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func layout() { super.layout(); layer?.cornerRadius = bounds.width / 2 }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
}

private final class CuaPreviewResizeHandle: NSView {
    private var initialFrame: NSRect?
    private var initialMouse = NSPoint.zero
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }
    override func mouseDown(with event: NSEvent) {
        initialFrame = window?.frame
        initialMouse = window?.convertPoint(toScreen: event.locationInWindow) ?? .zero
    }
    override func mouseDragged(with event: NSEvent) {
        guard let window = window, let initial = initialFrame else { return }
        let mouse = window.convertPoint(toScreen: event.locationInWindow)
        let dx = mouse.x - initialMouse.x
        let dy = (initialMouse.y - mouse.y) * 1.6
        let delta = abs(dx) >= abs(dy) ? dx : dy
        let visible = window.screen?.visibleFrame ?? initial.insetBy(dx: -1000, dy: -1000)
        let maximum = min(window.maxSize.width, visible.maxX - initial.minX, (initial.maxY - visible.minY) * 1.6)
        let width = max(window.minSize.width, min(maximum, initial.width + delta))
        let height = width / 1.6
        window.setFrame(NSRect(x: initial.minX, y: initial.maxY - height, width: width, height: height), display: true)
    }
    override func mouseUp(with event: NSEvent) { initialFrame = nil }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.withAlphaComponent(0.7).setStroke()
        let lines = NSBezierPath()
        lines.lineWidth = 1.5
        lines.lineCapStyle = .round
        for offset: CGFloat in [0, 5] {
            lines.move(to: NSPoint(x: bounds.maxX - 3 - offset, y: 3))
            lines.line(to: NSPoint(x: bounds.maxX - 3, y: 3 + offset + 5))
        }
        lines.stroke()
    }
}

private final class CuaPreviewOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    let context = CIContext(options: [.cacheIntermediates: false])
    let frame: (CGImage) -> Void
    let failed: (String) -> Void
    private let lock = NSLock()
    private var pending = false
    private var crop: CGRect?

    // Normalized top-left crop in the real transparent overlay window.
    func setCrop(_ value: CGRect) {
        lock.lock(); crop = value; lock.unlock()
    }

    init(frame: @escaping (CGImage) -> Void, failed: @escaping (String) -> Void) {
        self.frame = frame
        self.failed = failed
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .screen, buffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: status) == .complete,
              let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
        // At most one frame waits for AppKit. Never build a backlog of old frames.
        lock.lock()
        if pending { lock.unlock(); return }
        pending = true
        let crop = crop
        lock.unlock()
        var image = CIImage(cvPixelBuffer: pixels)
        if let crop = crop {
            let width = image.extent.width, height = image.extent.height
            let area = CGRect(x: crop.minX * width, y: (1 - crop.maxY) * height,
                              width: crop.width * width, height: crop.height * height)
            let canvas = CGRect(origin: .zero, size: area.size)
            image = image.transformed(by: CGAffineTransform(translationX: -area.minX, y: -area.minY))
                .composited(over: CIImage(color: .clear).cropped(to: canvas)).cropped(to: canvas)
        }
        guard let cgImage = context.createCGImage(image, from: image.extent) else {
            lock.lock(); pending = false; lock.unlock()
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.frame(cgImage)
            self.lock.lock(); self.pending = false; self.lock.unlock()
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { [weak self] in self?.failed(error.localizedDescription) }
    }
}

/** The native panel accepts only task IDs. Capture targets come from the live server lease. */
@MainActor
final class CuaPreviewController: NSObject, NSWindowDelegate, URLSessionDataDelegate {
    private let panel: CuaPreviewPanel
    private let image = CuaPreviewImageView()
    private let overlayImage = CuaPreviewImageView()
    // SCStreamConfiguration.backgroundColor is assign, not retained by its setter.
    private let overlayBackground = CGColor(gray: 0, alpha: 0)
    private var overlayOwner: (pid: Int32, bundlePath: String)?
    private var overlayViewport: CGSize?
    private var overlayVisible = false
    private var overlayProofAt = Date.distantPast
    private var overlayStream: SCStream?
    private var overlayOutput: CuaPreviewOutput?
    private var overlayWindowID: UInt32?
    private var overlayEpoch = UUID()
    private var overlayTimer: Timer?
    private var overlayTask: Task<Void, Never>?
    private let placeholder = NSTextField(wrappingLabelWithString: "等待模型观察操作目标…")
    private var targetLabel = "电脑操作预览"
    private let action = NSTextField(labelWithString: "正在连接画面…")
    private let controls = NSView()
    private let resizeHandle = CuaPreviewResizeHandle()
    private var closeButton: NSButton?
    private var enterButton: NSButton?
    private var canEnter = false
    private var enterRequest: URLSessionDataTask?
    private var enterEpoch = UUID()
    private var hovering = false
    private let permission = NSButton(title: "授权屏幕录制", target: nil, action: nil)
    private let onClosed: () -> Void
    private var serviceURL: URL
    private var eventURL: URL?
    private var cancelURL: URL?
    private var enterURL: URL?
    private var revision = 0
    private var session: URLSession?
    private var request: URLSessionDataTask?
    private var buffer = Data()
    private var scopeID: String?
    private var source: String?
    private var target: (pid: Int32, windowID: UInt32)?
    private var capture: SCStream?
    private var output: CuaPreviewOutput?
    private var captureTask: Task<Void, Never>?
    private var epoch = UUID()
    private var suppressClose = false
    private var lastFrame = Date.distantPast
    private var freshness: Timer?

    init(serviceURL: URL, parent: NSWindow, onClosed: @escaping () -> Void) {
        self.serviceURL = serviceURL
        self.onClosed = onClosed
        let visible = (parent.screen ?? NSScreen.main)?.visibleFrame ?? parent.frame
        panel = CuaPreviewPanel(contentRect: NSRect(x: visible.maxX - 304, y: visible.minY + 24, width: 280, height: 175),
            styleMask: [.borderless, .resizable, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.title = "Panel · 电脑操作预览"
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.minSize = NSSize(width: 200, height: 125)
        panel.maxSize = NSSize(width: 560, height: 350)
        panel.contentAspectRatio = NSSize(width: 8, height: 5)
        panel.delegate = self
        panel.setFrameAutosaveName("PanelComputerUsePreviewCompact")
        makeContent()
    }

    private func makeContent() {
        let content = CuaPreviewSurface(frame: NSRect(origin: .zero, size: panel.frame.size))
        panel.contentView = content
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor(calibratedRed: 0.055, green: 0.075, blue: 0.065, alpha: 1).cgColor
        content.layer?.cornerRadius = 12
        content.layer?.masksToBounds = true
        image.imageScaling = .scaleProportionallyUpOrDown
        image.imageAlignment = .alignCenter
        placeholder.textColor = .lightGray
        placeholder.font = .systemFont(ofSize: 11)
        placeholder.alignment = .center
        placeholder.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        action.font = .systemFont(ofSize: 10)
        action.textColor = .white
        action.alignment = .center
        action.wantsLayer = true
        action.layer?.shadowColor = NSColor.black.cgColor
        action.layer?.shadowOpacity = 0.8
        action.layer?.shadowRadius = 3
        action.lineBreakMode = .byTruncatingTail
        action.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let stop = CuaPreviewButton(symbol: "stop.fill", label: "中止任务", size: 12, target: self, action: #selector(stopTask))
        let retry = CuaPreviewButton(symbol: "arrow.clockwise", label: "刷新画面", size: 15, target: self, action: #selector(reconnect))
        let enter = CuaPreviewButton(symbol: "rectangle.on.rectangle", label: "进入被控制的应用", size: 20, target: self, action: #selector(enterApp))
        enterButton = enter
        let close = CuaPreviewButton(symbol: "xmark", label: "关闭画中画", size: 11, target: self, action: #selector(closePreview))
        closeButton = close
        controls.wantsLayer = true
        controls.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.12).cgColor
        permission.target = self
        permission.action = #selector(grantScreenCapture)
        permission.bezelStyle = .rounded
        permission.isHidden = true
        overlayImage.imageScaling = .scaleProportionallyUpOrDown
        overlayImage.imageAlignment = .alignCenter
        overlayImage.setAccessibilityElement(false)
        for view in [image, overlayImage, placeholder, permission, controls, resizeHandle, close] {
            view.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(view)
        }
        for view in [action, stop, retry, enter] {
            view.translatesAutoresizingMaskIntoConstraints = false
            controls.addSubview(view)
        }
        controls.isHidden = true
        close.isHidden = true
        resizeHandle.isHidden = true
        content.hoverChanged = { [weak self] hovering in
            guard let self = self else { return }
            self.hovering = hovering
            self.updateControls()
        }
        NSLayoutConstraint.activate([
            overlayImage.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            overlayImage.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            overlayImage.topAnchor.constraint(equalTo: content.topAnchor),
            overlayImage.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            image.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            image.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            image.topAnchor.constraint(equalTo: content.topAnchor),
            image.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            placeholder.centerYAnchor.constraint(equalTo: content.centerYAnchor, constant: -14),
            placeholder.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            placeholder.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            permission.topAnchor.constraint(equalTo: placeholder.bottomAnchor, constant: 12),
            permission.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            controls.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            controls.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            controls.topAnchor.constraint(equalTo: content.topAnchor),
            controls.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            enter.centerXAnchor.constraint(equalTo: controls.centerXAnchor),
            enter.centerYAnchor.constraint(equalTo: controls.centerYAnchor),
            enter.widthAnchor.constraint(equalToConstant: 44),
            enter.heightAnchor.constraint(equalToConstant: 44),
            retry.trailingAnchor.constraint(equalTo: enter.leadingAnchor, constant: -18),
            retry.centerYAnchor.constraint(equalTo: enter.centerYAnchor),
            retry.widthAnchor.constraint(equalToConstant: 30),
            retry.heightAnchor.constraint(equalToConstant: 30),
            stop.leadingAnchor.constraint(equalTo: enter.trailingAnchor, constant: 18),
            stop.centerYAnchor.constraint(equalTo: enter.centerYAnchor),
            stop.widthAnchor.constraint(equalToConstant: 30),
            stop.heightAnchor.constraint(equalToConstant: 30),
            action.leadingAnchor.constraint(equalTo: controls.leadingAnchor, constant: 24),
            action.trailingAnchor.constraint(equalTo: controls.trailingAnchor, constant: -24),
            action.bottomAnchor.constraint(equalTo: controls.bottomAnchor, constant: -10),
            close.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 8),
            close.topAnchor.constraint(equalTo: content.topAnchor, constant: 8),
            close.widthAnchor.constraint(equalToConstant: 24),
            close.heightAnchor.constraint(equalToConstant: 24),
            resizeHandle.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -5),
            resizeHandle.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -5),
            resizeHandle.widthAnchor.constraint(equalToConstant: 18),
            resizeHandle.heightAnchor.constraint(equalToConstant: 18)
        ])
    }

    private func updateControls() {
        enterButton?.isEnabled = canEnter && scopeID != nil && enterRequest == nil
        controls.isHidden = !hovering || !permission.isHidden
        closeButton?.isHidden = !hovering
        resizeHandle.isHidden = !hovering
        placeholder.alphaValue = controls.isHidden ? 1 : 0
    }

    func show(workspaceID: String, nodeID: String, revision: Int) {
        self.revision = revision
        var url = serviceURL
        for part in ["api", "workspaces", workspaceID, "nodes", nodeID] { url.appendPathComponent(part) }
        cancelURL = url.appendingPathComponent("cancel")
        url.appendPathComponent("computer-use/preview")
        enterURL = url.appendingPathComponent("enter")
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "revision", value: String(revision)), URLQueryItem(name: "native", value: "1")]
        if eventURL != components.url {
            eventURL = components.url
            reconnect()
        }
        // orderFront does not activate Panel or take keyboard focus.
        panel.orderFront(nil)
    }

    func close(notify: Bool = false) {
        cancelEnter()
        request?.cancel(); request = nil
        session?.invalidateAndCancel(); session = nil
        freshness?.invalidate(); freshness = nil
        stopCapture()
        buffer.removeAll()
        scopeID = nil; source = nil; target = nil
        eventURL = nil; cancelURL = nil; enterURL = nil
        image.image = nil
        hovering = false
        updateControls()
        suppressClose = true
        panel.close()
        suppressClose = false
        if notify { onClosed() }
    }

    func windowWillClose(_ notification: Notification) {
        if !suppressClose { close(notify: true) }
    }

    @objc private func reconnect() {
        guard let url = eventURL else { return }
        cancelEnter()
        request?.cancel(); request = nil
        session?.invalidateAndCancel()
        stopCapture()
        scopeID = nil; source = nil; target = nil
        image.image = nil
        placeholder.isHidden = false
        placeholder.stringValue = "正在连接操作画面…"
        permission.isHidden = true
        updateControls()
        buffer.removeAll()
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: queue)
        var message = URLRequest(url: url)
        message.timeoutInterval = 86400
        message.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request = session?.dataTask(with: message)
        request?.resume()
        freshness?.invalidate()
        freshness = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                if self.image.image != nil && Date().timeIntervalSince(self.lastFrame) > 3 {
                    self.action.stringValue = "画面暂未更新 · \(self.action.stringValue.replacingOccurrences(of: "画面暂未更新 · ", with: ""))"
                }
            }
        }
    }

    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                               didReceive response: URLResponse,
                               completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let ok = (response as? HTTPURLResponse)?.statusCode == 200 && response.mimeType == "text/event-stream"
        completionHandler(ok ? .allow : .cancel)
        if !ok { DispatchQueue.main.async { [weak self] in
            guard let self = self, self.request === dataTask else { return }
            self.unavailable("当前任务无法打开预览，请重新选择正在运行的电脑控制卡片。")
        } }
    }

    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.request === dataTask else { return }
            self.consume(data)
        }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.request === task else { return }
            self.unavailable("预览连接已中断，点击重新连接。")
        }
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        if buffer.count > 3 * 1024 * 1024 {
            request?.cancel(); unavailable("画面数据过大，预览已停止。")
            buffer.removeAll(); return
        }
        while let boundary = buffer.range(of: Data([10, 10])) {
            let event = buffer.subdata(in: buffer.startIndex..<boundary.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<boundary.upperBound)
            guard let line = String(data: event, encoding: .utf8)?.split(separator: "\n").first(where: { $0.hasPrefix("data: ") }),
                  let bytes = String(line.dropFirst(6)).data(using: .utf8),
                  let body = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { continue }
            if body["type"] as? String == "state" { update(body) }
            else if body["type"] as? String == "overlay", body["scopeId"] as? String == scopeID,
                    source == "cdp", let timestamp = body["timestamp"] as? Double,
                    abs(Date().timeIntervalSince1970 * 1000 - timestamp) < 900 {
                overlayVisible = body["visible"] as? Bool == true
                overlayProofAt = Date(timeIntervalSince1970: timestamp / 1000)
                if let viewport = body["viewport"] as? [String: Any],
                   let width = viewport["width"] as? Double, let height = viewport["height"] as? Double,
                   width.isFinite, height.isFinite, width > 0, height > 0 {
                    overlayViewport = CGSize(width: width, height: height)
                } else { overlayViewport = nil }
                refreshOverlay()
            }
            else if body["type"] as? String == "frame", body["scopeId"] as? String == scopeID,
                    source == "cdp", let base64 = body["data"] as? String, base64.utf8.count <= 2 * 1024 * 1024,
                    ["image/jpeg", "image/png"].contains(body["mimeType"] as? String ?? ""),
                    let data = Data(base64Encoded: base64), let frame = NSImage(data: data) {
                display(frame)
            }
        }
    }

    private func update(_ body: [String: Any]) {
        guard let status = body["status"] as? String else { return }
        if status == "ended" { close(); return }
        targetLabel = body["label"] as? String ?? "电脑操作预览"
        image.setAccessibilityLabel(targetLabel)
        action.stringValue = body["action"] as? String ?? "正在连接画面…"
        if status == "unavailable" { unavailable(body["error"] as? String ?? "画面源暂时不可用。"); return }
        guard status == "live", let scope = body["scope"] as? [String: Any], let id = scope["id"] as? String,
              let captureSource = body["source"] as? String else {
            cancelEnter()
            stopCapture(); scopeID = nil; source = nil; target = nil
            permission.isHidden = true
            image.image = nil; placeholder.isHidden = false
            placeholder.stringValue = targetLabel
            updateControls()
            return
        }
        if scopeID == id && source == captureSource {
            canEnter = true
            updateControls()
            return
        }
        cancelEnter()
        stopCapture()
        image.image = nil; placeholder.isHidden = false
        placeholder.stringValue = "正在连接操作画面…"
        permission.isHidden = true
        scopeID = id; source = captureSource; target = nil
        overlayOwner = nil
        if let owner = body["nativeOverlay"] as? [String: Any],
           let pid = owner["pid"] as? Int, pid > 1, pid <= Int32.max,
           let path = owner["bundlePath"] as? String, path.hasPrefix("/") {
            overlayOwner = (Int32(pid), path)
        }
        canEnter = true
        updateControls()
        if let value = scope["target"] as? [String: Any],
           let pid = value["pid"] as? Int, pid > 0, pid <= Int32.max,
           let windowID = value["windowId"] as? Int, windowID > 0, windowID <= UInt32.max {
            target = (Int32(pid), UInt32(windowID))
            if captureSource == "native" { startCapture() }
            startOverlay()
        }
    }

    private var mayShowOverlay: Bool {
        image.image != nil && (source == "native" ||
            (source == "cdp" && overlayVisible && overlayViewport != nil && Date().timeIntervalSince(overlayProofAt) < 0.9))
    }

    private func startOverlay() {
        guard overlayOwner != nil else { return }
        overlayTimer?.invalidate()
        overlayTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.refreshOverlay() }
        }
        refreshOverlay()
    }

    private func clearOverlayStream() {
        overlayImage.image = nil
        overlayEpoch = UUID()
        let old = overlayStream
        overlayStream = nil; overlayOutput = nil; overlayWindowID = nil
        if let old = old { Task { try? await old.stopCapture() } }
    }

    private func stopOverlay() {
        overlayTimer?.invalidate(); overlayTimer = nil
        overlayTask?.cancel(); overlayTask = nil
        clearOverlayStream()
        overlayOwner = nil; overlayViewport = nil; overlayVisible = false
        overlayProofAt = .distantPast
    }

    private func refreshOverlay() {
        guard let owner = overlayOwner, let target = target, mayShowOverlay else {
            if overlayStream != nil { clearOverlayStream() }
            return
        }
        guard overlayTask == nil else { return }
        guard CGPreflightScreenCaptureAccess() else {
            permission.isHidden = false; updateControls(); return
        }
        let generation = epoch
        overlayTask = Task { [weak self] in
            guard let self = self else { return }
            defer { if self.epoch == generation { self.overlayTask = nil } }
            do {
                // Verify the server-owned daemon identity. Never select another
                // application's lookalike window or an arbitrary screen region.
                guard let app = NSRunningApplication(processIdentifier: owner.pid),
                      app.bundleIdentifier == "com.trycua.driver",
                      app.bundleURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: owner.bundlePath).resolvingSymlinksInPath().path else {
                    self.clearOverlayStream(); return
                }
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                guard !Task.isCancelled, self.epoch == generation, self.mayShowOverlay else { return }
                guard let window = content.windows.first(where: { $0.windowID == target.windowID && $0.owningApplication?.processID == target.pid }) else {
                    self.clearOverlayStream(); return
                }
                let candidates = content.windows.filter { candidate in
                    candidate.owningApplication?.processID == owner.pid && candidate.windowLayer == 0 &&
                    content.displays.contains { display in
                        abs(candidate.frame.minX - display.frame.minX) < 1 &&
                        abs(candidate.frame.minY - display.frame.minY) < 1 &&
                        abs(candidate.frame.width - display.frame.width) < 1 &&
                        abs(candidate.frame.height - display.frame.height) < 1
                    }
                }
                // 0.30.4's overlay covers one display. Capture status/popup windows
                // owned by that process must not be confused with its pixel layer.
                guard candidates.count == 1, let overlay = candidates.first else {
                    self.clearOverlayStream(); return
                }
                var area = window.frame
                if self.source == "cdp" {
                    guard let viewport = self.overlayViewport,
                          area.width - viewport.width >= -2, area.height - viewport.height >= -1 else {
                        self.clearOverlayStream(); return
                    }
                    // Same DIP mapping as Cua Driver's viewport_point_to_screen.
                    area = CGRect(x: area.minX + max(0, (area.width - viewport.width) / 2),
                                  y: area.minY + max(0, area.height - viewport.height),
                                  width: viewport.width, height: viewport.height)
                }
                guard area.intersects(overlay.frame) else { self.clearOverlayStream(); return }
                let crop = CGRect(x: (area.minX - overlay.frame.minX) / overlay.frame.width,
                                  y: (area.minY - overlay.frame.minY) / overlay.frame.height,
                                  width: area.width / overlay.frame.width, height: area.height / overlay.frame.height)
                if self.overlayWindowID == overlay.windowID, let output = self.overlayOutput {
                    output.setCrop(crop); return
                }
                self.clearOverlayStream()
                let overlayGeneration = self.overlayEpoch
                let config = SCStreamConfiguration()
                config.width = max(1, Int(overlay.frame.width))
                config.height = max(1, Int(overlay.frame.height))
                config.pixelFormat = kCVPixelFormatType_32BGRA
                config.backgroundColor = self.overlayBackground
                config.showsCursor = false
                config.capturesAudio = false
                config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
                config.queueDepth = 3
                if #available(macOS 14.0, *) { config.ignoreShadowsSingleWindow = true }
                let output = CuaPreviewOutput(frame: { [weak self] frame in
                    guard let self = self, self.epoch == generation,
                          self.overlayEpoch == overlayGeneration, self.mayShowOverlay else { return }
                    self.overlayImage.image = NSImage(cgImage: frame, size: .zero)
                }, failed: { [weak self] _ in
                    guard let self = self, self.overlayEpoch == overlayGeneration else { return }
                    self.clearOverlayStream()
                })
                output.setCrop(crop)
                let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: overlay), configuration: config, delegate: output)
                try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "panel.preview.native-overlay", qos: .userInitiated))
                self.overlayStream = stream; self.overlayOutput = output; self.overlayWindowID = overlay.windowID
                try await stream.startCapture()
                if Task.isCancelled || self.epoch != generation || self.overlayEpoch != overlayGeneration { try? await stream.stopCapture() }
            } catch {
                if self.epoch == generation { self.clearOverlayStream() }
            }
        }
    }

    private func startCapture() {
        guard let target = target else { return }
        guard CGPreflightScreenCaptureAccess() else {
            placeholder.stringValue = "实时窗口预览需要允许 Panel 录制屏幕。\n已有的 CUA 操作权限属于 Cua Driver。"
            permission.isHidden = false
            updateControls()
            return
        }
        permission.isHidden = true
        updateControls()
        let generation = epoch
        captureTask = Task { [weak self] in
            guard let self = self else { return }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
                guard self.epoch == generation, !Task.isCancelled else { return }
                guard let window = content.windows.first(where: { $0.windowID == target.windowID && $0.owningApplication?.processID == target.pid }) else {
                    throw NSError(domain: "PanelPreview", code: 1, userInfo: [NSLocalizedDescriptionKey: "目标窗口已关闭或不再属于当前应用。"])
                }
                let config = SCStreamConfiguration()
                let scale = min(2, 1280 / max(1, window.frame.width), 960 / max(1, window.frame.height))
                config.width = max(1, Int(window.frame.width * scale))
                config.height = max(1, Int(window.frame.height * scale))
                config.minimumFrameInterval = CMTime(value: 1, timescale: 15)
                config.queueDepth = 3
                config.showsCursor = false
                config.capturesAudio = false
                let output = CuaPreviewOutput(frame: { [weak self] frame in
                    guard let self = self, self.epoch == generation else { return }
                    self.display(NSImage(cgImage: frame, size: .zero))
                }, failed: { [weak self] message in
                    guard let self = self, self.epoch == generation else { return }
                    self.unavailable(message)
                })
                let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: config, delegate: output)
                try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "panel.preview.frames", qos: .userInitiated))
                self.output = output
                self.capture = stream
                try await stream.startCapture()
                if self.epoch != generation || Task.isCancelled { try? await stream.stopCapture() }
            } catch {
                if self.epoch == generation && !Task.isCancelled { self.unavailable(error.localizedDescription) }
            }
        }
    }

    private func stopCapture() {
        stopOverlay()
        epoch = UUID()
        captureTask?.cancel(); captureTask = nil
        let old = capture
        capture = nil; output = nil
        if let old = old { Task { try? await old.stopCapture() } }
    }

    private func unavailable(_ message: String) {
        cancelEnter()
        stopCapture()
        image.image = nil
        placeholder.isHidden = false
        placeholder.stringValue = message
        permission.isHidden = true
        updateControls()
        action.stringValue = "预览暂不可用 · CUA 任务继续运行"
    }

    private func display(_ frame: NSImage) {
        image.image = frame
        placeholder.isHidden = true
        permission.isHidden = overlayOwner == nil || CGPreflightScreenCaptureAccess()
        updateControls()
        lastFrame = Date()
        action.stringValue = action.stringValue.replacingOccurrences(of: "画面暂未更新 · ", with: "")
    }

    @objc private func grantScreenCapture() {
        if CGRequestScreenCaptureAccess() {
            permission.isHidden = true; updateControls()
            if source == "native" { startCapture() }
            startOverlay()
        }
        else if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func enterApp() {
        guard canEnter, enterRequest == nil, let id = scopeID, let url = enterURL else { return }
        let token = enterEpoch
        let enteringRevision = revision
        var message = URLRequest(url: url)
        message.httpMethod = "POST"
        message.timeoutInterval = 10
        message.setValue("application/json", forHTTPHeaderField: "Content-Type")
        message.httpBody = try? JSONSerialization.data(withJSONObject: ["expectedRevision": enteringRevision, "scopeId": id])
        action.stringValue = "正在进入应用…"
        enterRequest = URLSession.shared.dataTask(with: message) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, self.enterEpoch == token, self.scopeID == id,
                      self.enterURL == url, self.revision == enteringRevision else { return }
                self.enterRequest = nil
                self.updateControls()
                if error != nil || (response as? HTTPURLResponse)?.statusCode != 200 {
                    let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                    self.action.stringValue = body?["error"] as? String ?? "进入应用失败，请刷新预览后重试。"
                } else {
                    self.action.stringValue = "已进入被控制的应用"
                }
            }
        }
        updateControls()
        enterRequest?.resume()
    }

    private func cancelEnter() {
        enterEpoch = UUID()
        enterRequest?.cancel(); enterRequest = nil
        canEnter = false
    }

    @objc private func closePreview() { close(notify: true) }

    @objc private func stopTask() {
        guard let url = cancelURL else { return }
        let stoppingRevision = revision
        var message = URLRequest(url: url)
        message.httpMethod = "POST"
        message.setValue("application/json", forHTTPHeaderField: "Content-Type")
        message.httpBody = try? JSONSerialization.data(withJSONObject: ["expectedRevision": revision])
        action.stringValue = "正在停止任务…"
        URLSession.shared.dataTask(with: message) { [weak self] _, response, error in
            if error != nil || (response as? HTTPURLResponse)?.statusCode != 200 {
                DispatchQueue.main.async {
                    guard let self = self, self.cancelURL == url, self.revision == stoppingRevision else { return }
                    self.action.stringValue = "停止失败，请在主窗口重试。"
                }
            }
        }.resume()
    }
}
