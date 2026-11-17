import XCTest
@testable import NiumaCore

final class WageEngineTests: XCTestCase {
    let cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        return c
    }()

    func t(_ y: Int, _ mo: Int, _ d: Int, _ h: Int = 0, _ mi: Int = 0, _ s: Int = 0) -> Date {
        cal.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi, second: s))!
    }

    func engine(_ edit: (inout AppSettings) -> Void = { _ in }) -> WageEngine {
        var s = AppSettings()
        edit(&s)
        return WageEngine(settings: s, calendar: cal)
    }

    func money(_ v: Double) -> String { Money(currency: "¥", decimals: 2).string(v) }

    // MARK: 计薪日（独立用 Python 数过：2026 = 21,16,22,21,19,21,23,21,22,18,21,23；2027 = 21,15,23,21,19,21,22,22,22,17,22,23）

    func testPaidDayCounts() {
        let e = engine()
        let y2026 = [21, 16, 22, 21, 19, 21, 23, 21, 22, 18, 21, 23]
        let y2027 = [21, 15, 23, 21, 19, 21, 22, 22, 22, 17, 22, 23]
        for m in 1...12 {
            XCTAssertEqual(e.workCalendar.paidDays(inMonthOf: t(2026, m, 1)).count, y2026[m - 1], "2026-\(m)")
            XCTAssertEqual(e.workCalendar.paidDays(inMonthOf: t(2027, m, 1)).count, y2027[m - 1], "2027-\(m)")
        }
    }

    // MARK: 设计稿里的数字

    func testDesignNov17Working() {
        let s = engine().snapshot(at: t(2026, 11, 17, 15, 18, 42))
        XCTAssertEqual(s.phase, .working)
        XCTAssertEqual(money(s.dailyWage), "¥952.38")
        XCTAssertEqual(money(s.earnedToday), "¥611.01")
        XCTAssertEqual(money(s.hourly), "¥126.98")
        XCTAssertEqual(String(format: "%.4f", s.perSecond), "0.0353")
        XCTAssertEqual(Int(s.progress * 100), 64)
        XCTAssertEqual(Duration.clock(s.secondsToEnd!), "2:41:18")
        XCTAssertEqual(s.paidDayIndex, 12)
        XCTAssertEqual(s.paidDaysInMonth, 21)
        XCTAssertEqual(money(s.monthTotal), "¥11,087.20")
    }

    func testDesignLunch() {
        let s = engine().snapshot(at: t(2026, 11, 17, 12, 40))
        XCTAssertEqual(s.phase, .lunch)
        XCTAssertEqual(money(s.earnedToday), "¥380.95")
        // 午休期间金额不动
        XCTAssertEqual(s.earnedToday, engine().snapshot(at: t(2026, 11, 17, 13, 29, 59)).earnedToday, accuracy: 1e-9)
    }

    func testBeforeAndAfterWork() {
        let before = engine().snapshot(at: t(2026, 11, 17, 8, 30))
        XCTAssertEqual(before.phase, .beforeWork)
        XCTAssertEqual(before.earnedToday, 0)
        XCTAssertEqual(before.secondsToStart, 1800)
        let after = engine().snapshot(at: t(2026, 11, 17, 18, 30))
        XCTAssertEqual(after.phase, .afterWork)
        XCTAssertEqual(money(after.earnedToday), "¥952.38")
        XCTAssertEqual(after.progress, 1, accuracy: 1e-9)
    }

    func testDesignOctMakeupDay() {
        let s = engine().snapshot(at: t(2026, 10, 10, 15, 18, 42))
        XCTAssertEqual(s.day.kind, .makeupWorkday)
        XCTAssertEqual(s.paidDaysInMonth, 18)
        XCTAssertEqual(money(s.dailyWage), "¥1,111.11")
        XCTAssertEqual(money(s.earnedToday), "¥712.84")
    }

    func testHolidayRest() {
        let s = engine().snapshot(at: t(2026, 10, 2, 10))
        XCTAssertEqual(s.phase, .rest)
        XCTAssertEqual(s.day, DayInfo(kind: .holiday, name: "国庆"))
        XCTAssertEqual(s.earnedToday, 0)
        XCTAssertEqual(StatusText.make(s, settings: AppSettings(), boss: false).main, "国庆休息")
    }

    func testMonthTotalEqualsSalaryOnLastPaidDay() {
        // 2026-11-30 周一是 11 月最后一个计薪日
        let s = engine().snapshot(at: t(2026, 11, 30, 19))
        XCTAssertEqual(s.paidDayIndex, 21)
        XCTAssertEqual(s.monthTotal, 20000, accuracy: 1e-6)
        XCTAssertEqual(money(s.monthTotal), "¥20,000.00")
        // 2027 年 2 月只有 15 天，也要正好凑满
        let f = engine().snapshot(at: t(2027, 2, 26, 23))
        XCTAssertEqual(f.monthTotal, 20000, accuracy: 1e-6)
    }

    func testFixed2175() {
        let s = engine { $0.basis = .fixed2175 }.snapshot(at: t(2026, 11, 17, 18, 30))
        XCTAssertEqual(money(s.dailyWage), "¥919.54")
    }

    func testYearlyAndHourly() {
        let y = engine { $0.incomeType = .yearly; $0.amount = 240000 }.snapshot(at: t(2026, 11, 17, 18, 30))
        XCTAssertEqual(money(y.dailyWage), "¥952.38")
        let h = engine { $0.incomeType = .hourly; $0.amount = 100 }.snapshot(at: t(2026, 11, 17, 15, 18, 42))
        XCTAssertEqual(h.dailyWage, 750, accuracy: 1e-9)
        XCTAssertEqual(h.hourly, 100, accuracy: 1e-9)
    }

    // MARK: 跨夜班

    func testOvernightShift() {
        let e = engine { $0.workStart = 22 * 60; $0.workEnd = 6 * 60; $0.lunchEnabled = false }
        let a = e.snapshot(at: t(2026, 11, 17, 23))
        XCTAssertEqual(a.shiftDay, t(2026, 11, 17))
        XCTAssertEqual(a.phase, .working)
        XCTAssertEqual(a.progress, 1.0 / 8, accuracy: 1e-9)

        let b = e.snapshot(at: t(2026, 11, 18, 2))
        XCTAssertEqual(b.shiftDay, t(2026, 11, 17))
        XCTAssertEqual(b.progress, 4.0 / 8, accuracy: 1e-9)

        let c = e.snapshot(at: t(2026, 11, 18, 7))
        XCTAssertEqual(c.shiftDay, t(2026, 11, 18))
        XCTAssertEqual(c.phase, .beforeWork)

        // 跨月：11-30 晚班到 12-01 凌晨，仍按 11 月计
        let d = e.snapshot(at: t(2026, 12, 1, 2))
        XCTAssertEqual(d.shiftDay, t(2026, 11, 30))
        XCTAssertEqual(d.paidDaysInMonth, 21)
        XCTAssertEqual(d.paidDayIndex, 21)
    }

    func testOvernightWithLunchAfterMidnight() {
        let e = engine { $0.workStart = 22 * 60; $0.workEnd = 7 * 60; $0.lunchStart = 2 * 60; $0.lunchEnd = 3 * 60 }
        let sh = e.shift(on: t(2026, 11, 17))
        XCTAssertEqual(sh.effectiveSeconds, 8 * 3600)
        XCTAssertEqual(sh.lunchStart, t(2026, 11, 18, 2))
        XCTAssertEqual(e.snapshot(at: t(2026, 11, 18, 2, 30)).phase, .lunch)
    }

    // MARK: 边界

    func testZeroLengthShiftDoesNotCrash() {
        let e = engine { $0.workStart = 9 * 60; $0.workEnd = 9 * 60 }
        let s = e.snapshot(at: t(2026, 11, 17, 12))
        XCTAssertEqual(s.perSecond, 0)
        XCTAssertFalse(s.earnedToday.isNaN)
    }

    func testLunchClampedToShift() {
        let e = engine { $0.lunchStart = 17 * 60; $0.lunchEnd = 19 * 60 }
        XCTAssertEqual(e.shift(on: t(2026, 11, 17)).effectiveSeconds, 8 * 3600)
        let swallowed = engine { $0.lunchStart = 8 * 60; $0.lunchEnd = 19 * 60 }
        XCTAssertEqual(swallowed.shift(on: t(2026, 11, 17)).effectiveSeconds, 0)
        XCTAssertEqual(swallowed.snapshot(at: t(2026, 11, 17, 12)).perSecond, 0)
    }

    func testDayKeyEarlyMorningUsesLocalDate() {
        XCTAssertEqual(DayKey.key(t(2026, 11, 17, 7), calendar: cal), "2026-11-17")
        XCTAssertEqual(DayKey.key(t(2026, 11, 17, 0, 0, 1), calendar: cal), "2026-11-17")
    }

    // MARK: 手动标记 / 导入 / 大小周

    func testManualMarksPrecedence() {
        let e = engine {
            $0.manualMarks = [
                ManualMark(date: "2026-11-18", kind: .paidLeave, note: "年假"),
                ManualMark(date: "2026-11-20", kind: .rest),
                ManualMark(date: "2026-11-21", kind: .work),
                ManualMark(date: "2026-10-01", kind: .work, note: "值班"),
            ]
        }
        // 21 - 1(休息) + 1(周六上班)；带薪假照算
        XCTAssertEqual(e.workCalendar.paidDays(inMonthOf: t(2026, 11, 1)).count, 21)
        let leave = e.snapshot(at: t(2026, 11, 18, 10))
        XCTAssertEqual(leave.phase, .paidLeave)
        XCTAssertEqual(leave.earnedToday, leave.dailyWage, accuracy: 1e-9)
        XCTAssertEqual(StatusText.make(leave, settings: AppSettings(), boss: false).prefix, "带薪假")
        XCTAssertEqual(e.workCalendar.info(for: t(2026, 10, 1)).kind, .manualWork)
        XCTAssertEqual(e.workCalendar.paidDays(inMonthOf: t(2026, 10, 1)).count, 19)
    }

    func testImportedOverridesBuiltin() {
        let e = engine { $0.importedHolidays = [HolidayEntry(date: "2026-10-07", type: .workday, name: "测试")] }
        XCTAssertEqual(e.workCalendar.info(for: t(2026, 10, 7)).kind, .makeupWorkday)
        let m = engine { $0.importedHolidays = [HolidayEntry(date: "2026-10-07", type: .workday, name: "x")]
                         $0.manualMarks = [ManualMark(date: "2026-10-07", kind: .rest)] }
        XCTAssertEqual(m.workCalendar.info(for: t(2026, 10, 7)).kind, .manualRest)
    }

    func testImportParsing() throws {
        let json = #"[{"date":"2028-01-01","type":"holiday","name":"元旦"},{"date":"2028-02-30","type":"holiday","name":"坏"},{"date":"2028-01-02","type":"workday","name":"元旦"}]"#
        let list = try HolidayImport.parse(Data(json.utf8))
        XCTAssertEqual(list.map(\.date), ["2028-01-01", "2028-01-02"])
    }

    func testBigSmallWeek() {
        let e = engine { $0.bigSmallWeek = true; $0.bigWeekAnchor = "2026-11-16" }
        XCTAssertEqual(e.workCalendar.info(for: t(2026, 11, 21)).kind, .workday)
        XCTAssertEqual(e.workCalendar.info(for: t(2026, 11, 28)).kind, .weekend)
        XCTAssertEqual(e.workCalendar.info(for: t(2026, 12, 5)).kind, .workday)
        XCTAssertEqual(e.workCalendar.info(for: t(2026, 11, 14)).kind, .weekend)
        XCTAssertEqual(e.workCalendar.info(for: t(2026, 11, 22)).kind, .weekend)
    }

    func testBigSmallWeekToggleWithoutAnchor() {
        var s = AppSettings()
        s.setBigSmallWeek(true, today: t(2026, 11, 17, 10), calendar: cal)
        XCTAssertEqual(s.bigWeekAnchor, "2026-11-16")
        let e = WageEngine(settings: s, calendar: cal)
        XCTAssertEqual(e.workCalendar.info(for: t(2026, 11, 21)).kind, .workday)
        XCTAssertEqual(e.workCalendar.paidDays(inMonthOf: t(2026, 11, 1)).count, 23) // 11/7、11/21 两个大周六
        // 关掉再打开不改已有的设定
        s.setBigSmallWeek(false, today: t(2026, 11, 17), calendar: cal)
        s.setBigSmallWeek(true, today: t(2026, 11, 24), calendar: cal)
        XCTAssertEqual(s.bigWeekAnchor, "2026-11-16")
    }

    // MARK: 菜单栏文字

    func testStatusLines() {
        let e = engine()
        let working = e.snapshot(at: t(2026, 11, 17, 15, 18, 42))
        var s = AppSettings()
        XCTAssertEqual(StatusText.make(working, settings: s, boss: false).main, "¥611.01")
        XCTAssertEqual(StatusText.make(working, settings: s, boss: true).main, "¥***.**")
        s.menuBarFormat = .amountProgress
        XCTAssertEqual(StatusText.make(working, settings: s, boss: false).main, "¥611 · 64%")
        s.menuBarFormat = .amountCountdown
        XCTAssertEqual(StatusText.make(working, settings: s, boss: false).main, "¥611.01 · 2:41:18")
        s.menuBarFormat = .iconOnly
        let icon = StatusText.make(working, settings: s, boss: false)
        XCTAssertEqual(icon.main, "")
        XCTAssertTrue(icon.forceIcon)

        let lunch = StatusText.make(e.snapshot(at: t(2026, 11, 17, 12, 40)), settings: AppSettings(), boss: false)
        XCTAssertEqual(lunch.prefix, "干饭中")
        let after = StatusText.make(e.snapshot(at: t(2026, 11, 17, 18, 30)), settings: AppSettings(), boss: false)
        XCTAssertTrue(after.check)
        let makeup = StatusText.make(e.snapshot(at: t(2026, 10, 10, 15)), settings: AppSettings(), boss: false)
        XCTAssertEqual(makeup.badge, "班")
        let weekend = StatusText.make(e.snapshot(at: t(2026, 11, 21, 10)), settings: AppSettings(), boss: false)
        XCTAssertEqual(weekend.main, "休息")
        var quiet = AppSettings(); quiet.offHoursDisplay = .iconOnly
        XCTAssertTrue(StatusText.make(e.snapshot(at: t(2026, 11, 21, 10)), settings: quiet, boss: false).forceIcon)
    }

    // MARK: 里程碑

    func testMilestones() {
        let s = engine().snapshot(at: t(2026, 11, 17, 15, 18, 42))
        let m = Milestones.status(s, list: Milestone.defaults)
        XCTAssertEqual(m.reached?.name, "一顿火锅")
        XCTAssertEqual(m.next?.name, "一顿日料")
        XCTAssertEqual(money(m.remaining), "¥188.99")
        XCTAssertEqual(Duration.words(m.eta!), "1 小时 30 分")
        XCTAssertEqual(Milestones.crossed(from: 10, to: 35, list: Milestone.defaults).map(\.name), ["一杯奶茶", "一份外卖"])
        XCTAssertEqual(Milestones.parse("奶茶，15\n坏行\n火锅, 150"), [Milestone(name: "奶茶", amount: 15), Milestone(name: "火锅", amount: 150)])
    }

    // MARK: 设置兼容

    func testSettingsDecodeWithMissingKeys() throws {
        let s = try JSONDecoder().decode(AppSettings.self, from: Data(#"{"amount":30000,"menuBarFormat":"nonsense"}"#.utf8))
        XCTAssertEqual(s.amount, 30000)
        XCTAssertEqual(s.menuBarFormat, .amountOnly)
        XCTAssertEqual(s.workWeekdays, [2, 3, 4, 5, 6])
        let round = try JSONDecoder().decode(AppSettings.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(round, s)
    }
}
