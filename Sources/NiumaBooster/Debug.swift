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

        // 菜单栏 + 展开的面板（README 头图）
        snap(HeroShot(state: state), url.appendingPathComponent("hero.png"), .aqua, background: false)

        // 菜单栏各状态
        let cases: [(String, String, Bool)] = [
            ("上班中", "2026-11-17 15:18:42", false), ("上班前", "2026-11-17 08:30:00", false),
            ("午休", "2026-11-17 12:40:00", false), ("已下班", "2026-11-17 18:30:00", false),
            ("法定节假日", "2026-10-02 10:00:00", false), ("调休补班", "2026-10-10 15:18:42", false),
            ("周末", "2026-11-21 10:00:00", false), ("老板模式", "2026-11-17 15:18:42", true),
        ]
        let rows: [StatesShot.Row] = cases.map { label, t, boss in
            let st = AppState(store: nil, fixedNow: parse(t))
            return StatesShot.Row(label: label,
                                  line: StatusText.make(st.snapshot, settings: st.settings, boss: boss),
                                  clock: FakeMenuBar.clock(st.snapshot.now, calendar: st.calendar))
        }
        snap(StatesShot(rows: rows), url.appendingPathComponent("menubar.png"), .aqua, background: false)
        print("已渲染到 \(url.path)")
    }

    /// 按 2 倍像素渲染，README 里看起来清楚
    private static func snap<V: View>(_ view: V, _ file: URL, _ appearance: NSAppearance.Name, background: Bool = true) {
        let root = Group {
            if background { view.background(Color(nsColor: .windowBackgroundColor)) } else { view }
        }
        let host = NSHostingView(rootView: root)
        host.appearance = NSAppearance(named: appearance)
        let size = host.fittingSize
        host.frame = NSRect(origin: .zero, size: size)
        let win = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
        win.appearance = NSAppearance(named: appearance)
        win.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        let scale: CGFloat = 2
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil,
                                         pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return }
        rep.size = size
        host.cacheDisplay(in: host.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: file)
    }
}

// MARK: - README 截图用的仿真菜单栏

private let wallpaper = LinearGradient(
    colors: [Color(red: 0.96, green: 0.84, blue: 0.74), Color(red: 0.78, green: 0.84, blue: 0.91)],
    startPoint: .topLeading, endPoint: .bottomTrailing)

struct FakeMenuBar: View {
    let line: StatusLine
    let clock: String
    var selected = false

    static func clock(_ d: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.month, .day, .weekday, .hour, .minute], from: d)
        let wd = ["", "周日", "周一", "周二", "周三", "周四", "周五", "周六"][c.weekday ?? 0]
        return String(format: "%d月%d日 %@ %02d:%02d", c.month ?? 0, c.day ?? 0, wd, c.hour ?? 0, c.minute ?? 0)
    }

    var body: some View {
        HStack(spacing: 16) {
            Spacer(minLength: 0)
            HStack(spacing: 5) {
                Image(nsImage: OxIcon.make(size: 16, color: .black, template: false))
                if let b = line.badge {
                    Text(b).font(.system(size: 10, weight: .semibold)).foregroundStyle(Color(white: 0.4))
                }
                if let p = line.prefix { Text(p).foregroundStyle(Color(white: 0.4)) }
                if !line.main.isEmpty { Text(line.main) }
                if line.check { Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.green) }
            }
            .padding(.horizontal, 8)
            .frame(height: 22)
            .background(selected ? Color.black.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 5))
            Image(systemName: "wifi")
            Image(systemName: "battery.75percent")
            Image(systemName: "magnifyingglass")
            Text(clock)
        }
        .font(.system(size: 13, weight: .medium))
        .monospacedDigit()
        .foregroundStyle(Color(white: 0.1))
        .padding(.horizontal, 14)
        .frame(height: 30)
        .background(Color.white.opacity(0.7))
    }
}

/// 菜单栏 + 点开的面板
struct HeroShot: View {
    @ObservedObject var state: AppState
    var body: some View {
        let line = StatusText.make(state.snapshot, settings: state.settings, boss: false)
        ZStack(alignment: .topTrailing) {
            wallpaper
            VStack(spacing: 0) {
                FakeMenuBar(line: line, clock: FakeMenuBar.clock(state.snapshot.now, calendar: state.calendar), selected: true)
                Spacer()
            }
            PanelView(state: state, openSettings: {})
                .background(Color(white: 0.99), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.black.opacity(0.12), lineWidth: 0.5))
                .compositingGroup()
                .shadow(color: .black.opacity(0.22), radius: 18, y: 10)
                .padding(.top, 38)
                .padding(.trailing, 150)
        }
        .frame(width: 760, height: 640)
        .environment(\.colorScheme, .light)
    }
}

/// 菜单栏的各种状态
struct StatesShot: View {
    struct Row: Identifiable {
        let label: String
        let line: StatusLine
        let clock: String
        var id: String { label }
    }
    let rows: [Row]

    var body: some View {
        VStack(spacing: 10) {
            ForEach(rows) { r in
                HStack(spacing: 14) {
                    Text(r.label)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color(white: 0.2))
                        .frame(width: 76, alignment: .leading)
                    FakeMenuBar(line: r.line, clock: r.clock)
                        .background(wallpaper)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .padding(20)
        .frame(width: 600)
        .background(Color(white: 0.97))
        .environment(\.colorScheme, .light)
    }
}
