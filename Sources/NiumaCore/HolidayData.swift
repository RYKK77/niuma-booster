import Foundation

/// 内置的国务院放假安排。
/// 2026：国办发明电〔2025〕7号  https://www.news.cn/politics/20251104/88bcffd88ae249e58c699b8772548e3d/c.html
/// 2027：国办发明电〔2026〕10号 https://www.news.cn/politics/20261105/f90cd6ad4df94ab4833b141e52ccfc13/c.html
public enum BuiltinHolidays {
    /// (名称, 放假开始, 放假结束, 调休上班日)
    static let notices: [(String, String, String, [String])] = [
        // 2026
        ("元旦", "2026-01-01", "2026-01-03", ["2026-01-04"]),
        ("春节", "2026-02-15", "2026-02-23", ["2026-02-14", "2026-02-28"]),
        ("清明", "2026-04-04", "2026-04-06", []),
        ("劳动节", "2026-05-01", "2026-05-05", ["2026-05-09"]),
        ("端午", "2026-06-19", "2026-06-21", []),
        ("中秋", "2026-09-25", "2026-09-27", []),
        ("国庆", "2026-10-01", "2026-10-07", ["2026-09-20", "2026-10-10"]),
        // 2027
        ("元旦", "2027-01-01", "2027-01-03", []),
        ("春节", "2027-02-05", "2027-02-13", ["2027-01-31", "2027-02-14"]),
        ("清明", "2027-04-03", "2027-04-05", []),
        ("劳动节", "2027-05-01", "2027-05-05", ["2027-05-08"]),
        ("端午", "2027-06-09", "2027-06-09", []),
        ("中秋", "2027-09-15", "2027-09-15", []),
        ("国庆", "2027-10-01", "2027-10-07", ["2027-09-26", "2027-10-09"]),
    ]

    public static let years: [Int] = [2026, 2027]

    public static let entries: [HolidayEntry] = {
        var out: [HolidayEntry] = []
        for (name, start, end, makeups) in notices {
            for key in DayKey.range(from: start, to: end) {
                out.append(HolidayEntry(date: key, type: .holiday, name: name))
            }
            for key in makeups {
                out.append(HolidayEntry(date: key, type: .workday, name: name))
            }
        }
        return out
    }()
}

/// "yyyy-MM-dd" 日期键。只做纯日期运算，不经过时区。
public enum DayKey {
    private static let utc: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()

    public static func parse(_ key: String) -> DateComponents? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, (1...12).contains(parts[1]), (1...31).contains(parts[2]) else { return nil }
        return DateComponents(year: parts[0], month: parts[1], day: parts[2])
    }

    public static func make(year: Int, month: Int, day: Int) -> String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    /// 用给定日历（本地时区）的年月日分量生成键；不要用 ISO/UTC 格式化器，东八区早上 8 点前会差一天。
    public static func key(_ date: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return make(year: c.year!, month: c.month!, day: c.day!)
    }

    public static func isValid(_ key: String) -> Bool {
        guard let c = parse(key), let d = utc.date(from: c) else { return false }
        let back = utc.dateComponents([.year, .month, .day], from: d)
        return back.year == c.year && back.month == c.month && back.day == c.day
    }

    public static func range(from start: String, to end: String) -> [String] {
        guard let s = parse(start).flatMap({ utc.date(from: $0) }),
              let e = parse(end).flatMap({ utc.date(from: $0) }), s <= e else { return [] }
        var out: [String] = []
        var d = s
        while d <= e {
            out.append(key(d, calendar: utc))
            d = utc.date(byAdding: .day, value: 1, to: d)!
        }
        return out
    }
}
