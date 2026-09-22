import AppKit
import WebKit

final class Printer: NSObject, WKNavigationDelegate {
    let web: WKWebView
    let output: URL
    let window: NSWindow
    var operation: NSPrintOperation?
    init(input: URL, output: URL) {
        self.output = output
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        self.web = WKWebView(frame: NSRect(x: 0, y: 0, width: 510.24, height: 740), configuration: config)
        self.window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        super.init()
        window.contentView = web
        web.navigationDelegate = self
        do { web.loadHTMLString(try String(contentsOf: input, encoding: .utf8), baseURL: nil) }
        catch { fail("Cannot read print input") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { self.fail("PDF rendering timed out") }
    }
    func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data(message.utf8))
        exit(1)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail("PDF navigation failed") }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { checkImages() }
    func checkImages() {
        web.evaluateJavaScript("Array.from(document.images).every(i => i.complete) ? (Array.from(document.images).every(i => i.naturalWidth > 0) ? 1 : -1) : 0") { result, error in
            guard error == nil, let state = result as? Int else { self.fail("Cannot verify PDF images") }
            if state < 0 { self.fail("PDF image failed to decode") }
            if state == 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.checkImages() }; return }
            let info = NSPrintInfo()
            info.paperSize = NSSize(width: 595.28, height: 841.89)
            info.topMargin = 45.35; info.bottomMargin = 51.02
            info.leftMargin = 42.52; info.rightMargin = 42.52
            info.isHorizontallyCentered = false; info.isVerticallyCentered = false
            info.horizontalPagination = .fit; info.verticalPagination = .automatic
            info.jobDisposition = .save
            info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = self.output
            let operation = self.web.printOperation(with: info)
            self.operation = operation
            operation.showsPrintPanel = false; operation.showsProgressPanel = false
            operation.runModal(for: self.window, delegate: self, didRun: #selector(self.printFinished(_:success:context:)), contextInfo: nil)
        }
    }
    @objc func printFinished(_ operation: NSPrintOperation, success: Bool, context: UnsafeMutableRawPointer?) {
        guard success, FileManager.default.fileExists(atPath: output.path) else { fail("Native PDF printing failed") }
        exit(0)
    }
}

guard CommandLine.arguments.count == 3 else { exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let printer = Printer(input: URL(fileURLWithPath: CommandLine.arguments[1]), output: URL(fileURLWithPath: CommandLine.arguments[2]))
withExtendedLifetime(printer) { app.run() }
