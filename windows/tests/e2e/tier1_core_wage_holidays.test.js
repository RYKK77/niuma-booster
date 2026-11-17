'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  requireCore,
  toMs,
  getPaidDays,
  applyBigSmallWeek,
  localDate,
} = require('./helpers/coreCompat');

function assertNear(actual, expected, eps = 1e-6, msg) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${msg ? msg + ': ' : ''}期望 ${expected} (±${eps})，实际 ${actual}`
  );
}

describe('Tier 1 — Core F1: 薪资口径与计薪基准', () => {
  test('T1-F1-01 默认月薪+实际计薪日在工作中(2026-11-17 15:18:42)全字段精确计算', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    const engine = new wageEngine.WageEngine(s);
    const snap = engine.snapshot(localDate(2026, 11, 17, 15, 18, 42));

    assert.equal(snap.phase, wageEngine.Phase.working);
    assert.equal(snap.paidDaysInMonth, 21);
    assert.equal(snap.paidDayIndex, 12);
    assertNear(snap.dailyWage, 20000 / 21, 1e-6, 'dailyWage');
    assertNear(snap.earnedToday, (20000 / 21) * (17322 / 27000), 1e-6, 'earnedToday');
    assertNear(snap.hourly, (20000 / 21) / 7.5, 1e-6, 'hourly');
    assert.equal(snap.perSecond.toFixed(4), '0.0353');
    assert.equal(Math.floor(snap.progress * 100), 64);
    assert.equal(snap.secondsToEnd, 9678);
    assertNear(snap.monthTotal, 11 * (20000 / 21) + snap.earnedToday, 1e-6, 'monthTotal');

    const money = new display.Money(s);
    assert.equal(money.string(snap.dailyWage), '¥952.38');
    assert.equal(money.string(snap.earnedToday), '¥611.01');
    assert.equal(money.string(snap.hourly), '¥126.98');
    assert.equal(money.string(snap.monthTotal), '¥11,087.20');
  });

  test('T1-F1-02 月薪+实际计薪日在当月最后计薪日下班后月累计精确凑整', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    const engine = new wageEngine.WageEngine(s);
    const money = new display.Money(s);

    const nov = engine.snapshot(localDate(2026, 11, 30, 19, 0, 0));
    assert.equal(nov.paidDayIndex, 21);
    assert.equal(nov.paidDaysInMonth, 21);
    assertNear(nov.monthTotal, 20000, 1e-6, '2026-11 monthTotal');
    assert.equal(money.string(nov.monthTotal), '¥20,000.00');

    const feb = engine.snapshot(localDate(2027, 2, 26, 23, 0, 0));
    assert.equal(feb.paidDayIndex, 15);
    assert.equal(feb.paidDaysInMonth, 15);
    assertNear(feb.monthTotal, 20000, 1e-6, '2027-02 monthTotal');
  });

  test('T1-F1-03 年薪口径按 12 个月折算并结合实际计薪日计算日薪', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    s.incomeType = settings.IncomeType.yearly;
    s.amount = 240000;
    s.basis = settings.WageBasis.actualWorkdays;

    assert.equal(settings.monthlyAmount(s), 20000);
    const engine = new wageEngine.WageEngine(s);
    const snap = engine.snapshot(localDate(2026, 11, 17, 18, 30, 0));
    const money = new display.Money(s);

    assert.equal(snap.phase, wageEngine.Phase.afterWork);
    assertNear(snap.progress, 1, 1e-9);
    assert.equal(money.string(snap.dailyWage), '¥952.38');
    assert.equal(money.string(snap.earnedToday), '¥952.38');
  });

  test('T1-F1-04 年薪非整除金额配合固定 21.75 天基准在调休补班日计算', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    s.incomeType = settings.IncomeType.yearly;
    s.amount = 360000;
    s.basis = settings.WageBasis.fixed2175;

    assert.equal(settings.monthlyAmount(s), 30000);
    const engine = new wageEngine.WageEngine(s);
    const snap = engine.snapshot(localDate(2026, 10, 10, 10, 0, 0));
    const money = new display.Money(s);

    assert.equal(snap.day.kind, wageEngine.DayKind.makeupWorkday);
    assert.equal(snap.paidDaysInMonth, 18);
    assert.equal(snap.paidDayIndex, 3);
    assertNear(snap.dailyWage, 30000 / 21.75, 1e-6);
    assertNear(snap.earnedToday, (30000 / 21.75) * (3600 / 27000), 1e-6);
    assert.equal(money.string(snap.dailyWage), '¥1,379.31');
    assert.equal(money.string(snap.earnedToday), '¥183.91');
    assert.equal(money.string(snap.monthTotal), '¥2,942.53');
  });

  test('T1-F1-05 月薪固定 21.75 天基准跨不同月份日薪保持恒定', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    s.incomeType = settings.IncomeType.monthly;
    s.amount = 20000;
    s.basis = settings.WageBasis.fixed2175;

    const engine = new wageEngine.WageEngine(s);
    const nov = engine.snapshot(localDate(2026, 11, 17, 18, 30, 0));
    const feb = engine.snapshot(localDate(2027, 2, 26, 18, 30, 0));
    const money = new display.Money(s);

    assertNear(nov.dailyWage, 20000 / 21.75, 1e-9);
    assert.equal(nov.dailyWage, feb.dailyWage);
    assert.equal(money.string(nov.dailyWage), '¥919.54');
    assert.equal(money.string(nov.hourly), '¥122.61');
  });

  test('T1-F1-06 时薪口径按有效工时计算日薪且不受 WageBasis 影响', () => {
    const { settings, wageEngine } = requireCore();

    // (a) 默认 7.5h 班次，即使 basis 为 fixed2175
    const s1 = settings.defaultSettings();
    s1.incomeType = settings.IncomeType.hourly;
    s1.amount = 100;
    s1.basis = settings.WageBasis.fixed2175;
    assert.equal(settings.monthlyAmount(s1), 0);

    const snap1 = new wageEngine.WageEngine(s1).snapshot(localDate(2026, 11, 17, 15, 18, 42));
    assertNear(snap1.dailyWage, 750, 1e-9);
    assertNear(snap1.hourly, 100, 1e-9);
    assertNear(snap1.earnedToday, 481.1666667, 1e-5);

    // (b) 6h 班次 (09:00-16:00, 午休 12:00-13:00)
    const s2 = settings.defaultSettings();
    s2.incomeType = settings.IncomeType.hourly;
    s2.amount = 100;
    s2.workStart = 9 * 60;
    s2.workEnd = 16 * 60;
    s2.lunchEnabled = true;
    s2.lunchStart = 12 * 60;
    s2.lunchEnd = 13 * 60;

    const snap2 = new wageEngine.WageEngine(s2).snapshot(localDate(2026, 11, 17, 16, 0, 0));
    assertNear(snap2.dailyWage, 600, 1e-9);
    assertNear(snap2.hourly, 100, 1e-9);
    assertNear(snap2.earnedToday, 600, 1e-9);
  });

  test('T1-F1-07 上班前、午休冻结与下班后阶段金额和倒计时准确', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    const engine = new wageEngine.WageEngine(s);
    const money = new display.Money(s);

    const before = engine.snapshot(localDate(2026, 11, 17, 8, 30, 0));
    assert.equal(before.phase, wageEngine.Phase.beforeWork);
    assert.equal(before.earnedToday, 0);
    assert.equal(before.secondsToStart, 1800);
    assert.equal(before.secondsToEnd, 34200);

    const lunch1 = engine.snapshot(localDate(2026, 11, 17, 12, 40, 0));
    const lunch2 = engine.snapshot(localDate(2026, 11, 17, 13, 29, 59));
    assert.equal(lunch1.phase, wageEngine.Phase.lunch);
    assert.equal(lunch2.phase, wageEngine.Phase.lunch);
    assertNear(lunch1.earnedToday, lunch2.earnedToday, 1e-9, '午休期间金额冻结');
    assert.equal(money.string(lunch1.earnedToday), '¥380.95');

    const after = engine.snapshot(localDate(2026, 11, 17, 18, 30, 0));
    assert.equal(after.phase, wageEngine.Phase.afterWork);
    assert.equal(money.string(after.earnedToday), '¥952.38');
    assertNear(after.progress, 1, 1e-9);
    assert.equal(after.secondsToStart ?? null, null);
    assert.equal(after.secondsToEnd ?? null, null);
  });
});

describe('Tier 1 — Core F2: 2026–2027 法定节假日与 DayKey', () => {
  test('T1-F2-01 2026 与 2027 全年 24 个月计薪日数全量精确匹配', () => {
    const { settings, wageEngine } = requireCore();
    const wc = new wageEngine.WorkCalendar(settings.defaultSettings());
    const expected2026 = [21, 16, 22, 21, 19, 21, 23, 21, 22, 18, 21, 23];
    const expected2027 = [21, 15, 23, 21, 19, 21, 22, 22, 22, 17, 22, 23];

    for (let m = 1; m <= 12; m++) {
      assert.equal(
        getPaidDays(wc, localDate(2026, m, 1)).length,
        expected2026[m - 1],
        `2026-${m}`
      );
      assert.equal(
        getPaidDays(wc, localDate(2027, m, 1)).length,
        expected2027[m - 1],
        `2027-${m}`
      );
    }
  });

  test('T1-F2-02 2026 年全部 7 个法定假日与 6 个调休补班逐日验证', () => {
    const { settings, holidayData, wageEngine } = requireCore();
    assert.equal(holidayData.BuiltinHolidays.entries.length, 73);
    const wc = new wageEngine.WorkCalendar(settings.defaultSettings());

    const holidays2026 = [
      ['元旦', ['2026-01-01', '2026-01-02', '2026-01-03']],
      ['春节', ['2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23']],
      ['清明', ['2026-04-04', '2026-04-05', '2026-04-06']],
      ['劳动节', ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05']],
      ['端午', ['2026-06-19', '2026-06-20', '2026-06-21']],
      ['中秋', ['2026-09-25', '2026-09-26', '2026-09-27']],
      ['国庆', ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']],
    ];
    for (const [name, dates] of holidays2026) {
      for (const dk of dates) {
        const p = holidayData.DayKey.parse(dk);
        const info = wc.info(localDate(p.year, p.month, p.day));
        assert.equal(info.kind, wageEngine.DayKind.holiday, `${dk} 应为 holiday`);
        assert.equal(info.name, name, `${dk} 节日名称`);
        assert.equal(info.isPaid, false);
        assert.equal(info.accrues, false);
      }
    }

    const makeups2026 = [
      ['2026-01-04', '元旦'],
      ['2026-02-14', '春节'],
      ['2026-02-28', '春节'],
      ['2026-05-09', '劳动节'],
      ['2026-09-20', '国庆'],
      ['2026-10-10', '国庆'],
    ];
    for (const [dk, name] of makeups2026) {
      const p = holidayData.DayKey.parse(dk);
      const info = wc.info(localDate(p.year, p.month, p.day));
      assert.equal(info.kind, wageEngine.DayKind.makeupWorkday, `${dk} 应为 makeupWorkday`);
      assert.equal(info.name, name);
      assert.equal(info.isPaid, true);
      assert.equal(info.accrues, true);
    }
  });

  test('T1-F2-03 2027 年全部 7 个法定假日与 5 个调休补班及相邻工作日验证', () => {
    const { settings, holidayData, wageEngine } = requireCore();
    assert.deepEqual(holidayData.BuiltinHolidays.years, [2026, 2027]);
    const wc = new wageEngine.WorkCalendar(settings.defaultSettings());

    const holidays2027 = [
      ['元旦', ['2027-01-01', '2027-01-02', '2027-01-03']],
      ['春节', ['2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13']],
      ['清明', ['2027-04-03', '2027-04-04', '2027-04-05']],
      ['劳动节', ['2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05']],
      ['端午', ['2027-06-09']],
      ['中秋', ['2027-09-15']],
      ['国庆', ['2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07']],
    ];
    for (const [name, dates] of holidays2027) {
      for (const dk of dates) {
        const p = holidayData.DayKey.parse(dk);
        const info = wc.info(localDate(p.year, p.month, p.day));
        assert.equal(info.kind, wageEngine.DayKind.holiday, `${dk} 应为 holiday`);
        assert.equal(info.name, name);
      }
    }

    const makeups2027 = [
      ['2027-01-31', '春节'],
      ['2027-02-14', '春节'],
      ['2027-05-08', '劳动节'],
      ['2027-09-26', '国庆'],
      ['2027-10-09', '国庆'],
    ];
    for (const [dk, name] of makeups2027) {
      const p = holidayData.DayKey.parse(dk);
      const info = wc.info(localDate(p.year, p.month, p.day));
      assert.equal(info.kind, wageEngine.DayKind.makeupWorkday, `${dk} 应为 makeupWorkday`);
      assert.equal(info.name, name);
    }

    // 相邻普通工作日不被误标
    assert.equal(wc.info(localDate(2026, 2, 13)).kind, wageEngine.DayKind.workday);
    assert.equal(wc.info(localDate(2026, 2, 24)).kind, wageEngine.DayKind.workday);
    assert.equal(wc.info(localDate(2027, 6, 10)).kind, wageEngine.DayKind.workday);
  });

  test('T1-F2-04 DayKey.key 本地日历生成与 make/parse 基础功能', () => {
    const { holidayData } = requireCore();
    const { DayKey } = holidayData;

    assert.equal(DayKey.key(localDate(2026, 11, 17, 0, 0, 1)), '2026-11-17');
    assert.equal(DayKey.key(localDate(2026, 11, 17, 7, 59, 59)), '2026-11-17');
    assert.equal(DayKey.key(localDate(2026, 1, 1, 23, 59, 59)), '2026-01-01');
    assert.equal(DayKey.make(2026, 1, 5), '2026-01-05');
    assert.deepEqual(DayKey.parse('2026-02-14'), { year: 2026, month: 2, day: 14 });
  });

  test('T1-F2-05 DayKey.isValid 合法性与闰年及大小月日期校验', () => {
    const { holidayData } = requireCore();
    const { DayKey } = holidayData;

    for (const ok of ['2026-01-01', '2028-02-29', '2024-02-29', '2026-12-31']) {
      assert.equal(DayKey.isValid(ok), true, `${ok} 应合法`);
    }
    for (const bad of [
      '2026-02-29',
      '2025-02-29',
      '2028-02-30',
      '2026-04-31',
      '2026-13-01',
      '2026-00-10',
      '2026-01-00',
      '2026-01-32',
      'not-a-date',
      '',
    ]) {
      assert.equal(DayKey.isValid(bad), false, `${bad} 应非法`);
    }
  });

  test('T1-F2-06 DayKey.range 闭区间展开（平年/闰年/单日/倒置）', () => {
    const { holidayData } = requireCore();
    const { DayKey } = holidayData;

    assert.deepEqual(DayKey.range('2026-02-27', '2026-03-02'), [
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
    assert.deepEqual(DayKey.range('2028-02-28', '2028-03-01'), [
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
    assert.deepEqual(DayKey.range('2027-06-09', '2027-06-09'), ['2027-06-09']);
    assert.deepEqual(DayKey.range('2026-05-05', '2026-05-01'), []);
  });
});

describe('Tier 1 — Core F3: 4 级优先级、JSON 导入与大小周', () => {
  test('T1-F3-01 手动标记覆盖普通工作日与内置节假日并正确统计计薪日', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.manualMarks = [
      { date: '2026-11-18', kind: settings.ManualKind.paidLeave, note: '年假' },
      { date: '2026-11-20', kind: settings.ManualKind.rest, note: '' },
      { date: '2026-11-21', kind: settings.ManualKind.work, note: '' },
      { date: '2026-10-01', kind: settings.ManualKind.work, note: '值班' },
    ];
    const wc = new wageEngine.WorkCalendar(s);

    const nov18 = wc.info(localDate(2026, 11, 18));
    assert.equal(nov18.kind, wageEngine.DayKind.paidLeave);
    assert.equal(nov18.name, '年假');
    assert.equal(nov18.isPaid, true);
    assert.equal(nov18.accrues, false);

    const nov20 = wc.info(localDate(2026, 11, 20));
    assert.equal(nov20.kind, wageEngine.DayKind.manualRest);
    assert.equal(nov20.name ?? null, null);
    assert.equal(nov20.isPaid, false);

    const nov21 = wc.info(localDate(2026, 11, 21));
    assert.equal(nov21.kind, wageEngine.DayKind.manualWork);
    assert.equal(nov21.name ?? null, null);
    assert.equal(nov21.isPaid, true);
    assert.equal(nov21.accrues, true);

    const oct01 = wc.info(localDate(2026, 10, 1));
    assert.equal(oct01.kind, wageEngine.DayKind.manualWork);
    assert.equal(oct01.name, '值班');
    assert.equal(getPaidDays(wc, localDate(2026, 11, 1)).length, 21);
    assert.equal(getPaidDays(wc, localDate(2026, 10, 1)).length, 19);
  });

  test('T1-F3-02 导入 JSON 覆盖内置假日，手动标记再覆盖导入 JSON', () => {
    const { settings, wageEngine } = requireCore();
    const s1 = settings.defaultSettings();
    s1.importedHolidays = [
      { date: '2026-10-07', type: settings.HolidayEntryType.workday, name: '测试补班' },
    ];
    const wc1 = new wageEngine.WorkCalendar(s1);
    const info1 = wc1.info(localDate(2026, 10, 7));
    assert.equal(info1.kind, wageEngine.DayKind.makeupWorkday);
    assert.equal(info1.name, '测试补班');
    assert.equal(wc1.noticeEntry('2026-10-07').name, '测试补班');

    const s2 = settings.defaultSettings();
    s2.importedHolidays = s1.importedHolidays;
    s2.manualMarks = [
      { date: '2026-10-07', kind: settings.ManualKind.rest, note: '调休休息' },
    ];
    const wc2 = new wageEngine.WorkCalendar(s2);
    const info2 = wc2.info(localDate(2026, 10, 7));
    assert.equal(info2.kind, wageEngine.DayKind.manualRest);
    assert.equal(info2.name, '调休休息');
    assert.equal(wc2.noticeEntry('2026-10-07').name, '测试补班');
  });

  test('T1-F3-03 导入 JSON 优先级高于每周作息与大小周', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.bigSmallWeek = true;
    s.bigWeekAnchor = '2026-11-16';
    s.importedHolidays = [
      { date: '2026-11-21', type: settings.HolidayEntryType.holiday, name: '公司司庆' },
    ];
    const wc1 = new wageEngine.WorkCalendar(s);
    const info1 = wc1.info(localDate(2026, 11, 21));
    assert.equal(info1.kind, wageEngine.DayKind.holiday);
    assert.equal(info1.name, '公司司庆');
    assert.equal(info1.isPaid, false);

    s.manualMarks = [{ date: '2026-11-21', kind: settings.ManualKind.work, note: '' }];
    const wc2 = new wageEngine.WorkCalendar(s);
    assert.equal(wc2.info(localDate(2026, 11, 21)).kind, wageEngine.DayKind.manualWork);
  });

  test('T1-F3-04 parseHolidayImport 过滤坏日期并在非法结构或枚举时抛错', () => {
    const { settings } = requireCore();
    const goodJson = JSON.stringify([
      { date: '2028-01-01', type: 'holiday', name: '元旦' },
      { date: '2028-02-30', type: 'holiday', name: '坏' },
      { date: '2028-01-02', type: 'workday', name: '元旦' },
    ]);
    const parsed = settings.parseHolidayImport(goodJson);
    assert.deepEqual(
      parsed.map((x) => x.date),
      ['2028-01-01', '2028-01-02']
    );

    // 支持 Buffer 输入
    const parsedBuf = settings.parseHolidayImport(Buffer.from(goodJson, 'utf8'));
    assert.deepEqual(parsedBuf.map((x) => x.date), ['2028-01-01', '2028-01-02']);

    assert.throws(() => settings.parseHolidayImport('{bad'));
    assert.throws(() =>
      settings.parseHolidayImport(JSON.stringify([{ date: '2028-01-01', type: 'unknown', name: 'x' }]))
    );
    assert.throws(() =>
      settings.parseHolidayImport(JSON.stringify({ date: '2028-01-01', type: 'holiday', name: 'x' }))
    );
  });

  test('T1-F3-05 mergeHolidayImport 同日覆盖且按 date 升序排列', () => {
    const { settings } = requireCore();
    const oldList = [
      { date: '2028-05-01', type: 'holiday', name: '旧五一' },
      { date: '2028-01-01', type: 'holiday', name: '元旦' },
    ];
    const newList = [
      { date: '2028-05-01', type: 'workday', name: '新调整' },
      { date: '2028-02-01', type: 'holiday', name: '春节' },
    ];
    const merged = settings.mergeHolidayImport(oldList, newList);
    assert.equal(merged.length, 3);
    assert.deepEqual(
      merged.map((x) => x.date),
      ['2028-01-01', '2028-02-01', '2028-05-01']
    );
    assert.equal(merged[2].type, 'workday');
    assert.equal(merged[2].name, '新调整');
  });

  test('T1-F3-06 大小周前后奇偶周六与周日判定及月计薪日统计', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.bigSmallWeek = true;
    s.bigWeekAnchor = '2026-11-16';
    const wc = new wageEngine.WorkCalendar(s);

    const sat0 = wc.info(localDate(2026, 11, 21));
    assert.equal(sat0.kind, wageEngine.DayKind.workday);
    assert.equal(sat0.name, '大周');

    assert.equal(wc.info(localDate(2026, 11, 28)).kind, wageEngine.DayKind.weekend);

    const satPlus2 = wc.info(localDate(2026, 12, 5));
    assert.equal(satPlus2.kind, wageEngine.DayKind.workday);
    assert.equal(satPlus2.name, '大周');

    assert.equal(wc.info(localDate(2026, 11, 14)).kind, wageEngine.DayKind.weekend);

    const satMinus2 = wc.info(localDate(2026, 11, 7));
    assert.equal(satMinus2.kind, wageEngine.DayKind.workday);
    assert.equal(satMinus2.name, '大周');

    assert.equal(wc.info(localDate(2026, 11, 22)).kind, wageEngine.DayKind.weekend);
    assert.equal(getPaidDays(wc, localDate(2026, 11, 1)).length, 23);
  });

  test('T1-F3-07 setBigSmallWeek 首次设置锚点并在开关切换后保留原锚点', () => {
    const { settings } = requireCore();
    let s = settings.defaultSettings();
    assert.equal(s.bigSmallWeek, false);
    assert.equal(s.bigWeekAnchor ?? null, null);

    s = applyBigSmallWeek(settings, s, true, localDate(2026, 11, 17, 10, 0, 0));
    assert.equal(s.bigSmallWeek, true);
    assert.equal(s.bigWeekAnchor, '2026-11-16');

    s = applyBigSmallWeek(settings, s, false, localDate(2026, 11, 17, 10, 0, 0));
    assert.equal(s.bigSmallWeek, false);

    s = applyBigSmallWeek(settings, s, true, localDate(2026, 11, 24, 10, 0, 0));
    assert.equal(s.bigSmallWeek, true);
    assert.equal(s.bigWeekAnchor, '2026-11-16');
  });

  test('T1-F3-08 自定义四天工作制与内置法定补班叠加', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.workWeekdays = [2, 3, 4, 5]; // 周一至周四
    s.bigSmallWeek = false;
    const wc = new wageEngine.WorkCalendar(s);

    for (const friday of [6, 13, 20, 27]) {
      assert.equal(wc.info(localDate(2026, 11, friday)).kind, wageEngine.DayKind.weekend);
    }
    assert.equal(getPaidDays(wc, localDate(2026, 11, 1)).length, 17);
    assert.equal(wc.info(localDate(2026, 10, 10)).kind, wageEngine.DayKind.makeupWorkday);
  });
});

describe('Tier 1 — Core F4: 跨夜班、午休钳位与带薪假', () => {
  test('T1-F4-01 跨夜班当晚与次日凌晨归属开始日，到达下班点后切入次日班次', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.workStart = 22 * 60;
    s.workEnd = 6 * 60;
    s.lunchEnabled = false;
    const engine = new wageEngine.WageEngine(s);

    const a = engine.snapshot(localDate(2026, 11, 17, 23, 0, 0));
    assert.equal(toMs(a.shiftDay), localDate(2026, 11, 17).getTime());
    assert.equal(a.phase, wageEngine.Phase.working);
    assertNear(a.progress, 1 / 8, 1e-9);

    const b = engine.snapshot(localDate(2026, 11, 18, 2, 0, 0));
    assert.equal(toMs(b.shiftDay), localDate(2026, 11, 17).getTime());
    assert.equal(b.phase, wageEngine.Phase.working);
    assertNear(b.progress, 4 / 8, 1e-9);

    const atEnd = engine.snapshot(localDate(2026, 11, 18, 6, 0, 0));
    assert.equal(toMs(atEnd.shiftDay), localDate(2026, 11, 18).getTime());
    assert.equal(atEnd.phase, wageEngine.Phase.beforeWork);

    const c = engine.snapshot(localDate(2026, 11, 18, 7, 0, 0));
    assert.equal(toMs(c.shiftDay), localDate(2026, 11, 18).getTime());
    assert.equal(c.phase, wageEngine.Phase.beforeWork);
    assert.equal(c.secondsToStart, 15 * 3600);
  });

  test('T1-F4-02 跨月跨夜班(11-30 22:00 ~ 12-01 06:00)按开始日 11 月计薪', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.workStart = 22 * 60;
    s.workEnd = 6 * 60;
    s.lunchEnabled = false;
    const engine = new wageEngine.WageEngine(s);

    const snap = engine.snapshot(localDate(2026, 12, 1, 2, 0, 0));
    assert.equal(toMs(snap.shiftDay), localDate(2026, 11, 30).getTime());
    assert.equal(snap.paidDaysInMonth, 21);
    assert.equal(snap.paidDayIndex, 21);
    const rate = 20000 / 21;
    assertNear(snap.dailyWage, rate, 1e-6);
    assertNear(snap.monthTotal, 20 * rate + 0.5 * rate, 1e-6);
  });

  test('T1-F4-03 跨夜班配跨午夜后午休(02:00–03:00)匹配次日重叠段', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.workStart = 22 * 60;
    s.workEnd = 7 * 60;
    s.lunchEnabled = true;
    s.lunchStart = 2 * 60;
    s.lunchEnd = 3 * 60;
    const engine = new wageEngine.WageEngine(s);

    const sh = engine.shift(localDate(2026, 11, 17));
    assert.equal(sh.effectiveSeconds, 8 * 3600);
    assert.equal(toMs(sh.lunchStart), localDate(2026, 11, 18, 2, 0, 0).getTime());
    assert.equal(toMs(sh.lunchEnd), localDate(2026, 11, 18, 3, 0, 0).getTime());

    const snap = engine.snapshot(localDate(2026, 11, 18, 2, 30, 0));
    assert.equal(snap.phase, wageEngine.Phase.lunch);
    assertNear(snap.progress, 0.5, 1e-9);
  });

  test('T1-F4-04 午休本身跨越午夜(23:30–00:30)在夜班中正确计算', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.workStart = 20 * 60;
    s.workEnd = 5 * 60;
    s.lunchEnabled = true;
    s.lunchStart = 23 * 60 + 30;
    s.lunchEnd = 30;
    const engine = new wageEngine.WageEngine(s);

    const sh = engine.shift(localDate(2026, 11, 17));
    assert.equal(toMs(sh.lunchStart), localDate(2026, 11, 17, 23, 30, 0).getTime());
    assert.equal(toMs(sh.lunchEnd), localDate(2026, 11, 18, 0, 30, 0).getTime());
    assert.equal(sh.effectiveSeconds, 8 * 3600);

    const snap = engine.snapshot(localDate(2026, 11, 18, 0, 15, 0));
    assert.equal(snap.phase, wageEngine.Phase.lunch);
  });

  test('T1-F4-05 午休部分超出班次范围时向班次边界钳位', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.lunchStart = 17 * 60;
    s.lunchEnd = 19 * 60;
    const engine = new wageEngine.WageEngine(s);

    const sh = engine.shift(localDate(2026, 11, 17));
    assert.equal(toMs(sh.lunchStart), localDate(2026, 11, 17, 17, 0, 0).getTime());
    assert.equal(toMs(sh.lunchEnd), localDate(2026, 11, 17, 18, 0, 0).getTime());
    assert.equal(sh.effectiveSeconds, 8 * 3600);

    const snap = engine.snapshot(localDate(2026, 11, 17, 17, 30, 0));
    assert.equal(snap.phase, wageEngine.Phase.lunch);
    assertNear(snap.earnedToday, snap.dailyWage, 1e-9);
  });

  test('T1-F4-06 午休完全在班次外或关闭午休时 lunchStart/lunchEnd 为空', () => {
    const { settings, wageEngine } = requireCore();

    const s1 = settings.defaultSettings();
    s1.lunchEnabled = true;
    s1.lunchStart = 19 * 60;
    s1.lunchEnd = 20 * 60;
    const e1 = new wageEngine.WageEngine(s1);
    const sh1 = e1.shift(localDate(2026, 11, 17));
    assert.equal(sh1.lunchStart ?? null, null);
    assert.equal(sh1.lunchEnd ?? null, null);
    assert.equal(sh1.effectiveSeconds, 9 * 3600);
    assert.equal(e1.snapshot(localDate(2026, 11, 17, 12, 30, 0)).phase, wageEngine.Phase.working);

    const s2 = settings.defaultSettings();
    s2.lunchEnabled = false;
    s2.lunchStart = 12 * 60;
    s2.lunchEnd = 13 * 60;
    const e2 = new wageEngine.WageEngine(s2);
    const sh2 = e2.shift(localDate(2026, 11, 17));
    assert.equal(sh2.lunchStart ?? null, null);
    assert.equal(sh2.lunchEnd ?? null, null);
    assert.equal(sh2.effectiveSeconds, 9 * 3600);
    assert.equal(e2.snapshot(localDate(2026, 11, 17, 12, 30, 0)).phase, wageEngine.Phase.working);
  });

  test('T1-F4-07 带薪假全天计薪但金额恒定不按秒递增', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.manualMarks = [{ date: '2026-11-18', kind: settings.ManualKind.paidLeave, note: '年假' }];
    const engine = new wageEngine.WageEngine(s);

    for (const [hh, mm] of [[0, 1], [10, 0], [23, 59]]) {
      const snap = engine.snapshot(localDate(2026, 11, 18, hh, mm, 0));
      assert.equal(snap.phase, wageEngine.Phase.paidLeave);
      assertNear(snap.earnedToday, snap.dailyWage, 1e-9);
      assertNear(snap.progress, 1, 1e-9);
      assert.equal(snap.secondsToStart ?? null, null);
      assert.equal(snap.secondsToEnd ?? null, null);
      assert.equal(snap.paidDayIndex, 13);
      assert.equal(snap.paidDaysInMonth, 21);
    }
  });

  test('T1-F4-08 跨夜班开始日为节假日且次日凌晨为工作日时整班按休息处理', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.workStart = 22 * 60;
    s.workEnd = 6 * 60;
    s.lunchEnabled = false;
    const engine = new wageEngine.WageEngine(s);

    const snap = engine.snapshot(localDate(2026, 10, 8, 2, 0, 0));
    assert.equal(toMs(snap.shiftDay), localDate(2026, 10, 7).getTime());
    assert.equal(snap.day.kind, wageEngine.DayKind.holiday);
    assert.equal(snap.day.name, '国庆');
    assert.equal(snap.phase, wageEngine.Phase.rest);
    assert.equal(snap.earnedToday, 0);
    assert.equal(snap.progress, 0);
  });
});

describe('Tier 1 — Core F6: WageEngineTests.swift 22 项单测全量对齐校验', () => {
  test('T1-F6-01 映射 testHolidayRest 与 testDesignOctMakeupDay', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    const engine = new wageEngine.WageEngine(s);
    const money = new display.Money(s);

    const oct2 = engine.snapshot(localDate(2026, 10, 2, 10, 0, 0));
    assert.equal(oct2.phase, wageEngine.Phase.rest);
    assert.equal(oct2.day.kind, wageEngine.DayKind.holiday);
    assert.equal(oct2.day.name, '国庆');
    assert.equal(oct2.earnedToday, 0);
    assert.equal(display.StatusText.make(oct2, s, false).main, '国庆休息');

    const oct10 = engine.snapshot(localDate(2026, 10, 10, 15, 18, 42));
    assert.equal(oct10.day.kind, wageEngine.DayKind.makeupWorkday);
    assert.equal(oct10.paidDaysInMonth, 18);
    assert.equal(money.string(oct10.dailyWage), '¥1,111.11');
    assert.equal(money.string(oct10.earnedToday), '¥712.84');
  });

  test('T1-F6-02 映射 testZeroLengthShiftDoesNotCrash 零工时班次安全运行', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.workStart = 9 * 60;
    s.workEnd = 9 * 60;
    const engine = new wageEngine.WageEngine(s);
    const snap = engine.snapshot(localDate(2026, 11, 17, 12, 0, 0));
    assert.equal(snap.perSecond, 0);
    assert.equal(Number.isNaN(snap.earnedToday), false);
    assert.equal(Number.isFinite(snap.progress), true);
  });

  test('T1-F6-03 映射 testLunchClampedToShift 午休钳位与完全吞没班次', () => {
    const { settings, wageEngine } = requireCore();

    const s1 = settings.defaultSettings();
    s1.lunchStart = 17 * 60;
    s1.lunchEnd = 19 * 60;
    assert.equal(new wageEngine.WageEngine(s1).shift(localDate(2026, 11, 17)).effectiveSeconds, 8 * 3600);

    const s2 = settings.defaultSettings();
    s2.lunchStart = 8 * 60;
    s2.lunchEnd = 19 * 60;
    const e2 = new wageEngine.WageEngine(s2);
    assert.equal(e2.shift(localDate(2026, 11, 17)).effectiveSeconds, 0);
    assert.equal(e2.snapshot(localDate(2026, 11, 17, 12, 0, 0)).perSecond, 0);
  });

  test('T1-F6-04 映射 testStatusLines 状态栏全部组合与老板遮罩', () => {
    const { settings, wageEngine, display } = requireCore();
    const engine = new wageEngine.WageEngine(settings.defaultSettings());
    const working = engine.snapshot(localDate(2026, 11, 17, 15, 18, 42));

    const s = settings.defaultSettings();
    assert.equal(display.StatusText.make(working, s, false).main, '¥611.01');
    assert.equal(display.StatusText.make(working, s, true).main, '¥***.**');

    s.menuBarFormat = settings.MenuBarFormat.amountProgress;
    assert.equal(display.StatusText.make(working, s, false).main, '¥611 · 64%');

    s.menuBarFormat = settings.MenuBarFormat.amountCountdown;
    assert.equal(display.StatusText.make(working, s, false).main, '¥611.01 · 2:41:18');

    s.menuBarFormat = settings.MenuBarFormat.iconOnly;
    const icon = display.StatusText.make(working, s, false);
    assert.equal(icon.main, '');
    assert.equal(icon.forceIcon, true);

    const def = settings.defaultSettings();
    assert.equal(display.StatusText.make(engine.snapshot(localDate(2026, 11, 17, 12, 40)), def, false).prefix, '干饭中');
    assert.equal(display.StatusText.make(engine.snapshot(localDate(2026, 11, 17, 18, 30)), def, false).check, true);
    assert.equal(display.StatusText.make(engine.snapshot(localDate(2026, 10, 10, 15, 0)), def, false).badge, '班');
    assert.equal(display.StatusText.make(engine.snapshot(localDate(2026, 11, 21, 10, 0)), def, false).main, '休息');

    const quiet = settings.defaultSettings();
    quiet.offHoursDisplay = settings.OffHoursDisplay.iconOnly;
    assert.equal(display.StatusText.make(engine.snapshot(localDate(2026, 11, 21, 10, 0)), quiet, false).forceIcon, true);
  });

  test('T1-F6-05 映射 testMilestones 与 testSettingsDecodeWithMissingKeys', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    const snap = new wageEngine.WageEngine(s).snapshot(localDate(2026, 11, 17, 15, 18, 42));
    const m = display.Milestones.status(snap, settings.DEFAULT_MILESTONES);
    const money = new display.Money(s);

    assert.equal(m.reached.name, '一顿火锅');
    assert.equal(m.next.name, '一顿日料');
    assert.equal(money.string(m.remaining), '¥188.99');
    assert.equal(display.Duration.words(m.eta), '1 小时 30 分');
    assert.deepEqual(
      display.Milestones.crossed(10, 35, settings.DEFAULT_MILESTONES).map((x) => x.name),
      ['一杯奶茶', '一份外卖']
    );
    assert.deepEqual(display.Milestones.parse('奶茶，15\n坏行\n火锅, 150'), [
      { name: '奶茶', amount: 15 },
      { name: '火锅', amount: 150 },
    ]);

    const decoded = settings.parseSettingsJson('{"amount":30000,"menuBarFormat":"nonsense"}');
    assert.equal(decoded.amount, 30000);
    assert.equal(decoded.menuBarFormat, settings.MenuBarFormat.amountOnly);
    assert.deepEqual(decoded.workWeekdays, [2, 3, 4, 5, 6]);
    const round = settings.parseSettingsJson(JSON.stringify(decoded));
    assert.deepEqual(round, decoded);
  });

  test('T1-F6-06 映射 WageEngineTests 其余核心导出完整性校验', () => {
    const core = requireCore();
    assert.ok(core.settings && core.holidayData && core.wageEngine && core.display);
    assert.equal(typeof core.wageEngine.WorkCalendar.monday, 'function');
    assert.equal(typeof core.display.formatDayLine, 'function');
    assert.equal(typeof core.display.kindLabel, 'function');
  });
});
