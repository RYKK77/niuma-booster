import Foundation

public struct Money {
    public var currency: String
    public var decimals: Int

    public init(currency: String, decimals: Int) {
        self.currency = currency
        self.decimals = max(0, min(4, decimals))
    }

    public init(_ s: AppSettings) { self.init(currency: s.currency, decimals: s.decimals) }

    public func string(_ v: Double, decimals d: Int? = nil) -> String {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.numberStyle = .decimal
        f.usesGroupingSeparator = true
        f.groupingSeparator = ","
        f.groupingSize = 3
        f.decimalSeparator = "."
        f.roundingMode = .halfUp
        let dd = d ?? decimals
        f.minimumFractionDigits = dd
        f.maximumFractionDigits = dd
        return currency + (f.string(from: NSNumber(value: v)) ?? "0")
    }

    /// 老板模式：不暴露位数
    public var masked: String { decimals > 0 ? currency + "***." + String(repeating: "*", count: decimals) : currency + "***" }
}

public enum Duration {
    /// 2:41:18
    public static func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded(.down)))
        return String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60)
    }

    /// 1 小时 29 分 / 30 分钟
    public static func words(_ seconds: Double) -> String {
        let m = max(0, Int((seconds / 60).rounded(.up)))
        if m < 60 { return "\(m) 分钟" }
        return m % 60 == 0 ? "\(m / 60) 小时" : "\(m / 60) 小时 \(m % 60) 分"
    }
}

/// 菜单栏那一行
public struct StatusLine: Equatable {
    public var prefix: String?     // 干饭中 / 带薪假（次要色）
    public var badge: String?      // 班
    public var main: String
    public var check: Bool         // 已下班的勾
    public var forceIcon: Bool     // 没字可显示时必须显示图标

    public var plainText: String {
        [badge, prefix, main.isEmpty ? nil : main, check ? "✓" : nil].compactMap { $0 }.joined(separator: " ")
    }
}

public enum StatusText {
    public static func make(_ s: Snapshot, settings: AppSettings, boss: Bool) -> StatusLine {
        let money = Money(settings)
        let amount = boss ? money.masked : money.string(s.earnedToday)
        let amount0 = boss ? Money(currency: settings.currency, decimals: 0).masked : money.string(s.earnedToday, decimals: 0)
        let pct = "\(Int((s.progress * 100).rounded(.down)))%"
        let fmt = settings.menuBarFormat
        var line = StatusLine(prefix: nil, badge: nil, main: "", check: false, forceIcon: false)

        if fmt == .iconOnly {
            line.forceIcon = true
            return line
        }

        switch s.phase {
        case .rest:
            if settings.offHoursDisplay == .iconOnly {
                line.forceIcon = true
            } else if s.day.kind == .holiday, let n = s.day.name {
                line.main = "\(n)休息"
            } else {
                line.main = "休息"
            }
            return line
        case .paidLeave:
            line.prefix = "带薪假"
            line.main = amount
            return line
        case .afterWork:
            line.main = amount
            line.check = true
        case .beforeWork:
            line.main = fmt == .amountProgress ? "\(amount0) · \(pct)" : amount
        case .working, .lunch:
            switch fmt {
            case .amountOnly, .iconOnly: line.main = amount
            case .amountProgress: line.main = "\(amount0) · \(pct)"
            case .amountCountdown: line.main = "\(amount) · \(Duration.clock(s.secondsToEnd ?? 0))"
            }
            if s.phase == .lunch { line.prefix = "干饭中" }
        }
        if s.day.kind == .makeupWorkday { line.badge = "班" }
        return line
    }
}

public struct MilestoneStatus: Equatable {
    public var reached: Milestone?
    public var next: Milestone?
    public var remaining: Double
    /// 按当前速度大约还要多久；今天够不着或不在累积时为 nil
    public var eta: Double?
}

public enum Milestones {
    public static func status(_ s: Snapshot, list: [Milestone]) -> MilestoneStatus {
        let sorted = list.filter { $0.amount > 0 }.sorted { $0.amount < $1.amount }
        let earned = s.earnedToday
        let reached = sorted.last { $0.amount <= earned + 1e-9 }
        let next = sorted.first { $0.amount > earned + 1e-9 }
        let remaining = max(0, (next?.amount ?? earned) - earned)
        var eta: Double? = nil
        if let next, s.perSecond > 0, s.phase == .working || s.phase == .lunch || s.phase == .beforeWork,
           next.amount <= s.dailyWage + 1e-9 {
            eta = remaining / s.perSecond
        }
        return MilestoneStatus(reached: reached, next: next, remaining: remaining, eta: eta)
    }

    /// 从 before 到 after 之间新跨过的里程碑
    public static func crossed(from before: Double, to after: Double, list: [Milestone]) -> [Milestone] {
        list.filter { $0.amount > 0 && $0.amount > before + 1e-9 && $0.amount <= after + 1e-9 }
            .sorted { $0.amount < $1.amount }
    }

    /// 设置页编辑用：「名称,金额」每行一个
    public static func parse(_ text: String) -> [Milestone] {
        text.split(whereSeparator: \.isNewline).compactMap { line in
            let parts = line.split(whereSeparator: { $0 == "," || $0 == "，" }).map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2, !parts[0].isEmpty, let v = Double(parts[1]), v > 0 else { return nil }
            return Milestone(name: parts[0], amount: v)
        }
    }

    public static func format(_ list: [Milestone]) -> String {
        list.map { m in
            let v = m.amount.rounded() == m.amount ? String(Int(m.amount)) : String(m.amount)
            return "\(m.name),\(v)"
        }.joined(separator: "\n")
    }
}

public enum Quotes {
    public static let all: [String] = [
        "再坚持一下，钱就到账了。",
        "今天的你也很值钱。",
        "每一秒都在进账，别慌。",
        "搬砖不易，且搬且珍惜。",
        "工资在涨，心态要稳。",
        "喝口水，钱还在跑。",
        "你不是在上班，你是在收钱。",
        "离下班又近了一点点。",
        "认真摸鱼，努力赚钱。",
        "今天也是被钱叫醒的一天。",
        "牛马也有春天。",
        "稳住，奶茶钱已经有了。",
    ]

    /// 每小时换一句
    public static func forDate(_ date: Date, calendar: Calendar) -> String {
        let day = calendar.ordinality(of: .day, in: .year, for: date) ?? 0
        let i = (day * 24 + calendar.component(.hour, from: date)) % all.count
        return all[i]
    }
}
