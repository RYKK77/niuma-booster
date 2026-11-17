import Foundation

public enum DayKind: Equatable {
    case workday          // 按每周工作日上班
    case makeupWorkday    // 调休补班
    case weekend          // 普通休息日
    case holiday          // 法定节假日
    case paidLeave        // 手动：带薪假
    case manualRest       // 手动：休息
    case manualWork       // 手动：上班
}

public struct DayInfo: Equatable {
    public var kind: DayKind
    /// 节日名（国庆）或手动备注
    public var name: String?

    /// 计入当月计薪日
    public var isPaid: Bool {
        switch kind {
        case .workday, .makeupWorkday, .paidLeave, .manualWork: return true
        case .weekend, .holiday, .manualRest: return false
        }
    }

    /// 当天按秒累积（带薪假直接给全天，不按秒）
    public var accrues: Bool {
        switch kind {
        case .workday, .makeupWorkday, .manualWork: return true
        default: return false
        }
    }
}

/// 判断某天是什么日子。优先级：手动标记 > 导入的 JSON > 内置国务院安排 > 每周作息（含大小周）。
public struct WorkCalendar {
    public let calendar: Calendar
    private let builtin: [String: HolidayEntry]
    private let imported: [String: HolidayEntry]
    private let manual: [String: ManualMark]
    private let weekdays: Set<Int>
    private let bigSmall: Bool
    private let bigAnchor: Date?

    public init(settings: AppSettings, calendar: Calendar, builtin: [HolidayEntry] = BuiltinHolidays.entries) {
        self.calendar = calendar
        self.builtin = Dictionary(builtin.map { ($0.date, $0) }, uniquingKeysWith: { _, b in b })
        self.imported = Dictionary(settings.importedHolidays.map { ($0.date, $0) }, uniquingKeysWith: { _, b in b })
        self.manual = Dictionary(settings.manualMarks.map { ($0.date, $0) }, uniquingKeysWith: { _, b in b })
        self.weekdays = settings.workWeekdays
        self.bigSmall = settings.bigSmallWeek
        if let a = settings.bigWeekAnchor, let c = DayKey.parse(a), let d = calendar.date(from: c) {
            self.bigAnchor = WorkCalendar.monday(of: d, calendar: calendar)
        } else {
            self.bigAnchor = nil
        }
    }

    public func key(_ date: Date) -> String { DayKey.key(date, calendar: calendar) }

    public func info(for date: Date) -> DayInfo {
        let k = key(date)
        if let m = manual[k] {
            let note = m.note.isEmpty ? nil : m.note
            switch m.kind {
            case .work: return DayInfo(kind: .manualWork, name: note)
            case .rest: return DayInfo(kind: .manualRest, name: note)
            case .paidLeave: return DayInfo(kind: .paidLeave, name: note)
            }
        }
        if let e = imported[k] ?? builtin[k] {
            return DayInfo(kind: e.type == .holiday ? .holiday : .makeupWorkday, name: e.name)
        }
        let wd = calendar.component(.weekday, from: date)
        if weekdays.contains(wd) { return DayInfo(kind: .workday, name: nil) }
        if bigSmall, wd == 7, isBigWeek(date) { return DayInfo(kind: .workday, name: "大周") }
        return DayInfo(kind: .weekend, name: nil)
    }

    /// 内置/导入里的节假日条目（不含手动标记），用于设置页列表
    public func noticeEntry(forKey k: String) -> HolidayEntry? { imported[k] ?? builtin[k] }
    public func manualMark(forKey k: String) -> ManualMark? { manual[k] }

    public func isBigWeek(_ date: Date) -> Bool {
        guard let anchor = bigAnchor else { return false }
        let mon = WorkCalendar.monday(of: date, calendar: calendar)
        let days = calendar.dateComponents([.day], from: anchor, to: mon).day ?? 0
        let weeks = Int((Double(days) / 7).rounded())
        return ((weeks % 2) + 2) % 2 == 0
    }

    public static func monday(of date: Date, calendar: Calendar) -> Date {
        let day = calendar.startOfDay(for: date)
        let wd = calendar.component(.weekday, from: day)
        return calendar.date(byAdding: .day, value: -((wd + 5) % 7), to: day)!
    }

    /// 某天所在月份的所有日期（每天零点）
    public func daysInMonth(of date: Date) -> [Date] {
        let comps = calendar.dateComponents([.year, .month], from: date)
        let first = calendar.date(from: comps)!
        let n = calendar.range(of: .day, in: .month, for: first)!.count
        return (0..<n).map { calendar.date(byAdding: .day, value: $0, to: first)! }
    }

    public func paidDays(inMonthOf date: Date) -> [Date] {
        daysInMonth(of: date).filter { info(for: $0).isPaid }
    }
}

public enum Phase: Equatable {
    case beforeWork, working, lunch, afterWork, rest, paidLeave
}

public struct ShiftWindow: Equatable {
    public var start: Date
    public var end: Date
    public var lunchStart: Date?
    public var lunchEnd: Date?
    public var effectiveSeconds: Double
}

public struct Snapshot: Equatable {
    public var now: Date
    public var shiftDay: Date
    public var day: DayInfo
    public var phase: Phase
    public var shift: ShiftWindow
    public var earnedToday: Double
    /// 当月每个计薪日的日薪
    public var dailyWage: Double
    public var perSecond: Double
    public var hourly: Double
    /// 有效工时完成比例 0...1
    public var progress: Double
    public var secondsToStart: Double?
    public var secondsToEnd: Double?
    public var monthTotal: Double
    /// 今天是本月第几个计薪日（今天不计薪时为之前已过的计薪日数）
    public var paidDayIndex: Int
    public var paidDaysInMonth: Int
}

public struct WageEngine {
    public let settings: AppSettings
    public let workCalendar: WorkCalendar
    public var calendar: Calendar { workCalendar.calendar }

    public init(settings: AppSettings, calendar: Calendar) {
        self.settings = settings
        self.workCalendar = WorkCalendar(settings: settings, calendar: calendar)
    }

    private func at(_ day: Date, _ minutes: Int) -> Date {
        calendar.date(byAdding: .minute, value: minutes, to: day)!
    }
    private func plusDay(_ d: Date) -> Date { calendar.date(byAdding: .day, value: 1, to: d)! }

    public var isOvernight: Bool { settings.workEnd < settings.workStart }

    /// 某个班次日（零点）的上下班窗口。跨夜班归属于开始那天。
    public func shift(on day: Date) -> ShiftWindow {
        let start = at(day, settings.workStart)
        var end = at(day, settings.workEnd)
        if settings.workEnd < settings.workStart { end = plusDay(end) }
        // workStart == workEnd：视为 0 时长，不报错

        var ls: Date? = nil, le: Date? = nil
        if settings.lunchEnabled, settings.lunchStart != settings.lunchEnd, end > start {
            // 午休可能落在当天或次日（跨夜班），取和班次重叠最多的那一段
            let s0 = at(day, settings.lunchStart)
            var e0 = at(day, settings.lunchEnd)
            while e0 <= s0 { e0 = plusDay(e0) }
            var best: (Date, Date)? = nil
            var bestLen = 0.0
            for (s, e) in [(s0, e0), (plusDay(s0), plusDay(e0))] {
                let cs = max(s, start), ce = min(e, end)
                let len = ce.timeIntervalSince(cs)
                if len > bestLen { bestLen = len; best = (cs, ce) }
            }
            if let best { ls = best.0; le = best.1 }
        }
        var eff = end.timeIntervalSince(start)
        if let ls, let le { eff -= le.timeIntervalSince(ls) }
        return ShiftWindow(start: start, end: end, lunchStart: ls, lunchEnd: le, effectiveSeconds: max(0, eff))
    }

    /// 当前时间属于哪一天的班次
    public func shiftDay(for now: Date) -> Date {
        let today = calendar.startOfDay(for: now)
        if isOvernight {
            let y = calendar.date(byAdding: .day, value: -1, to: today)!
            if now < shift(on: y).end { return y }
        }
        return today
    }

    public func workedSeconds(_ sh: ShiftWindow, at now: Date) -> Double {
        let t = min(max(now, sh.start), sh.end)
        var w = t.timeIntervalSince(sh.start)
        if let ls = sh.lunchStart, let le = sh.lunchEnd {
            w -= max(0, min(t, le).timeIntervalSince(ls))
        }
        return max(0, w)
    }

    /// 当月计薪日的日薪
    public func dailyWage(for day: Date) -> Double {
        switch settings.incomeType {
        case .hourly:
            return settings.amount * shift(on: day).effectiveSeconds / 3600
        case .monthly, .yearly:
            switch settings.basis {
            case .fixed2175:
                return settings.monthlyAmount / 21.75
            case .actualWorkdays:
                let n = workCalendar.paidDays(inMonthOf: day).count
                return n > 0 ? settings.monthlyAmount / Double(n) : 0
            }
        }
    }

    public func snapshot(at now: Date) -> Snapshot {
        let day = shiftDay(for: now)
        let info = workCalendar.info(for: day)
        let sh = shift(on: day)
        let paid = workCalendar.paidDays(inMonthOf: day)
        let rate: Double
        switch settings.incomeType {
        case .hourly: rate = settings.amount * sh.effectiveSeconds / 3600
        case .monthly, .yearly:
            rate = settings.basis == .fixed2175
                ? settings.monthlyAmount / 21.75
                : (paid.isEmpty ? 0 : settings.monthlyAmount / Double(paid.count))
        }
        let eff = sh.effectiveSeconds
        let perSecond = eff > 0 ? rate / eff : 0
        let hourly = eff > 0 ? rate / (eff / 3600) : 0

        var phase: Phase
        var earned = 0.0
        var progress = 0.0
        var toStart: Double? = nil
        var toEnd: Double? = nil

        if info.accrues {
            let worked = workedSeconds(sh, at: now)
            if now < sh.start {
                phase = .beforeWork
                toStart = sh.start.timeIntervalSince(now)
                toEnd = sh.end.timeIntervalSince(now)
            } else if now >= sh.end {
                phase = .afterWork
            } else if let ls = sh.lunchStart, let le = sh.lunchEnd, now >= ls, now < le {
                phase = .lunch
                toEnd = sh.end.timeIntervalSince(now)
            } else {
                phase = .working
                toEnd = sh.end.timeIntervalSince(now)
            }
            if eff > 0 {
                earned = min(rate, perSecond * worked)
                progress = min(1, worked / eff)
            } else {
                earned = now >= sh.end ? rate : 0
                progress = now >= sh.end ? 1 : 0
            }
        } else if info.kind == .paidLeave {
            phase = .paidLeave
            earned = rate
            progress = 1
        } else {
            phase = .rest
        }

        let prior = paid.filter { $0 < day }.count
        return Snapshot(
            now: now, shiftDay: day, day: info, phase: phase, shift: sh,
            earnedToday: earned, dailyWage: rate, perSecond: perSecond, hourly: hourly,
            progress: progress, secondsToStart: toStart, secondsToEnd: toEnd,
            monthTotal: Double(prior) * rate + earned,
            paidDayIndex: prior + (info.isPaid ? 1 : 0),
            paidDaysInMonth: paid.count
        )
    }
}
