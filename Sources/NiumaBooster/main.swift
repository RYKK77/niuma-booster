import AppKit
import NiumaCore

// 调试入口：
//   NiumaBooster --dump "2026-11-17 15:18:42"   打印该时刻的菜单栏文字和计算结果（用默认设置）
//   NiumaBooster --render <目录>                 把面板和设置页离屏渲染成 PNG
let args = CommandLine.arguments
if let i = args.firstIndex(of: "--dump") {
    Debug.dump(at: i + 1 < args.count ? args[i + 1] : nil)
    exit(0)
}
if let i = args.firstIndex(of: "--render"), i + 1 < args.count {
    Debug.render(to: args[i + 1])
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
