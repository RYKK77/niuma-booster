'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { requireCore, localDate } = require('./helpers/coreCompat');

describe('Tier 1 — Core F5: 显示格式化、状态文案、里程碑、语录与设置容错', () => {
  test('T1-F5-01 Money 0-4 位小数 halfUp 舍入、千分位与自定义货币符号', () => {
    const { display } = requireCore();
    assert.equal(new display.Money('$', 2).string(1234.565), '$1,234.57');
    assert.equal(new display.Money('¥', 0).string(999.5), '¥1,000');
    assert.equal(new display.Money('€', 4).string(0.03525), '€0.0353');
    assert.equal(new display.Money('¥', 2).string(1000, 0), '¥1,000');
  });

  test('T1-F5-02 Money.masked 老板模式遮罩与越界小数位 [0..4] 钳位', () => {
    const { display } = requireCore();
    assert.equal(new display.Money('¥', 0).masked, '¥***');
    assert.equal(new display.Money('¥', 1).masked, '¥***.*');
    assert.equal(new display.Money('¥', 2).masked, '¥***.**');
    assert.equal(new display.Money('¥', 3).masked, '¥***.***');
    assert.equal(new display.Money('¥', 4).masked, '¥***.****');
    assert.equal(new display.Money('¥', -2).masked, '¥***');
    assert.equal(new display.Money('¥', 8).masked, '¥***.****');
  });

  test('T1-F5-03 Duration.clock 与 Duration.words 格式化与负数钳位', () => {
    const { display } = requireCore();
    assert.equal(display.Duration.clock(0), '0:00:00');
    assert.equal(display.Duration.clock(59.9), '0:00:59');
    assert.equal(display.Duration.clock(3661), '1:01:01');
    assert.equal(display.Duration.clock(9678), '2:41:18');
    assert.equal(display.Duration.clock(-10), '0:00:00');

    assert.equal(display.Duration.words(0), '0 分钟');
    assert.equal(display.Duration.words(1), '1 分钟');
    assert.equal(display.Duration.words(60), '1 分钟');
    assert.equal(display.Duration.words(61), '2 分钟');
    assert.equal(display.Duration.words(3600), '1 小时');
    assert.equal(display.Duration.words(5340), '1 小时 29 分');
    assert.equal(display.Duration.words(5400), '1 小时 30 分');
    assert.equal(display.Duration.words(-5), '0 分钟');
  });

  test('T1-F5-04 StatusText.make 在 working 阶段 4 种显示格式 × 正常/老板模式', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    const snap = new wageEngine.WageEngine(s).snapshot(localDate(2026, 11, 17, 15, 18, 42));

    s.menuBarFormat = settings.MenuBarFormat.amountOnly;
    assert.equal(display.StatusText.make(snap, s, false).plainText, '¥611.01');
    assert.equal(display.StatusText.make(snap, s, true).plainText, '¥***.**');

    s.menuBarFormat = settings.MenuBarFormat.amountProgress;
    assert.equal(display.StatusText.make(snap, s, false).plainText, '¥611 · 64%');
    assert.equal(display.StatusText.make(snap, s, true).plainText, '¥*** · 64%');

    s.menuBarFormat = settings.MenuBarFormat.amountCountdown;
    assert.equal(display.StatusText.make(snap, s, false).plainText, '¥611.01 · 2:41:18');
    assert.equal(display.StatusText.make(snap, s, true).plainText, '¥***.** · 2:41:18');

    s.menuBarFormat = settings.MenuBarFormat.iconOnly;
    const iconNormal = display.StatusText.make(snap, s, false);
    const iconBoss = display.StatusText.make(snap, s, true);
    assert.equal(iconNormal.main, '');
    assert.equal(iconNormal.forceIcon, true);
    assert.equal(iconNormal.plainText, '');
    assert.equal(iconBoss.main, '');
    assert.equal(iconBoss.forceIcon, true);
  });

  test('T1-F5-05 StatusText.make 覆盖全部 6 个 Phase、调休班徽章与 offHoursDisplay', () => {
    const { settings, wageEngine, display } = requireCore();
    const def = settings.defaultSettings();
    const eng = new wageEngine.WageEngine(def);

    // (a) beforeWork
    const beforeSnap = eng.snapshot(localDate(2026, 11, 17, 8, 30, 0));
    assert.equal(display.StatusText.make(beforeSnap, def, false).plainText, '¥0.00');
    const progS = settings.defaultSettings();
    progS.menuBarFormat = settings.MenuBarFormat.amountProgress;
    assert.equal(display.StatusText.make(beforeSnap, progS, false).plainText, '¥0 · 0%');

    // (b) lunch
    const lunchLine = display.StatusText.make(eng.snapshot(localDate(2026, 11, 17, 12, 40, 0)), def, false);
    assert.equal(lunchLine.prefix, '干饭中');
    assert.equal(lunchLine.plainText, '干饭中 ¥380.95');

    // (c) afterWork
    const afterLine = display.StatusText.make(eng.snapshot(localDate(2026, 11, 17, 18, 30, 0)), def, false);
    assert.equal(afterLine.check, true);
    assert.equal(afterLine.plainText, '¥952.38 ✓');

    // (d) paidLeave (带薪假不带班徽章)
    const leaveS = settings.defaultSettings();
    leaveS.manualMarks = [{ date: '2026-10-10', kind: settings.ManualKind.paidLeave, note: '年假' }];
    const leaveSnap = new wageEngine.WageEngine(leaveS).snapshot(localDate(2026, 10, 10, 15, 0, 0));
    const leaveLine = display.StatusText.make(leaveSnap, leaveS, false);
    assert.equal(leaveLine.prefix, '带薪假');
    assert.equal(leaveLine.badge ?? null, null);
    assert.equal(leaveLine.main, '¥1,111.11');

    // (e) rest (国庆 vs 周末 & offHoursDisplay=iconOnly)
    assert.equal(display.StatusText.make(eng.snapshot(localDate(2026, 10, 2, 10, 0)), def, false).main, '国庆休息');
    assert.equal(display.StatusText.make(eng.snapshot(localDate(2026, 11, 21, 10, 0)), def, false).main, '休息');
    const quietS = settings.defaultSettings();
    quietS.offHoursDisplay = settings.OffHoursDisplay.iconOnly;
    const quietLine = display.StatusText.make(eng.snapshot(localDate(2026, 10, 2, 10, 0)), quietS, false);
    assert.equal(quietLine.forceIcon, true);
    assert.equal(quietLine.main, '');

    // (f) 调休补班 working & afterWork
    const mWork = display.StatusText.make(eng.snapshot(localDate(2026, 10, 10, 15, 18, 42)), def, false);
    assert.equal(mWork.badge, '班');
    assert.equal(mWork.plainText, '班 ¥712.84');
    const mAfter = display.StatusText.make(eng.snapshot(localDate(2026, 10, 10, 19, 0, 0)), def, false);
    assert.equal(mAfter.badge, '班');
    assert.equal(mAfter.check, true);
    assert.equal(mAfter.plainText, '班 ¥1,111.11 ✓');
  });

  test('T1-F5-06 Milestones 默认 6 档、status 计算与 crossed 精确边界', () => {
    const { settings, wageEngine, display } = requireCore();
    assert.deepEqual(settings.DEFAULT_MILESTONES, [
      { name: '一杯奶茶', amount: 15 },
      { name: '一份外卖', amount: 30 },
      { name: '一张电影票', amount: 60 },
      { name: '一顿火锅', amount: 150 },
      { name: '一顿日料', amount: 800 },
      { name: '一双球鞋', amount: 1200 },
    ]);

    const s = settings.defaultSettings();
    const snap = new wageEngine.WageEngine(s).snapshot(localDate(2026, 11, 17, 15, 18, 42));
    const st = display.Milestones.status(snap, settings.DEFAULT_MILESTONES);
    assert.equal(st.reached.name, '一顿火锅');
    assert.equal(st.next.name, '一顿日料');
    assert.equal(new display.Money(s).string(st.remaining), '¥188.99');
    assert.equal(display.Duration.words(st.eta), '1 小时 30 分');

    assert.deepEqual(
      display.Milestones.crossed(10, 35, settings.DEFAULT_MILESTONES).map((m) => m.name),
      ['一杯奶茶', '一份外卖']
    );
    assert.deepEqual(
      display.Milestones.crossed(15, 30, settings.DEFAULT_MILESTONES).map((m) => m.name),
      ['一份外卖']
    );
  });

  test('T1-F5-07 Milestones.parse 与 Milestones.format 文本往返与脏行过滤', () => {
    const { display } = requireCore();
    const parsed = display.Milestones.parse('奶茶，15\n坏行\n 火锅 , 150 \n零元,0\n负数,-5\n,10\n好物,99.5');
    assert.deepEqual(parsed, [
      { name: '奶茶', amount: 15 },
      { name: '火锅', amount: 150 },
      { name: '好物', amount: 99.5 },
    ]);

    const formatted = display.Milestones.format([
      { name: '奶茶', amount: 15 },
      { name: '咖啡', amount: 19.9 },
    ]);
    assert.equal(formatted, '奶茶,15\n咖啡,19.9');
  });

  test('T1-F5-08 Quotes.all 12 句原文核对与 (yearDay * 24 + hour) % 12 轮换', () => {
    const { display } = requireCore();
    const expectedQuotes = [
      '再坚持一下，钱就到账了。',
      '今天的你也很值钱。',
      '每一秒都在进账，别慌。',
      '搬砖不易，且搬且珍惜。',
      '工资在涨，心态要稳。',
      '喝口水，钱还在跑。',
      '你不是在上班，你是在收钱。',
      '离下班又近了一点点。',
      '认真摸鱼，努力赚钱。',
      '今天也是被钱叫醒的一天。',
      '牛马也有春天。',
      '稳住，奶茶钱已经有了。',
    ];
    assert.deepEqual(display.Quotes.all, expectedQuotes);

    assert.equal(display.Quotes.forDate(localDate(2026, 1, 1, 0, 0)), expectedQuotes[0]);
    assert.equal(display.Quotes.forDate(localDate(2026, 1, 1, 11, 0)), expectedQuotes[11]);
    assert.equal(display.Quotes.forDate(localDate(2026, 1, 1, 12, 0)), expectedQuotes[0]);
    assert.equal(display.Quotes.forDate(localDate(2026, 11, 17, 15, 0)), expectedQuotes[3]);
    assert.equal(display.Quotes.forDate(localDate(2028, 2, 29, 8, 0)), expectedQuotes[8]);
  });

  test('T1-F5-09 decodeSettings 与 parseSettingsJson 逐字段容错回落及往返一致', () => {
    const { settings } = requireCore();
    const rawJson = JSON.stringify({
      amount: 30000,
      menuBarFormat: 'nonsense',
      incomeType: 123,
      workWeekdays: [2, 3, 4, 5, 6],
    });
    const decoded = settings.parseSettingsJson(rawJson);
    assert.equal(decoded.amount, 30000);
    assert.equal(decoded.menuBarFormat, settings.MenuBarFormat.amountOnly);
    assert.equal(decoded.incomeType, settings.IncomeType.monthly);
    assert.equal(decoded.currency, '¥');
    assert.equal(decoded.decimals, 2);
    assert.deepEqual(decoded.workWeekdays, [2, 3, 4, 5, 6]);
    assert.deepEqual(decoded.milestones, settings.DEFAULT_MILESTONES);

    const round = settings.parseSettingsJson(JSON.stringify(decoded));
    assert.deepEqual(round, decoded);

    // 非法 JSON 文本应整体安全回落 defaultSettings()
    assert.deepEqual(settings.parseSettingsJson('{broken json'), settings.defaultSettings());
  });

  test('T1-F5-10 formatDayLine 与 kindLabel 覆盖全部 7 种 DayKind', () => {
    const { settings, wageEngine, display } = requireCore();
    const DK = wageEngine.DayKind;

    assert.equal(display.kindLabel({ kind: DK.workday, name: null }), '工作日');
    assert.equal(display.kindLabel({ kind: DK.workday, name: '大周' }), '大周周六');
    assert.equal(display.kindLabel({ kind: DK.makeupWorkday, name: '国庆' }), '调休补班');
    assert.equal(display.kindLabel({ kind: DK.weekend, name: null }), '周末');
    assert.equal(display.kindLabel({ kind: DK.holiday, name: '国庆' }), '国庆');
    assert.equal(display.kindLabel({ kind: DK.holiday, name: null }), '法定节假日');
    assert.equal(display.kindLabel({ kind: DK.paidLeave, name: '年假' }), '带薪假（年假）');
    assert.equal(display.kindLabel({ kind: DK.paidLeave, name: null }), '带薪假');
    assert.equal(display.kindLabel({ kind: DK.manualRest, name: '病假' }), '休息（病假）');
    assert.equal(display.kindLabel({ kind: DK.manualRest, name: null }), '休息');
    assert.equal(display.kindLabel({ kind: DK.manualWork, name: '值班' }), '上班（值班）');
    assert.equal(display.kindLabel({ kind: DK.manualWork, name: null }), '上班');

    const snap = new wageEngine.WageEngine(settings.defaultSettings()).snapshot(localDate(2026, 11, 17, 15, 0, 0));
    assert.equal(display.formatDayLine(snap), '11月17日 周二 · 工作日');
  });

  test('T1-F5-11 defaultSettings 每次返回独立副本，修改不污染默认值', () => {
    const { settings } = requireCore();
    const a = settings.defaultSettings();
    a.amount = 99999;
    a.workWeekdays.push(7);
    a.milestones.push({ name: '测试', amount: 1 });
    a.manualMarks.push({ date: '2026-11-17', kind: 'rest', note: '' });

    const b = settings.defaultSettings();
    assert.equal(b.amount, 20000);
    assert.deepEqual(b.workWeekdays, [2, 3, 4, 5, 6]);
    assert.equal(b.milestones.length, 6);
    assert.deepEqual(b.manualMarks, []);
  });

  test('T1-F5-12 枚举常量与 Swift JSON rawValue 1:1 对齐', () => {
    const { settings } = requireCore();
    assert.equal(settings.IncomeType.monthly, 'monthly');
    assert.equal(settings.IncomeType.yearly, 'yearly');
    assert.equal(settings.IncomeType.hourly, 'hourly');
    assert.equal(settings.WageBasis.actualWorkdays, 'actualWorkdays');
    assert.equal(settings.WageBasis.fixed2175, 'fixed2175');
    assert.equal(settings.BossHotkey.ctrlOptB, 'ctrlOptB');
    assert.equal(settings.BossHotkey.ctrlOptCmdH, 'ctrlOptCmdH');
    assert.equal(settings.BossHotkey.off, 'off');
  });
});
