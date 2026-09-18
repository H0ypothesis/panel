import AppKit

let destination = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
func render(_ size: Int, _ filename: String) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let transform = NSAffineTransform()
    transform.scale(by: CGFloat(size) / 1024)
    transform.concat()
    NSColor(calibratedRed: 0.10, green: 0.25, blue: 0.22, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 44, y: 44, width: 936, height: 936), xRadius: 208, yRadius: 208).fill()
    NSColor(calibratedRed: 0.89, green: 0.95, blue: 0.86, alpha: 1).setStroke()
    let branches = NSBezierPath()
    branches.lineWidth = 42
    branches.lineCapStyle = .round
    branches.move(to: NSPoint(x: 320, y: 290))
    branches.line(to: NSPoint(x: 320, y: 720))
    branches.move(to: NSPoint(x: 320, y: 390))
    branches.curve(to: NSPoint(x: 704, y: 700), controlPoint1: NSPoint(x: 320, y: 605), controlPoint2: NSPoint(x: 704, y: 480))
    branches.stroke()
    for (x, y) in [(320, 290), (320, 720), (704, 700)] {
        NSColor(calibratedRed: 0.10, green: 0.25, blue: 0.22, alpha: 1).setFill()
        let node = NSBezierPath(ovalIn: NSRect(x: x - 80, y: y - 80, width: 160, height: 160))
        node.fill()
        node.lineWidth = 34
        node.stroke()
    }
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: destination.appendingPathComponent(filename))
}
for size in [16, 32, 128, 256, 512] {
    try render(size, "icon_\(size)x\(size).png")
    try render(size * 2, "icon_\(size)x\(size)@2x.png")
}
