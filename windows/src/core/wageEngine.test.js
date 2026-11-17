'use strict';

// 必须在最顶部固定东八区时区，确保本地日历测试在不同宿主环境具有确定性
process.env.TZ = 'Asia/Shanghai';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const core = require('./index');
const {
  IncomeType,
  WageBasis,
  MenuBarFormat,
  OffHoursDisplay,
  BossHotkey,
  ManualKind,
  HolidayEntryType,
  BOSS_HOTKEY_LABELS,
  BOSS_HOTKEY_ACCELERATORS,
  BossHotkeyMeta,
  DEFAULT_MILESTONES,
  defaultSettings,
  decodeSettings,
  parseSettingsJson,
  monthlyAmount,
  setBigSmallWeek,
  setMark,
  parseHolidayImport,
  mergeHolidayImport,
  DayKey,
  BuiltinHolidays,
  DayKind,
  Phase,
  WorkCalendar,
  WageEngine,
  serializeSnapshot,
  Money,
  Duration,
  StatusText,
  Milestones,
  Quotes,
  formatDayLine,
  kindLabel,
  formatMinutes,
  formatAmount,
  panelSubline,
  milestoneSummary,
} = core;

/**
 * 构造东八区本地时间 Date 实例。
 */
function t(y, mo, d, h = 0, mi = 0, s = 0) {
  return new Date(y, mo - 1, d, h, mi, s, 0);
}

/**
 * 使用可选修改回调创建 WageEngine 实例。
 */
function makeEngine(edit = () => {}) {
  const s = defaultSettings();
  edit(s);
  return new WageEngine(s);
}

/**
 * 默认人民币两位小数格式化快捷函数。
 */
function money(v) {
  return new Money('¥', 2).string(v);
}

/**
 * 浮点数容差断言。
 */
function assertApprox(actual, expected, tol = 1e-9, message) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    message || `期望 ${actual} 接近 ${expected}（容差 ${tol}）`
  );
}

describe('WageEngineTests 1:1 移植（22 项核心用例）', () => {
  test('01 testPaidDayCounts: 2026–2027 各月计薪日数', () => {
    const e = makeEngine();
    const y2026 = [21, 16, 22, 21, 19, 21, 23, 21, 22, 18, 21, 23];
    const y2027 = [21, 15, 23, 21, 19, 21, 22, 22, 22, 17, 22, 23];
    for (let m = 1; m <= 12; m += 1) {
      assert.strictEqual(
        e.workCalendar.paidDays(t(2026, m, 1)).length,
        y2026[m - 1],
        `2026-${m}`
      );
      assert.strictEqual(
        e.workCalendar.paidDays(t(2027, m, 1)).length,
        y2027[m - 1],
        `2027-${m}`
      );
    }
  });

  test('02 testDesignNov17Working: 设计稿 2026-11-17 15:18:42 计薪数字', () => {
    const s = makeEngine().snapshot(t(2026, 11, 17, 15, 18, 42));
    assert.strictEqual(s.phase, Phase.working);
    assert.strictEqual(money(s.dailyWage), '¥952.38');
    assert.strictEqual(money(s.earnedToday), '¥611.01');
    assert.strictEqual(money(s.hourly), '¥126.98');
    assert.strictEqual(s.perSecond.toFixed(4), '0.0353');
    assert.strictEqual(Math.trunc(s.progress * 100), 64);
    assert.strictEqual(Duration.clock(s.secondsToEnd), '2:41:18');
    assert.strictEqual(s.paidDayIndex, 12);
    assert.strictEqual(s.paidDaysInMonth, 21);
    assert.strictEqual(money(s.monthTotal), '¥11,087.20');
  });

  test('03 testDesignLunch: 午休阶段金额冻结', () => {
    const e = makeEngine();
    const s = e.snapshot(t(2026, 11, 17, 12, 40));
    assert.strictEqual(s.phase, Phase.lunch);
    assert.strictEqual(money(s.earnedToday), '¥380.95');
    const later = e.snapshot(t(2026, 11, 17, 13, 29, 59));
    assertApprox(s.earnedToday, later.earnedToday, 1e-9);
  });

  test('04 testBeforeAndAfterWork: 上班前与下班后阶段', () => {
    const e = makeEngine();
    const before = e.snapshot(t(2026, 11, 17, 8, 30));
    assert.strictEqual(before.phase, Phase.beforeWork);
    assert.strictEqual(before.earnedToday, 0);
    assert.strictEqual(before.secondsToStart, 1800);

    const after = e.snapshot(t(2026, 11, 17, 18, 30));
    assert.strictEqual(after.phase, Phase.afterWork);
    assert.strictEqual(money(after.earnedToday), '¥952.38');
    assertApprox(after.progress, 1, 1e-9);
  });

  test('05 testDesignOctMakeupDay: 2026-10-10 国庆调休补班', () => {
    const s = makeEngine().snapshot(t(2026, 10, 10, 15, 18, 42));
    assert.strictEqual(s.day.kind, DayKind.makeupWorkday);
    assert.strictEqual(s.paidDaysInMonth, 18);
    assert.strictEqual(money(s.dailyWage), '¥1,111.11');
    assert.strictEqual(money(s.earnedToday), '¥712.84');
  });

  test('06 testHolidayRest: 2026-10-02 国庆假期休息', () => {
    const s = makeEngine().snapshot(t(2026, 10, 2, 10));
    assert.strictEqual(s.phase, Phase.rest);
    assert.strictEqual(s.day.kind, DayKind.holiday);
    assert.strictEqual(s.day.name, '国庆');
    assert.strictEqual(s.earnedToday, 0);
    assert.strictEqual(StatusText.make(s, defaultSettings(), false).main, '国庆休息');
  });

  test('07 testMonthTotalEqualsSalaryOnLastPaidDay: 月末最后一个计薪日凑满月薪', () => {
    const e = makeEngine();
    const s = e.snapshot(t(2026, 11, 30, 19));
    assert.strictEqual(s.paidDayIndex, 21);
    assertApprox(s.monthTotal, 20000, 1e-6);
    assert.strictEqual(money(s.monthTotal), '¥20,000.00');

    const f = e.snapshot(t(2027, 2, 26, 23));
    assertApprox(f.monthTotal, 20000, 1e-6);
  });

  test('08 testFixed2175: 固定 21.75 天计薪基准', () => {
    const s = makeEngine((st) => {
      st.basis = WageBasis.fixed2175;
    }).snapshot(t(2026, 11, 17, 18, 30));
    assert.strictEqual(money(s.dailyWage), '¥919.54');
  });

  test('09 testYearlyAndHourly: 年薪与时薪口径', () => {
    const y = makeEngine((st) => {
      st.incomeType = IncomeType.yearly;
      st.amount = 240000;
    }).snapshot(t(2026, 11, 17, 18, 30));
    assert.strictEqual(money(y.dailyWage), '¥952.38');

    const h = makeEngine((st) => {
      st.incomeType = IncomeType.hourly;
      st.amount = 100;
    }).snapshot(t(2026, 11, 17, 15, 18, 42));
    assertApprox(h.dailyWage, 750, 1e-9);
    assertApprox(h.hourly, 100, 1e-9);
  });

  test('10 testOvernightShift: 跨夜班归属开始日与跨月计薪', () => {
    const e = makeEngine((st) => {
      st.workStart = 22 * 60;
      st.workEnd = 6 * 60;
      st.lunchEnabled = false;
    });

    const a = e.snapshot(t(2026, 11, 17, 23));
    assert.strictEqual(a.shiftDay.getTime(), t(2026, 11, 17).getTime());
    assert.strictEqual(a.phase, Phase.working);
    assertApprox(a.progress, 1.0 / 8, 1e-9);

    const b = e.snapshot(t(2026, 11, 18, 2));
    assert.strictEqual(b.shiftDay.getTime(), t(2026, 11, 17).getTime());
    assertApprox(b.progress, 4.0 / 8, 1e-9);

    const c = e.snapshot(t(2026, 11, 18, 7));
    assert.strictEqual(c.shiftDay.getTime(), t(2026, 11, 18).getTime());
    assert.strictEqual(c.phase, Phase.beforeWork);

    const d = e.snapshot(t(2026, 12, 1, 2));
    assert.strictEqual(d.shiftDay.getTime(), t(2026, 11, 30).getTime());
    assert.strictEqual(d.paidDaysInMonth, 21);
    assert.strictEqual(d.paidDayIndex, 21);
  });

  test('11 testOvernightWithLunchAfterMidnight: 跨夜班叠加跨午夜午休', () => {
    const e = makeEngine((st) => {
      st.workStart = 22 * 60;
      st.workEnd = 7 * 60;
      st.lunchStart = 2 * 60;
      st.lunchEnd = 3 * 60;
    });
    const sh = e.shift(t(2026, 11, 17));
    assert.strictEqual(sh.effectiveSeconds, 8 * 3600);
    assert.strictEqual(sh.lunchStart.getTime(), t(2026, 11, 18, 2).getTime());
    assert.strictEqual(e.snapshot(t(2026, 11, 18, 2, 30)).phase, Phase.lunch);
  });

  test('12 testZeroLengthShiftDoesNotCrash: 零时长班次不产生 NaN', () => {
    const e = makeEngine((st) => {
      st.workStart = 9 * 60;
      st.workEnd = 9 * 60;
    });
    const s = e.snapshot(t(2026, 11, 17, 12));
    assert.strictEqual(s.perSecond, 0);
    assert.ok(!Number.isNaN(s.earnedToday));
  });

  test('13 testLunchClampedToShift: 午休钳位与吞没全班次', () => {
    const e = makeEngine((st) => {
      st.lunchStart = 17 * 60;
      st.lunchEnd = 19 * 60;
    });
    assert.strictEqual(e.shift(t(2026, 11, 17)).effectiveSeconds, 8 * 3600);

    const swallowed = makeEngine((st) => {
      st.lunchStart = 8 * 60;
      st.lunchEnd = 19 * 60;
    });
    assert.strictEqual(swallowed.shift(t(2026, 11, 17)).effectiveSeconds, 0);
    assert.strictEqual(swallowed.snapshot(t(2026, 11, 17, 12)).perSecond, 0);
  });

  test('14 testDayKeyEarlyMorningUsesLocalDate: 东八区凌晨使用本地日期', () => {
    assert.strictEqual(DayKey.key(t(2026, 11, 17, 7)), '2026-11-17');
    assert.strictEqual(DayKey.key(t(2026, 11, 17, 0, 0, 1)), '2026-11-17');
  });

  test('15 testManualMarksPrecedence: 手动标记与带薪假优先级', () => {
    const e = makeEngine((st) => {
      st.manualMarks = [
        { date: '2026-11-18', kind: ManualKind.paidLeave, note: '年假' },
        { date: '2026-11-20', kind: ManualKind.rest, note: '' },
        { date: '2026-11-21', kind: ManualKind.work, note: '' },
        { date: '2026-10-01', kind: ManualKind.work, note: '值班' },
      ];
    });
    assert.strictEqual(e.workCalendar.paidDays(t(2026, 11, 1)).length, 21);

    const leave = e.snapshot(t(2026, 11, 18, 10));
    assert.strictEqual(leave.phase, Phase.paidLeave);
    assertApprox(leave.earnedToday, leave.dailyWage, 1e-9);
    assert.strictEqual(StatusText.make(leave, defaultSettings(), false).prefix, '带薪假');
    assert.strictEqual(e.workCalendar.info(t(2026, 10, 1)).kind, DayKind.manualWork);
    assert.strictEqual(e.workCalendar.paidDays(t(2026, 10, 1)).length, 19);
  });

  test('16 testImportedOverridesBuiltin: 导入覆盖内置且手动覆盖导入', () => {
    const e = makeEngine((st) => {
      st.importedHolidays = [{ date: '2026-10-07', type: HolidayEntryType.workday, name: '测试' }];
    });
    assert.strictEqual(e.workCalendar.info(t(2026, 10, 7)).kind, DayKind.makeupWorkday);

    const m = makeEngine((st) => {
      st.importedHolidays = [{ date: '2026-10-07', type: HolidayEntryType.workday, name: 'x' }];
      st.manualMarks = [{ date: '2026-10-07', kind: ManualKind.rest, note: '' }];
    });
    assert.strictEqual(m.workCalendar.info(t(2026, 10, 7)).kind, DayKind.manualRest);
  });

  test('17 testImportParsing: 节假日导入自动过滤无效日期', () => {
    const json =
      '[{"date":"2028-01-01","type":"holiday","name":"元旦"},{"date":"2028-02-30","type":"holiday","name":"坏"},{"date":"2028-01-02","type":"workday","name":"元旦"}]';
    const list = parseHolidayImport(json);
    assert.deepStrictEqual(
      list.map((item) => item.date),
      ['2028-01-01', '2028-01-02']
    );
  });

  test('18 testBigSmallWeek: 大小周单双周周六判定', () => {
    const e = makeEngine((st) => {
      st.bigSmallWeek = true;
      st.bigWeekAnchor = '2026-11-16';
    });
    assert.strictEqual(e.workCalendar.info(t(2026, 11, 21)).kind, DayKind.workday);
    assert.strictEqual(e.workCalendar.info(t(2026, 11, 21)).name, '大周');
    assert.strictEqual(e.workCalendar.info(t(2026, 11, 28)).kind, DayKind.weekend);
    assert.strictEqual(e.workCalendar.info(t(2026, 12, 5)).kind, DayKind.workday);
    assert.strictEqual(e.workCalendar.info(t(2026, 11, 14)).kind, DayKind.weekend);
    assert.strictEqual(e.workCalendar.info(t(2026, 11, 22)).kind, DayKind.weekend);
  });

  test('19 testBigSmallWeekToggleWithoutAnchor: 开关大小周自动设定且不覆盖已有锚点', () => {
    let s = defaultSettings();
    s = setBigSmallWeek(s, true, t(2026, 11, 17, 10));
    assert.strictEqual(s.bigWeekAnchor, '2026-11-16');

    const e = new WageEngine(s);
    assert.strictEqual(e.workCalendar.info(t(2026, 11, 21)).kind, DayKind.workday);
    assert.strictEqual(e.workCalendar.paidDays(t(2026, 11, 1)).length, 23);

    s = setBigSmallWeek(s, false, t(2026, 11, 17));
    s = setBigSmallWeek(s, true, t(2026, 11, 24));
    assert.strictEqual(s.bigWeekAnchor, '2026-11-16');
  });

  test('20 testStatusLines: 状态栏文案各格式与阶段组合', () => {
    const e = makeEngine();
    const working = e.snapshot(t(2026, 11, 17, 15, 18, 42));
    const s = defaultSettings();

    assert.strictEqual(StatusText.make(working, s, false).main, '¥611.01');
    assert.strictEqual(StatusText.make(working, s, true).main, '¥***.**');

    s.menuBarFormat = MenuBarFormat.amountProgress;
    assert.strictEqual(StatusText.make(working, s, false).main, '¥611 · 64%');

    s.menuBarFormat = MenuBarFormat.amountCountdown;
    assert.strictEqual(StatusText.make(working, s, false).main, '¥611.01 · 2:41:18');

    s.menuBarFormat = MenuBarFormat.iconOnly;
    const icon = StatusText.make(working, s, false);
    assert.strictEqual(icon.main, '');
    assert.strictEqual(icon.forceIcon, true);

    const lunch = StatusText.make(e.snapshot(t(2026, 11, 17, 12, 40)), defaultSettings(), false);
    assert.strictEqual(lunch.prefix, '干饭中');

    const after = StatusText.make(e.snapshot(t(2026, 11, 17, 18, 30)), defaultSettings(), false);
    assert.strictEqual(after.check, true);

    const makeup = StatusText.make(e.snapshot(t(2026, 10, 10, 15)), defaultSettings(), false);
    assert.strictEqual(makeup.badge, '班');

    const weekend = StatusText.make(e.snapshot(t(2026, 11, 21, 10)), defaultSettings(), false);
    assert.strictEqual(weekend.main, '休息');

    const quiet = defaultSettings();
    quiet.offHoursDisplay = OffHoursDisplay.iconOnly;
    assert.strictEqual(
      StatusText.make(e.snapshot(t(2026, 11, 21, 10)), quiet, false).forceIcon,
      true
    );
  });

  test('21 testMilestones: 里程碑状态、跨越检测与文本解析', () => {
    const s = makeEngine().snapshot(t(2026, 11, 17, 15, 18, 42));
    const m = Milestones.status(s, DEFAULT_MILESTONES);
    assert.strictEqual(m.reached.name, '一顿火锅');
    assert.strictEqual(m.next.name, '一顿日料');
    assert.strictEqual(money(m.remaining), '¥188.99');
    assert.strictEqual(Duration.words(m.eta), '1 小时 30 分');

    assert.deepStrictEqual(
      Milestones.crossed(10, 35, DEFAULT_MILESTONES).map((item) => item.name),
      ['一杯奶茶', '一份外卖']
    );
    assert.deepStrictEqual(Milestones.parse('奶茶，15\n坏行\n火锅, 150'), [
      { name: '奶茶', amount: 15 },
      { name: '火锅', amount: 150 },
    ]);
  });

  test('22 testSettingsDecodeWithMissingKeys: 缺字段与坏枚举容错解码及往返', () => {
    const s = parseSettingsJson('{"amount":30000,"menuBarFormat":"nonsense"}');
    assert.strictEqual(s.amount, 30000);
    assert.strictEqual(s.menuBarFormat, MenuBarFormat.amountOnly);
    assert.deepStrictEqual(s.workWeekdays, [2, 3, 4, 5, 6]);

    const round = parseSettingsJson(JSON.stringify(s));
    assert.deepStrictEqual(round, s);
  });
});

describe('额外边界与契约校验（DayKey / Settings / Money / Duration / StatusText / Milestones / Quotes / IPC）', () => {
  test('BuiltinHolidays: 2026–2027 共 73 条且无重叠日期', () => {
    assert.deepStrictEqual(BuiltinHolidays.years, [2026, 2027]);
    assert.strictEqual(BuiltinHolidays.entries.length, 73);
    const uniqueDates = new Set(BuiltinHolidays.entries.map((e) => e.date));
    assert.strictEqual(uniqueDates.size, 73);
    assert.ok(Object.isFrozen(BuiltinHolidays));
    assert.ok(Object.isFrozen(BuiltinHolidays.entries));
  });

  test('DayKey 边界：闰年、两位年份、非补零格式与区间展开', () => {
    assert.strictEqual(DayKey.isValid('2024-02-29'), true);
    assert.strictEqual(DayKey.isValid('2000-02-29'), true);
    assert.strictEqual(DayKey.isValid('2025-02-29'), false);
    assert.strictEqual(DayKey.isValid('2026-02-29'), false);
    assert.strictEqual(DayKey.isValid('2100-02-29'), false);
    assert.strictEqual(DayKey.isValid('2028-02-30'), false);
    assert.strictEqual(DayKey.isValid('2026-04-31'), false);
    assert.strictEqual(DayKey.isValid('26-01-01'), false);
    assert.strictEqual(DayKey.isValid('2026-1-1'), false);
    assert.strictEqual(DayKey.isValid('2026-11-17abc'), false);
    assert.strictEqual(DayKey.isValid('0099-02-28'), true);
    assert.strictEqual(DayKey.isValid('0099-02-29'), false);

    assert.deepStrictEqual(DayKey.range('2026-02-27', '2026-03-01'), [
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ]);
    assert.deepStrictEqual(DayKey.range('2026-03-02', '2026-03-01'), []);
    assert.deepStrictEqual(DayKey.range('2026-02-29', '2026-03-01'), []);

    const local = DayKey.toLocalDate('2026-11-17');
    assert.strictEqual(local.getTime(), t(2026, 11, 17).getTime());
    assert.strictEqual(DayKey.toLocalDate('2026-02-29'), null);
  });

  test('Settings 容错、空数组保留、bossHotkey 别名、setMark 与导入合并', () => {
    const a = defaultSettings();
    const b = defaultSettings();
    a.workWeekdays.push(1);
    a.milestones.push({ name: 'test', amount: 1 });
    assert.deepStrictEqual(b.workWeekdays, [2, 3, 4, 5, 6]);
    assert.strictEqual(b.milestones.length, 6);

    // 合法空数组必须保留，不能回落默认值
    const emptyDays = decodeSettings({ workWeekdays: [], milestones: [] });
    assert.deepStrictEqual(emptyDays.workWeekdays, []);
    assert.deepStrictEqual(emptyDays.milestones, []);

    // 非法元素回落默认
    const badDays = decodeSettings({ workWeekdays: [2, 9] });
    assert.deepStrictEqual(badDays.workWeekdays, [2, 3, 4, 5, 6]);

    // 坏 JSON 字符串回落默认
    assert.deepStrictEqual(parseSettingsJson('{bad json'), defaultSettings());

    // bossHotkey 别名归一化与 Windows 元数据
    assert.strictEqual(decodeSettings({ bossHotkey: 'ctrlAltB' }).bossHotkey, BossHotkey.ctrlOptB);
    assert.strictEqual(
      decodeSettings({ bossHotkey: 'CommandOrControl+Alt+H' }).bossHotkey,
      BossHotkey.ctrlOptCmdH
    );
    assert.strictEqual(decodeSettings({ bossHotkey: 'Ctrl+Alt+B' }).bossHotkey, BossHotkey.ctrlOptB);
    assert.strictEqual(decodeSettings({ bossHotkey: '不使用' }).bossHotkey, BossHotkey.off);
    assert.strictEqual(decodeSettings({ bossHotkey: 'invalid' }).bossHotkey, BossHotkey.ctrlOptB);
    assert.strictEqual(BOSS_HOTKEY_LABELS[BossHotkey.ctrlOptB], 'Ctrl+Alt+B');
    assert.strictEqual(
      BOSS_HOTKEY_ACCELERATORS[BossHotkey.ctrlOptCmdH],
      'CommandOrControl+Alt+H'
    );
    assert.strictEqual(BossHotkeyMeta.off.accelerator, null);

    // monthlyAmount
    assert.strictEqual(monthlyAmount({ incomeType: IncomeType.monthly, amount: 15000 }), 15000);
    assert.strictEqual(monthlyAmount({ incomeType: IncomeType.yearly, amount: 120000 }), 10000);
    assert.strictEqual(monthlyAmount({ incomeType: IncomeType.hourly, amount: 100 }), 0);

    // setMark 纯函数增改删与 ASCII 排序
    let s1 = setMark(defaultSettings(), { kind: ManualKind.work, note: '加班' }, '2026-11-21');
    s1 = setMark(s1, { kind: ManualKind.rest, note: '' }, '2026-11-10');
    assert.deepStrictEqual(
      s1.manualMarks.map((m) => m.date),
      ['2026-11-10', '2026-11-21']
    );
    const s2 = setMark(s1, null, '2026-11-10');
    assert.deepStrictEqual(
      s2.manualMarks.map((m) => m.date),
      ['2026-11-21']
    );
    assert.strictEqual(s1.manualMarks.length, 2);

    // parseHolidayImport 错误抛出与 mergeHolidayImport 覆盖排序
    assert.throws(() => parseHolidayImport('not json'));
    assert.throws(() => parseHolidayImport('{}'));
    assert.throws(() => parseHolidayImport('[{"date":"2028-01-01","type":"bad","name":"x"}]'));
    assert.throws(() => parseHolidayImport('[{"date":"2028-01-01","type":"holiday"}]'));

    const merged = mergeHolidayImport(
      [
        { date: '2028-05-01', type: HolidayEntryType.holiday, name: '旧劳动节' },
        { date: '2028-01-01', type: HolidayEntryType.holiday, name: '元旦' },
      ],
      [{ date: '2028-05-01', type: HolidayEntryType.workday, name: '新覆盖' }]
    );
    assert.deepStrictEqual(merged, [
      { date: '2028-01-01', type: HolidayEntryType.holiday, name: '元旦' },
      { date: '2028-05-01', type: HolidayEntryType.workday, name: '新覆盖' },
    ]);
  });

  test('Money halfUp 舍入、负零防御、小数位钳位与遮罩', () => {
    const m = new Money(defaultSettings());
    assert.strictEqual(m.string(0.005), '¥0.01');
    assert.strictEqual(m.string(1.005), '¥1.01');
    assert.strictEqual(m.string(2.675), '¥2.68');
    assert.strictEqual(m.string(611.005), '¥611.01');
    assert.strictEqual(m.string(11087.195), '¥11,087.20');
    assert.strictEqual(m.string(0.03525, 4), '¥0.0353');
    assert.strictEqual(m.string(-0), '¥0.00');
    assert.strictEqual(m.string(-0.001), '¥0.00');
    assert.strictEqual(m.string(Number.NaN), '¥0');
    assert.strictEqual(m.string(Number.POSITIVE_INFINITY), '¥0');
    assert.strictEqual(m.masked, '¥***.**');

    assert.strictEqual(new Money('¥', -2).decimals, 0);
    assert.strictEqual(new Money('¥', -2).masked, '¥***');
    assert.strictEqual(new Money('¥', 8).decimals, 4);
    assert.strictEqual(new Money('¥', 8).masked, '¥***.****');
  });

  test('Duration.words 进位边界', () => {
    assert.strictEqual(Duration.words(0), '0 分钟');
    assert.strictEqual(Duration.words(-10), '0 分钟');
    assert.strictEqual(Duration.words(1), '1 分钟');
    assert.strictEqual(Duration.words(3540), '59 分钟');
    assert.strictEqual(Duration.words(3599), '1 小时');
    assert.strictEqual(Duration.words(3600), '1 小时');
    assert.strictEqual(Duration.words(3601), '1 小时 1 分');
    assert.strictEqual(Duration.clock(-5), '0:00:00');
  });

  test('StatusText 老板模式、补班徽标与可枚举属性检查', () => {
    const e = makeEngine();
    const working = e.snapshot(t(2026, 11, 17, 15, 18, 42));
    const sProg = defaultSettings();
    sProg.menuBarFormat = MenuBarFormat.amountProgress;
    const bossProg = StatusText.make(working, sProg, true);
    assert.strictEqual(bossProg.main, '¥*** · 64%');
    assert.strictEqual(bossProg.plainText, '¥*** · 64%');

    const before = e.snapshot(t(2026, 11, 17, 8, 30));
    const sCount = defaultSettings();
    sCount.menuBarFormat = MenuBarFormat.amountCountdown;
    assert.strictEqual(StatusText.make(before, sCount, false).main, '¥0.00');

    const makeupAfter = e.snapshot(t(2026, 10, 10, 19));
    const makeupLine = StatusText.make(makeupAfter, defaultSettings(), false);
    assert.strictEqual(makeupLine.plainText, '班 ¥1,111.11 ✓');
    assert.ok(Object.keys(makeupLine).includes('plainText'));

    const dayInfo = e.workCalendar.info(t(2026, 10, 10));
    assert.ok(Object.keys(dayInfo).includes('isPaid'));
    assert.ok(Object.keys(dayInfo).includes('accrues'));

    const leaveEngine = makeEngine((st) => {
      st.manualMarks = [{ date: '2026-11-18', kind: ManualKind.paidLeave, note: '年假' }];
    });
    const leaveSnap = leaveEngine.snapshot(t(2026, 11, 18, 10));
    const leaveBoss = StatusText.make(leaveSnap, defaultSettings(), true);
    assert.strictEqual(leaveBoss.prefix, '带薪假');
    assert.strictEqual(leaveBoss.main, '¥***.**');
    assert.strictEqual(leaveBoss.badge, null);
  });

  test('Milestones 解析极端输入、全解锁、够不着与下班 eta 为 null', () => {
    assert.deepStrictEqual(
      Milestones.parse('\n,15\r\n奶茶,\n奶茶,0\n奶茶,-5\n奶茶,Infinity\n咖啡, 20.5\n'),
      [{ name: '咖啡', amount: 20.5 }]
    );
    assert.strictEqual(
      Milestones.format([
        { name: '奶茶', amount: 15 },
        { name: '咖啡', amount: 20.5 },
      ]),
      '奶茶,15\n咖啡,20.5'
    );

    const e = makeEngine();
    const after = e.snapshot(t(2026, 11, 17, 19));
    const afterStatus = Milestones.status(after, DEFAULT_MILESTONES);
    assert.strictEqual(afterStatus.reached.name, '一顿日料');
    assert.strictEqual(afterStatus.next.name, '一双球鞋');
    assert.strictEqual(afterStatus.eta, null);

    const unreachable = Milestones.status(e.snapshot(t(2026, 11, 17, 15, 18, 42)), [
      { name: '买车', amount: 200000 },
    ]);
    assert.strictEqual(unreachable.eta, null);

    const allDone = Milestones.status(after, [{ name: '奶茶', amount: 15 }]);
    assert.strictEqual(allDone.next, null);
    assert.strictEqual(allDone.remaining, 0);
    assert.strictEqual(allDone.eta, null);
  });

  test('Quotes 年积日与 24 小时遍历、闰年及 epoch ms 兼容', () => {
    assert.strictEqual(Quotes.all.length, 12);
    assert.strictEqual(Quotes.forDate(t(2026, 1, 1, 0)), Quotes.all[0]);
    // 2024 闰年 12-31 为第 366 天：(366 * 24 + 23) % 12 = 11
    assert.strictEqual(Quotes.forDate(t(2024, 12, 31, 23)), Quotes.all[11]);

    const seen = new Set();
    for (let h = 0; h < 24; h += 1) {
      seen.add(Quotes.forDate(t(2026, 11, 17, h)));
    }
    assert.strictEqual(seen.size, 12);

    const ms = t(2026, 11, 17, 15, 18, 42).getTime();
    assert.strictEqual(Quotes.forDate(ms), Quotes.forDate(new Date(ms)));
  });

  test('formatDayLine / kindLabel / panelSubline / milestoneSummary / serializeSnapshot 与大小周跨年', () => {
    const e = makeEngine((st) => {
      st.bigSmallWeek = true;
      st.bigWeekAnchor = '2026-11-16';
    });
    // 验证向过去与跨年（负周差）大小周奇偶正确
    assert.strictEqual(e.workCalendar.info(t(2026, 11, 7)).name, '大周');
    assert.strictEqual(e.workCalendar.info(t(2027, 1, 2)).kind, DayKind.holiday); // 元旦优先于大周
    assert.strictEqual(e.workCalendar.info(t(2027, 1, 16)).name, '大周'); // 距 2026-11-16 为 8 周? 11/16->1/11=8周 偶数周=>大周(1/16)；1/9为第7周=>周末
    assert.strictEqual(e.workCalendar.info(t(2027, 1, 9)).kind, DayKind.weekend);

    const snapBigSat = e.snapshot(t(2026, 11, 21, 10));
    assert.strictEqual(kindLabel(snapBigSat.day), '大周周六');
    assert.strictEqual(formatDayLine(snapBigSat), '11月21日 周六 · 大周周六');

    const serialized = serializeSnapshot(snapBigSat);
    assert.strictEqual(typeof serialized.now, 'number');
    assert.strictEqual(typeof serialized.shiftDay, 'number');
    assert.strictEqual(typeof serialized.shift.start, 'number');
    assert.strictEqual(formatDayLine(serialized), '11月21日 周六 · 大周周六');

    const workSnap = makeEngine().snapshot(t(2026, 11, 17, 15, 18, 42));
    assert.strictEqual(
      panelSubline(workSnap, defaultSettings(), false),
      '每秒 +¥0.0353，继续涨'
    );
    assert.strictEqual(
      panelSubline(workSnap, defaultSettings(), true),
      '每秒 +¥***.****，继续涨'
    );
    assert.strictEqual(formatMinutes(9 * 60 + 5), '09:05');
    assert.strictEqual(formatAmount(12.3, defaultSettings(), true, 0), '¥***');

    const ms = milestoneSummary(workSnap, defaultSettings(), false);
    assert.strictEqual(ms.title, '刚挣够一顿火锅（¥150）');
    assert.strictEqual(ms.detail, '下一个：一顿日料 ¥800，还差 ¥188.99，大约 1 小时 30 分');
  });

  test('index.js 统一导出完整契约符号', () => {
    for (const key of [
      'settings',
      'holidayData',
      'wageEngine',
      'display',
      'IncomeType',
      'WageBasis',
      'MenuBarFormat',
      'OffHoursDisplay',
      'BossHotkey',
      'ManualKind',
      'HolidayEntryType',
      'DEFAULT_MILESTONES',
      'defaultSettings',
      'decodeSettings',
      'parseSettingsJson',
      'monthlyAmount',
      'setBigSmallWeek',
      'setMark',
      'parseHolidayImport',
      'mergeHolidayImport',
      'DayKey',
      'BuiltinHolidays',
      'DayKind',
      'Phase',
      'WorkCalendar',
      'WageEngine',
      'serializeSnapshot',
      'Money',
      'Duration',
      'StatusText',
      'Milestones',
      'Quotes',
      'formatDayLine',
      'kindLabel',
    ]) {
      assert.ok(key in core, `index.js 缺少导出 ${key}`);
    }
  });
});
