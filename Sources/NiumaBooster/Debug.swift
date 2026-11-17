import AppKit
import SwiftUI
import NiumaCore

/// 命令行调试：打印计算结果、离屏渲染界面。只读本地，不改设置。
enum Debug {
    static func parse(_ s: String?) -> Date {
        guard let s else { return Date() }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        if let d = f.date(from: s) { return d }
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f.date(from: s) ?? Date()
    }

    static func dump(at text: String?) {
        let now = parse(text)
        let state = AppState(store: nil, fixedNow: now)
        let s = state.snapshot
        let m = state.money
        let line = StatusText.make(s, settings: state.settings, boss: false)
        print("时间       \(text ?? "现在")")
        print("菜单栏     \(line.plainText.isEmpty ? "（仅图标）" : line.plainText)")
        print("当天       \(Fmt.dayLine(s, calendar: state.calendar))")
        print("状态       \(s.phase)")
        print("今日已挣   \(m.string(s.earnedToday))")
        print("日薪       \(m.string(s.dailyWage))   时薪 \(m.string(s.hourly))   每秒 \(m.string(s.perSecond, decimals: 4))")
        print("进度       \(Int((s.progress * 100).rounded(.down)))%   距下班 \(s.secondsToEnd.map(Duration.clock) ?? "-")")
        print("本月       \(m.string(s.monthTotal))   第 \(s.paidDayIndex)/\(s.paidDaysInMonth) 个计薪日")
    }

    static func render(to dir: String, at text: String? = nil) {
        let url = URL(fileURLWithPath: dir)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)

        let now = parse(text ?? "2026-11-17 15:18:42")
        let state = AppState(store: nil, fixedNow: now)

        for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            snap(PanelView(state: state, openSettings: {}), url.appendingPathComponent("panel-\(name).png"), appearance)
        }
        snap(SalaryTab(state: state), url.appendingPathComponent("settings-salary.png"), .aqua)
        snap(ScheduleTab(state: state), url.appendingPathComponent("settings-schedule.png"), .aqua)
        let holidays = AppState(store: nil, fixedNow: parse("2026-10-10 15:18:42"))
        holidays.settings.manualMarks = [ManualMark(date: "2026-10-23", kind: .paidLeave, note: "年假")]
        snap(HolidaysTab(state: holidays), url.appendingPathComponent("settings-holidays.png"), .aqua)
        snap(DisplayTab(state: state), url.appendingPathComponent("settings-display.png"), .aqua)

        // 菜单栏各状态
        let times = ["2026-11-17 15:18:42", "2026-11-17 08:30:00", "2026-11-17 12:40:00", "2026-11-17 18:30:00",
                     "2026-10-02 10:00:00", "2026-10-10 15:18:42", "2026-11-21 10:00:00"]
        var rows: [NSAttributedString] = []
        for t in times {
            let st = AppState(store: nil, fixedNow: parse(t))
            rows.append(StatusController.attributed(StatusText.make(st.snapshot, settings: st.settings, boss: false)))
        }
        let boss = AppState(store: nil, fixedNow: now)
        rows.append(StatusController.attributed(StatusText.make(boss.snapshot, settings: boss.settings, boss: true)))
        menubar(rows, labels: times + ["老板模式"], to: url.appendingPathComponent("menubar.png"))
        print("已渲染到 \(url.path)")
    }

    private static func snap<V: View>(_ view: V, _ file: URL, _ appearance: NSAppearance.Name) {
        let host = NSHostingView(rootView: view.background(Color(nsColor: .windowBackgroundColor)))
        host.appearance = NSAppearance(named: appearance)
        let size = host.fittingSize
        host.frame = NSRect(origin: .zero, size: size)
        let win = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
        win.appearance = NSAppearance(named: appearance)
        win.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
        host.cacheDisplay(in: host.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: file)
    }

    private static func menubar(_ rows: [NSAttributedString], labels: [String], to file: URL) {
        let h: CGFloat = 30, w: CGFloat = 520
        let img = NSImage(size: NSSize(width: w, height: h * CGFloat(rows.count)), flipped: true) { _ in
            NSAppearance(named: .aqua)!.performAsCurrentDrawingAppearance {
            for (i, r) in rows.enumerated() {
                let y = CGFloat(i) * h
                NSColor(srgbRed: 0.965, green: 0.969, blue: 0.976, alpha: 1).setFill()
                NSRect(x: 0, y: y, width: w, height: h - 2).fill()
                NSAttributedString(string: labels[i], attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.gray])
                    .draw(at: NSPoint(x: 10, y: y + 8))
                let titleW = r.size().width
                let x = w - 16 - titleW
                OxIcon.make(size: 16, color: .black, template: false).draw(in: NSRect(x: x - 22, y: y + 6, width: 16, height: 16))
                r.draw(at: NSPoint(x: x, y: y + 6))
            }
            }
            return true
        }
        if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
            try? rep.representation(using: .png, properties: [:])?.write(to: file)
        }
    }
}
