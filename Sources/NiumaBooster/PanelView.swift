import AppKit
import SwiftUI
import NiumaCore

enum Theme {
    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { ap in
            let hex = ap.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
                           green: CGFloat((hex >> 8) & 0xFF) / 255,
                           blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        })
    }
    /// 主色：浅色 #C2410C（白底对比 5.2:1），深色换亮一点
    static let accent = dynamic(0xC2410C, 0xFB923C)
    static let accentText = dynamic(0x9A3412, 0xFDBA74)
    static let accentSoft = dynamic(0xFFF4EC, 0x3A2416)
    static let green = dynamic(0x1A7F37, 0x4ADE80)
    static let card = dynamic(0xF2F3F5, 0x2C2C2E)
    static let track = dynamic(0xE3E5E8, 0x3A3A3C)
    static let holidayBg = dynamic(0xFDE7DA, 0x4A2A1A)
    static let holidayFg = dynamic(0x9A3412, 0xFDBA74)
    static let workBg = dynamic(0xDDE3EA, 0x334155)
    static let workFg = dynamic(0x334155, 0xE2E8F0)
    static let leaveBg = dynamic(0xDCF2E4, 0x14532D)
    static let leaveFg = dynamic(0x166534, 0xBBF7D0)
}

enum Fmt {
    static func clock(_ minutes: Int) -> String { String(format: "%02d:%02d", minutes / 60, minutes % 60) }

    static func dayLine(_ s: Snapshot, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.month, .day, .weekday], from: s.shiftDay)
        let wd = ["", "周日", "周一", "周二", "周三", "周四", "周五", "周六"][c.weekday ?? 0]
        return "\(c.month ?? 0)月\(c.day ?? 0)日 \(wd) · \(kindLabel(s.day))"
    }

    static func kindLabel(_ d: DayInfo) -> String {
        switch d.kind {
        case .workday: return d.name == "大周" ? "大周周六" : "工作日"
        case .makeupWorkday: return "调休补班"
        case .weekend: return "周末"
        case .holiday: return d.name ?? "法定节假日"
        case .paidLeave: return d.name.map { "带薪假（\($0)）" } ?? "带薪假"
        case .manualRest: return d.name.map { "休息（\($0)）" } ?? "休息"
        case .manualWork: return d.name.map { "上班（\($0)）" } ?? "上班"
        }
    }
}

// MARK: - 下拉面板

struct PanelView: View {
    @ObservedObject var state: AppState
    let openSettings: () -> Void

    var body: some View {
        let s = state.snapshot
        let st = state.settings
        VStack(alignment: .leading, spacing: 14) {
            header(s)
            if s.day.accrues { progress(s) }
            stats(s)
            if st.milestonesEnabled, s.day.isPaid { milestone(s) }
            if st.quotesEnabled {
                Text(Quotes.forDate(s.now, calendar: state.calendar))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
            }
            Divider().padding(.horizontal, 4)
            VStack(spacing: 0) {
                MenuRow(title: state.boss ? "老板模式：已开启" : "老板模式",
                        shortcut: st.bossHotkey == .off ? "" : st.bossHotkey.label,
                        checked: state.boss) { state.boss.toggle() }
                MenuRow(title: "设置…", shortcut: "⌘,") { openSettings() }
                    .keyboardShortcut(",", modifiers: .command)
                MenuRow(title: "退出牛马加油器", shortcut: "⌘Q") { NSApp.terminate(nil) }
                    .keyboardShortcut("q", modifiers: .command)
            }
            .padding(.top, -6)

            // 底部开源署名与链接
            HStack(spacing: 6) {
                FooterLink(title: "作者 @RYKK77", url: About.authorURL, help: "访问作者 GitHub 主页")
                Text("·").opacity(0.6)
                FooterLink(title: "GitHub 项目主页", url: About.repoURL, help: "访问项目开源仓库")
            }
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.top, -8)
        }
        .padding(.horizontal, 14)
        .padding(.top, 16)
        .padding(.bottom, 8)
        .frame(width: 330)
    }

    private func header(_ s: Snapshot) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(s.phase == .rest ? "今天休息" : "今日已到账")
                Spacer()
                Text(Fmt.dayLine(s, calendar: state.calendar))
            }
            .font(.system(size: 12))
            .foregroundStyle(.secondary)

            Text(state.amount(s.earnedToday))
                .font(.system(size: 40, weight: .bold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .foregroundStyle(s.phase == .rest ? .secondary : .primary)
            Text(subline(s))
                .font(.system(size: 12, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(s.phase == .working ? Theme.green : Color.secondary)
        }
        .padding(.horizontal, 4)
    }

    private func subline(_ s: Snapshot) -> String {
        let st = state.settings
        switch s.phase {
        case .working: return "每秒 +\(state.amount(s.perSecond, decimals: 4))，继续涨"
        case .lunch: return "干饭中，\(Fmt.clock(st.lunchEnd)) 继续涨"
        case .beforeWork: return "还没上班，距上班 \(Duration.words(s.secondsToStart ?? 0))"
        case .afterWork: return "今天的钱已全部到账，下班快乐"
        case .paidLeave: return "带薪假，全天照算"
        case .rest:
            if s.day.kind == .holiday, let n = s.day.name { return "\(n)假期，好好休息" }
            return "不计薪，养精蓄锐"
        }
    }

    private func progress(_ s: Snapshot) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ShiftBar(shift: s.shift, now: s.now, height: 8)
            HStack {
                Text(Fmt.clock(state.settings.workStart))
                Spacer()
                if state.settings.lunchEnabled, s.shift.lunchStart != nil {
                    Text("午休 \(Fmt.clock(state.settings.lunchStart))–\(Fmt.clock(state.settings.lunchEnd))")
                    Spacer()
                }
                Text(Fmt.clock(state.settings.workEnd))
            }
            .font(.system(size: 11))
            .monospacedDigit()
            .foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline) {
                Text("已完成 ") + Text("\(Int((s.progress * 100).rounded(.down)))%").bold() + Text(" 有效工时")
                Spacer()
                if let end = s.secondsToEnd {
                    Text("距下班 ") + Text(Duration.clock(end)).bold().foregroundColor(Theme.accentText)
                } else {
                    Text("已下班").foregroundColor(Theme.green)
                }
            }
            .font(.system(size: 13))
            .monospacedDigit()
            .padding(.top, 2)
        }
        .padding(.horizontal, 4)
    }

    private func stats(_ s: Snapshot) -> some View {
        let cols = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
        return LazyVGrid(columns: cols, spacing: 8) {
            Stat(label: s.day.isPaid ? "今日日薪" : "本月日薪", value: state.amount(s.dailyWage))
            Stat(label: "时薪", value: state.amount(s.hourly))
            Stat(label: "本月累计", value: state.amount(s.monthTotal))
            Stat(label: "本月计薪日", value: s.day.isPaid
                 ? "第 \(s.paidDayIndex) / \(s.paidDaysInMonth) 天"
                 : "已过 \(s.paidDayIndex) / \(s.paidDaysInMonth) 天")
        }
    }

    private func milestone(_ s: Snapshot) -> some View {
        let m = Milestones.status(s, list: state.settings.milestones)
        let title: String = m.reached.map { "刚挣够\($0.name)（\(state.amount($0.amount, decimals: 0))）" } ?? "第一个小目标马上到"
        var detail = "今天的里程碑全部解锁"
        if let n = m.next {
            detail = "下一个：\(n.name) \(state.amount(n.amount, decimals: 0))，还差 \(state.amount(m.remaining))"
            if let eta = m.eta { detail += "，大约 \(Duration.words(eta))" }
            else if n.amount > s.dailyWage { detail += "，今天够不着了" }
        }
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: "scope")
                .foregroundStyle(Theme.accentText)
                .font(.system(size: 15))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.accentText)
                Text(detail).font(.system(size: 12)).monospacedDigit().foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: 8))
    }
}

struct Stat: View {
    let label: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 15, weight: .semibold)).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 8))
    }
}

/// 作者与开源仓库信息，面板底部和设置「关于」共用
enum About {
    static let authorURL = URL(string: "https://github.com/RYKK77")!
    static let repoURL = URL(string: "https://github.com/RYKK77/niuma-booster")!
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
    }
}

/// 面板底部的小号链接，悬停变主色加下划线
struct FooterLink: View {
    let title: String
    let url: URL
    var help = ""
    @State private var hover = false

    var body: some View {
        Link(destination: url) {
            Text(title)
                .underline(hover)
                .foregroundStyle(hover ? Theme.accentText : Color.secondary)
        }
        .buttonStyle(.plain)
        .help(help)
        .onHover { hover = $0 }
    }
}

struct MenuRow: View {
    let title: String
    var shortcut: String = ""
    var checked = false
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title)
                Spacer()
                if checked { Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)) }
                Text(shortcut).foregroundStyle(.secondary).monospacedDigit()
            }
            .font(.system(size: 13))
            .padding(.horizontal, 10)
            .frame(height: 28)
            .contentShape(Rectangle())
            .background(hover ? Color.primary.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// 上午 | 午休 | 下午 三段进度条
struct ShiftBar: View {
    let shift: ShiftWindow
    let now: Date?
    var height: CGFloat = 8
    var labels = false

    private struct Seg: Identifiable { let id: Int; let start: Date; let end: Date; let lunch: Bool }

    private var segs: [Seg] {
        if let ls = shift.lunchStart, let le = shift.lunchEnd {
            return [Seg(id: 0, start: shift.start, end: ls, lunch: false),
                    Seg(id: 1, start: ls, end: le, lunch: true),
                    Seg(id: 2, start: le, end: shift.end, lunch: false)].filter { $0.end > $0.start }
        }
        return [Seg(id: 0, start: shift.start, end: shift.end, lunch: false)]
    }

    var body: some View {
        GeometryReader { geo in
            let total = max(1, shift.end.timeIntervalSince(shift.start))
            let gaps = CGFloat(max(0, segs.count - 1)) * 3
            HStack(spacing: 3) {
                ForEach(segs) { seg in
                    let w = (geo.size.width - gaps) * CGFloat(seg.end.timeIntervalSince(seg.start) / total)
                    segment(seg, width: w)
                }
            }
        }
        .frame(height: height)
    }

    @ViewBuilder private func segment(_ seg: Seg, width: CGFloat) -> some View {
        let r = RoundedRectangle(cornerRadius: height / 2)
        if seg.lunch {
            r.fill(Theme.track.opacity(0.6))
                .overlay(r.stroke(Theme.track, style: StrokeStyle(lineWidth: 1, dash: [3, 2])))
                .frame(width: max(0, width))
        } else {
            let frac: CGFloat = {
                guard let now else { return 1 }
                let d = seg.end.timeIntervalSince(seg.start)
                return CGFloat(min(1, max(0, now.timeIntervalSince(seg.start) / d)))
            }()
            ZStack(alignment: .leading) {
                r.fill(Theme.track)
                r.fill(Theme.accent).frame(width: max(0, width) * frac)
            }
            .frame(width: max(0, width))
            .clipShape(r)
        }
    }
}
