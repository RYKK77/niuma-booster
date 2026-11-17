import Foundation

public enum IncomeType: String, Codable, CaseIterable, Identifiable {
    case monthly, yearly, hourly
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .monthly: return "月薪"
        case .yearly: return "年薪"
        case .hourly: return "时薪"
        }
    }
}

public enum WageBasis: String, Codable, CaseIterable, Identifiable {
    case actualWorkdays, fixed2175
    public var id: String { rawValue }
}

public enum MenuBarFormat: String, Codable, CaseIterable, Identifiable {
    case amountOnly, amountProgress, amountCountdown, iconOnly
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .amountOnly: return "仅金额"
        case .amountProgress: return "金额 + 进度"
        case .amountCountdown: return "金额 + 下班倒计时"
        case .iconOnly: return "仅图标"
        }
    }
}

public enum OffHoursDisplay: String, Codable, CaseIterable, Identifiable {
    case text, iconOnly
    public var id: String { rawValue }
}

/// 老板模式快捷键预设。⌥⌘H 是系统「隐藏其他」，全局注册会抢走它，所以不用。
public enum BossHotkey: String, Codable, CaseIterable, Identifiable {
    case ctrlOptB, ctrlOptCmdH, off
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .ctrlOptB: return "⌃⌥B"
        case .ctrlOptCmdH: return "⌃⌥⌘H"
        case .off: return "不使用"
        }
    }
}

public enum ManualKind: String, Codable, CaseIterable, Identifiable {
    case work, rest, paidLeave
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .work: return "工作日"
        case .rest: return "休息（不计薪）"
        case .paidLeave: return "带薪假（按全天计）"
        }
    }
}

public struct ManualMark: Codable, Equatable, Identifiable {
    public var date: String
    public var kind: ManualKind
    public var note: String
    public var id: String { date }
    public init(date: String, kind: ManualKind, note: String = "") {
        self.date = date; self.kind = kind; self.note = note
    }
}

public enum HolidayEntryType: String, Codable {
    case holiday   // 放假
    case workday   // 调休上班
}

/// 节假日条目；导入的 JSON 也是这个格式的数组：
/// [{"date":"2028-01-01","type":"holiday","name":"元旦"}, {"date":"2028-01-02","type":"workday","name":"元旦"}]
public struct HolidayEntry: Codable, Equatable {
    public var date: String
    public var type: HolidayEntryType
    public var name: String
    public init(date: String, type: HolidayEntryType, name: String) {
        self.date = date; self.type = type; self.name = name
    }
}

public struct Milestone: Codable, Equatable {
    public var name: String
    public var amount: Double
    public init(name: String, amount: Double) { self.name = name; self.amount = amount }

    public static let defaults: [Milestone] = [
        .init(name: "一杯奶茶", amount: 15),
        .init(name: "一份外卖", amount: 30),
        .init(name: "一张电影票", amount: 60),
        .init(name: "一顿火锅", amount: 150),
        .init(name: "一顿日料", amount: 800),
        .init(name: "一双球鞋", amount: 1200),
    ]
}

public struct AppSettings: Codable, Equatable {
    // 薪资
    public var incomeType: IncomeType = .monthly
    public var amount: Double = 20000
    public var basis: WageBasis = .actualWorkdays
    public var currency: String = "¥"
    public var decimals: Int = 2

    // 作息（分钟数，0...1439）
    public var workStart: Int = 9 * 60
    public var workEnd: Int = 18 * 60
    public var lunchEnabled: Bool = true
    public var lunchStart: Int = 12 * 60
    public var lunchEnd: Int = 12 * 60 + 30 + 60
    /// Calendar.weekday：1=周日 … 7=周六
    public var workWeekdays: Set<Int> = [2, 3, 4, 5, 6]
    public var bigSmallWeek: Bool = false
    /// 某个「大周」（周六上班）的周一
    public var bigWeekAnchor: String? = nil

    // 节假日
    public var manualMarks: [ManualMark] = []
    public var importedHolidays: [HolidayEntry] = []

    // 显示
    public var menuBarFormat: MenuBarFormat = .amountOnly
    public var showIcon: Bool = true
    public var offHoursDisplay: OffHoursDisplay = .text
    public var bossHotkey: BossHotkey = .ctrlOptB

    // 加油
    public var milestonesEnabled: Bool = true
    public var milestones: [Milestone] = Milestone.defaults
    public var quotesEnabled: Bool = true
    public var offWorkNotification: Bool = true

    public init() {}

    enum CodingKeys: String, CodingKey {
        case incomeType, amount, basis, currency, decimals
        case workStart, workEnd, lunchEnabled, lunchStart, lunchEnd, workWeekdays, bigSmallWeek, bigWeekAnchor
        case manualMarks, importedHolidays
        case menuBarFormat, showIcon, offHoursDisplay, bossHotkey
        case milestonesEnabled, milestones, quotesEnabled, offWorkNotification
    }

    /// 缺字段、坏字段都回落到默认值，升级后旧配置不会丢。
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AppSettings()
        func v<T: Decodable>(_ k: CodingKeys, _ def: T) -> T { (try? c.decodeIfPresent(T.self, forKey: k)) ?? def }
        incomeType = v(.incomeType, d.incomeType)
        amount = v(.amount, d.amount)
        basis = v(.basis, d.basis)
        currency = v(.currency, d.currency)
        decimals = v(.decimals, d.decimals)
        workStart = v(.workStart, d.workStart)
        workEnd = v(.workEnd, d.workEnd)
        lunchEnabled = v(.lunchEnabled, d.lunchEnabled)
        lunchStart = v(.lunchStart, d.lunchStart)
        lunchEnd = v(.lunchEnd, d.lunchEnd)
        workWeekdays = v(.workWeekdays, d.workWeekdays)
        bigSmallWeek = v(.bigSmallWeek, d.bigSmallWeek)
        bigWeekAnchor = v(.bigWeekAnchor, d.bigWeekAnchor)
        manualMarks = v(.manualMarks, d.manualMarks)
        importedHolidays = v(.importedHolidays, d.importedHolidays)
        menuBarFormat = v(.menuBarFormat, d.menuBarFormat)
        showIcon = v(.showIcon, d.showIcon)
        offHoursDisplay = v(.offHoursDisplay, d.offHoursDisplay)
        bossHotkey = v(.bossHotkey, d.bossHotkey)
        milestonesEnabled = v(.milestonesEnabled, d.milestonesEnabled)
        milestones = v(.milestones, d.milestones)
        quotesEnabled = v(.quotesEnabled, d.quotesEnabled)
        offWorkNotification = v(.offWorkNotification, d.offWorkNotification)
    }

    /// 月薪口径的月收入
    public var monthlyAmount: Double {
        switch incomeType {
        case .monthly: return amount
        case .yearly: return amount / 12
        case .hourly: return 0
        }
    }

    /// 打开大小周时如果还没设过，默认本周是大周（本周六上班）
    public mutating func setBigSmallWeek(_ on: Bool, today: Date, calendar: Calendar) {
        bigSmallWeek = on
        if on, bigWeekAnchor == nil {
            bigWeekAnchor = DayKey.key(WorkCalendar.monday(of: today, calendar: calendar), calendar: calendar)
        }
    }

    public mutating func setMark(_ mark: ManualMark?, for key: String) {
        manualMarks.removeAll { $0.date == key }
        if let mark { manualMarks.append(mark); manualMarks.sort { $0.date < $1.date } }
    }
}

/// 解析导入的节假日 JSON，坏条目直接丢掉。
public enum HolidayImport {
    public static func parse(_ data: Data) throws -> [HolidayEntry] {
        let entries = try JSONDecoder().decode([HolidayEntry].self, from: data)
        return entries.filter { DayKey.isValid($0.date) }
    }

    /// 合并：同一天以新导入的为准
    public static func merge(_ old: [HolidayEntry], _ new: [HolidayEntry]) -> [HolidayEntry] {
        var map: [String: HolidayEntry] = [:]
        for e in old { map[e.date] = e }
        for e in new { map[e.date] = e }
        return map.values.sorted { $0.date < $1.date }
    }
}
