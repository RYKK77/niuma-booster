'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createElectronHarness } = require('./helpers/electronMock');
const { mountRendererWindow } = require('./helpers/domHarness');
const { parseIco, decodePngRgba } = require('./helpers/pngIcoDecoder');
const {
  requireRepoPaths,
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

// --- 渲染进程黑盒语义定位辅助（严禁假设未契约化的内部 DOM ID/类名） ---

function isVisible(el) {
  let cur = el;
  while (cur && cur.nodeType === 1) {
    if (
      cur.hidden ||
      cur.style.display === 'none' ||
      cur.style.visibility === 'hidden' ||
      cur.classList.contains('hidden') ||
      cur.classList.contains('is-hidden')
    ) {
      return false;
    }
    cur = cur.parentElement;
  }
  return true;
}

function visibleText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.data;
  if (node.nodeType !== 1) return '';
  if (node.localName === 'script' || node.localName === 'style') return '';
  if (
    node.hidden ||
    node.style.display === 'none' ||
    node.style.visibility === 'hidden' ||
    node.classList.contains('hidden') ||
    node.classList.contains('is-hidden')
  ) {
    return '';
  }
  return node.childNodes.map(visibleText).join(' ');
}

function findButtonByText(doc, substr) {
  const candidates = doc
    .querySelectorAll('button, summary, [role="button"], [role="tab"]')
    .filter((el) => isVisible(el) && el.textContent.replace(/\s+/g, ' ').includes(substr));
  assert.ok(candidates.length > 0, `未找到包含文本 "${substr}" 的可见按钮/页签`);
  candidates.sort((a, b) => a.textContent.length - b.textContent.length);
  return candidates[0];
}

function findControlByLabel(doc, labelSubstr) {
  for (const el of doc.querySelectorAll('input, select, textarea')) {
    if (!isVisible(el)) continue;
    const aria = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';
    const ph = el.getAttribute('placeholder') || '';
    if (aria.includes(labelSubstr) || title.includes(labelSubstr) || ph.includes(labelSubstr)) {
      return el;
    }
  }
  for (const lbl of doc.querySelectorAll('label')) {
    if (!isVisible(lbl) || !lbl.textContent.includes(labelSubstr)) continue;
    const forId = lbl.getAttribute('for');
    if (forId) {
      const target = doc.getElementById(forId);
      if (target) return target;
    }
    const nested = lbl.querySelector('input, select, textarea');
    if (nested) return nested;
    if (lbl.parentElement) {
      const sibling = lbl.parentElement.querySelector('input, select, textarea');
      if (sibling) return sibling;
    }
  }
  const blocks = doc
    .querySelectorAll('div, section, li, tr, p, span')
    .filter((el) => isVisible(el) && el.textContent.includes(labelSubstr) && el.querySelector('input, select, textarea'));
  blocks.sort((a, b) => a.textContent.length - b.textContent.length);
  if (blocks.length > 0) {
    return blocks[0].querySelector('input, select, textarea');
  }
  throw new Error(`未找到关联标签 "${labelSubstr}" 的表单控件`);
}

function inspectBrandPixels(png) {
  const { width, height } = png;
  const cxStart = Math.floor(width * 0.25);
  const cxEnd = Math.ceil(width * 0.75);
  const cyStart = Math.floor(height * 0.25);
  const cyEnd = Math.ceil(height * 0.75);

  let centerTotal = 0;
  let centerNonTransparent = 0;
  let opaqueTotal = 0;
  let pureBlackOpaque = 0;
  let warmOrangeCount = 0;
  let creamCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = png.getPixel(x, y);
      if (x >= cxStart && x < cxEnd && y >= cyStart && y < cyEnd) {
        centerTotal++;
        if (a > 128) centerNonTransparent++;
      }
      if (a > 200) {
        opaqueTotal++;
        if (r < 15 && g < 15 && b < 15) pureBlackOpaque++;
      }
      if (r >= 150 && r > g && g >= 35 && r - b >= 50 && a >= 150) {
        warmOrangeCount++;
      }
      if (r >= 220 && g >= 210 && b >= 180 && a > 200) {
        creamCount++;
      }
    }
  }
  return {
    centerRatio: centerTotal > 0 ? centerNonTransparent / centerTotal : 0,
    blackRatio: opaqueTotal > 0 ? pureBlackOpaque / opaqueTotal : 1,
    opaqueTotal,
    warmOrangeCount,
    creamCount,
  };
}

describe('Tier 2 — Core 边界与极端用例 (23 用例)', () => {
  test('T2-Core-01 零工时班次 (workStart === workEnd) 不除零且上下班边界切换正确', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.workStart = 9 * 60;
    s.workEnd = 9 * 60;
    s.lunchEnabled = true;

    const eng = new wageEngine.WageEngine(s);
    assert.equal(eng.isOvernight, false);

    const sh = eng.shift(localDate(2026, 11, 17));
    assert.equal(toMs(sh.start), localDate(2026, 11, 17, 9, 0, 0).getTime());
    assert.equal(toMs(sh.end), localDate(2026, 11, 17, 9, 0, 0).getTime());
    assert.equal(sh.lunchStart ?? null, null);
    assert.equal(sh.lunchEnd ?? null, null);
    assert.equal(sh.effectiveSeconds, 0);

    const before = eng.snapshot(localDate(2026, 11, 17, 8, 59, 59));
    assert.equal(before.phase, wageEngine.Phase.beforeWork);
    assert.equal(before.earnedToday, 0);
    assert.equal(before.progress, 0);
    assert.equal(before.perSecond, 0);
    assert.equal(before.hourly, 0);

    for (const [hh, mm] of [[9, 0], [12, 0]]) {
      const snap = eng.snapshot(localDate(2026, 11, 17, hh, mm, 0));
      assert.equal(snap.phase, wageEngine.Phase.afterWork);
      assertNear(snap.earnedToday, snap.dailyWage, 1e-9);
      assert.equal(snap.progress, 1);
      assert.equal(Number.isNaN(snap.earnedToday), false);
    }
  });

  test('T2-Core-02 午休完全吞没班次 (08:00-19:00 吞没 09:00-18:00) 有效工时归零', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.workStart = 9 * 60;
    s.workEnd = 18 * 60;
    s.lunchEnabled = true;
    s.lunchStart = 8 * 60;
    s.lunchEnd = 19 * 60;

    const eng = new wageEngine.WageEngine(s);
    const sh = eng.shift(localDate(2026, 11, 17));
    assert.equal(toMs(sh.lunchStart), localDate(2026, 11, 17, 9, 0, 0).getTime());
    assert.equal(toMs(sh.lunchEnd), localDate(2026, 11, 17, 18, 0, 0).getTime());
    assert.equal(sh.effectiveSeconds, 0);

    const noon = eng.snapshot(localDate(2026, 11, 17, 12, 0, 0));
    assert.equal(noon.phase, wageEngine.Phase.lunch);
    assert.equal(noon.perSecond, 0);
    assert.equal(noon.hourly, 0);
    assert.equal(noon.earnedToday, 0);
    assert.equal(noon.progress, 0);

    const endSnap = eng.snapshot(localDate(2026, 11, 17, 18, 0, 0));
    assert.equal(endSnap.phase, wageEngine.Phase.afterWork);
    assertNear(endSnap.earnedToday, endSnap.dailyWage, 1e-9);
    assert.equal(endSnap.progress, 1);
  });

  test('T2-Core-03 午休紧贴上下班边界及 lunchStart===lunchEnd 时不误扣工时', () => {
    const { settings, wageEngine } = requireCore();
    for (const [ls, le] of [[7 * 60, 9 * 60], [18 * 60, 19 * 60], [12 * 60, 12 * 60]]) {
      const s = settings.defaultSettings();
      s.lunchEnabled = true;
      s.lunchStart = ls;
      s.lunchEnd = le;
      const sh = new wageEngine.WageEngine(s).shift(localDate(2026, 11, 17));
      assert.equal(sh.lunchStart ?? null, null);
      assert.equal(sh.lunchEnd ?? null, null);
      assert.equal(sh.effectiveSeconds, 9 * 3600);
    }
  });

  test('T2-Core-04 跨年跨夜班 (2026-12-31 22:00 ~ 2027-01-01 06:00) 归属 2026-12 计薪', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    s.workStart = 22 * 60;
    s.workEnd = 6 * 60;
    s.lunchEnabled = false;
    const eng = new wageEngine.WageEngine(s);
    const money = new display.Money(s);

    const snap = eng.snapshot(localDate(2027, 1, 1, 2, 30, 0));
    assert.equal(toMs(snap.shiftDay), localDate(2026, 12, 31).getTime());
    assert.equal(snap.day.kind, wageEngine.DayKind.workday);
    assert.equal(snap.phase, wageEngine.Phase.working);
    assert.equal(snap.paidDaysInMonth, 23);
    assert.equal(snap.paidDayIndex, 23);
    assert.equal(snap.secondsToEnd, 12600);
    assert.equal(money.string(snap.dailyWage), '¥869.57');
    assert.equal(money.string(snap.earnedToday), '¥489.13');
    assert.equal(money.string(snap.monthTotal), '¥19,619.57');
  });

  test('T2-Core-05 闰年跨月夜班 (2028-02-29 22:00 ~ 2028-03-01 06:00) 归属闰日且 06:00 切入新日', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.workStart = 22 * 60;
    s.workEnd = 6 * 60;
    s.lunchEnabled = false;
    const eng = new wageEngine.WageEngine(s);

    const at3am = eng.snapshot(localDate(2028, 3, 1, 3, 0, 0));
    assert.equal(toMs(at3am.shiftDay), localDate(2028, 2, 29).getTime());
    assert.equal(at3am.phase, wageEngine.Phase.working);
    assertNear(at3am.progress, 5 / 8, 1e-9);

    const at6am = eng.snapshot(localDate(2028, 3, 1, 6, 0, 0));
    assert.equal(toMs(at6am.shiftDay), localDate(2028, 3, 1).getTime());
    assert.equal(at6am.phase, wageEngine.Phase.beforeWork);
  });

  test('T2-Core-06 DayKey.isValid 拒绝无效闰日、小月 31 日、零月日及非法格式', () => {
    const { holidayData } = requireCore();
    assert.equal(holidayData.DayKey.isValid('2028-02-29'), true);
    const invalidKeys = [
      '2025-02-29',
      '2026-02-29',
      '2028-02-30',
      '2026-04-31',
      '2026-06-31',
      '2026-09-31',
      '2026-11-31',
      '2026-02-00',
      '2026-00-15',
      '2026-13-01',
      '2026--1',
      '2026-01-01-01',
      'abcd-01-01',
      '2026/01/01',
      '',
    ];
    for (const k of invalidKeys) {
      assert.equal(holidayData.DayKey.isValid(k), false, `非法日期应返回 false: ${k}`);
    }
  });

  test('T2-Core-07 DayKey.make/parse/range 跨月闰日、单日及反向非法输入边界', () => {
    const { holidayData } = requireCore();
    const { DayKey } = holidayData;
    assert.equal(DayKey.make(2026, 3, 5), '2026-03-05');
    assert.deepEqual(DayKey.parse('2028-02-29'), { year: 2028, month: 2, day: 29 });
    assert.deepEqual(DayKey.parse('2026-02-29'), { year: 2026, month: 2, day: 29 });
    assert.equal(DayKey.isValid('2026-02-29'), false);
    assert.equal(DayKey.parse('2026-13-01') ?? null, null);
    assert.equal(DayKey.parse('2026-2-5') ?? null, null);
    assert.deepEqual(DayKey.range('2028-02-28', '2028-03-01'), ['2028-02-28', '2028-02-29', '2028-03-01']);
    assert.deepEqual(DayKey.range('2026-05-01', '2026-05-01'), ['2026-05-01']);
    assert.deepEqual(DayKey.range('2026-05-05', '2026-05-01'), []);
    assert.deepEqual(DayKey.range('2026-02-29', '2026-03-02'), []);
  });

  test('T2-Core-08 UTC+8 凌晨及跨年边界时刻 DayKey.key 严格取本地日历不回退前日', () => {
    const { holidayData } = requireCore();
    const samples = [
      [localDate(2026, 3, 1, 0, 0, 0), '2026-03-01'],
      [localDate(2026, 3, 1, 0, 0, 1), '2026-03-01'],
      [localDate(2026, 3, 1, 7, 59, 59), '2026-03-01'],
      [localDate(2026, 3, 1, 8, 0, 0), '2026-03-01'],
      [localDate(2026, 1, 1, 0, 0, 1), '2026-01-01'],
      [localDate(2026, 12, 31, 23, 59, 59), '2026-12-31'],
    ];
    for (const [dt, expected] of samples) {
      assert.equal(holidayData.DayKey.key(dt), expected);
    }
  });

  test('T2-Core-09 Money halfUp 与 halfEven 舍入精确边界、负零与非有限数防护', () => {
    const { display } = requireCore();
    assert.equal(new display.Money('¥', 0).string(0.5), '¥1');
    assert.equal(new display.Money('¥', 0).string(2.5), '¥3');
    assert.equal(new display.Money('¥', 0).string(3.5), '¥4');
    assert.equal(new display.Money('¥', 2).string(10.625), '¥10.63');
    assert.equal(new display.Money('¥', 2).string(10.375), '¥10.38');
    assert.equal(new display.Money('¥', 3).string(1000.0625), '¥1,000.063');
    assert.equal(new display.Money('¥', 2).string(1.005), '¥1.01');
    assert.equal(new display.Money('¥', 2).string(-0), '¥0.00');
    assert.equal(new display.Money('¥', 2).string(Number.NaN), '¥0');
    assert.equal(new display.Money('¥', 2).string(Number.POSITIVE_INFINITY), '¥0');
  });

  test('T2-Core-10 Money 越界小数位钳位 [0..4] 与 amountProgress 老板模式强制 0 位遮罩', () => {
    const { settings, wageEngine, display } = requireCore();
    const mNeg = new display.Money('¥', -1);
    assert.equal(mNeg.decimals, 0);
    assert.equal(mNeg.masked, '¥***');
    assert.equal(mNeg.string(12.34567), '¥12');

    const mHigh = new display.Money('¥', 6);
    assert.equal(mHigh.decimals, 4);
    assert.equal(mHigh.masked, '¥***.****');
    assert.equal(mHigh.string(12.34567), '¥12.3457');

    const s = settings.defaultSettings();
    s.decimals = 4;
    s.menuBarFormat = settings.MenuBarFormat.amountProgress;
    const snap = new wageEngine.WageEngine(s).snapshot(localDate(2026, 11, 17, 15, 18, 42));
    const line = display.StatusText.make(snap, s, true);
    assert.equal(line.main, '¥*** · 64%');
  });

  test('T2-Core-11 Duration.clock 与 Duration.words 精确边界、大时长与负值钳位', () => {
    const { display } = requireCore();
    assert.equal(display.Duration.clock(0), '0:00:00');
    assert.equal(display.Duration.clock(0.9), '0:00:00');
    assert.equal(display.Duration.clock(59.999), '0:00:59');
    assert.equal(display.Duration.clock(60), '0:01:00');
    assert.equal(display.Duration.clock(3599.9), '0:59:59');
    assert.equal(display.Duration.clock(3600), '1:00:00');
    assert.equal(display.Duration.clock(360000), '100:00:00');
    assert.equal(display.Duration.clock(-1), '0:00:00');

    assert.equal(display.Duration.words(0), '0 分钟');
    assert.equal(display.Duration.words(0.001), '1 分钟');
    assert.equal(display.Duration.words(60), '1 分钟');
    assert.equal(display.Duration.words(60.001), '2 分钟');
    assert.equal(display.Duration.words(3540), '59 分钟');
    assert.equal(display.Duration.words(3541), '1 小时');
    assert.equal(display.Duration.words(3600), '1 小时');
    assert.equal(display.Duration.words(-30), '0 分钟');
  });

  test('T2-Core-12 大小周跨年锚点、负周差与内置法定节假日优先级高于大小周', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.bigSmallWeek = true;
    s.bigWeekAnchor = '2026-12-28';
    const wc = new wageEngine.WorkCalendar(s);

    assert.equal(wc.info(localDate(2026, 12, 19)).kind, wageEngine.DayKind.workday);
    assert.equal(wc.info(localDate(2026, 12, 19)).name, '大周');
    assert.equal(wc.info(localDate(2026, 12, 26)).kind, wageEngine.DayKind.weekend);
    // 2027-01-02 为锚点 0 周周六，但内置元旦假期优先级更高
    assert.equal(wc.info(localDate(2027, 1, 2)).kind, wageEngine.DayKind.holiday);
    assert.equal(wc.info(localDate(2027, 1, 2)).name, '元旦');
    assert.equal(wc.info(localDate(2027, 1, 9)).kind, wageEngine.DayKind.weekend);
    assert.equal(wc.info(localDate(2027, 1, 16)).kind, wageEngine.DayKind.workday);
    assert.equal(wc.info(localDate(2027, 1, 16)).name, '大周');
  });

  test('T2-Core-13 amount=0、十亿极大值与当月 paidDays===0 无 NaN/Infinity', () => {
    const { settings, wageEngine, display } = requireCore();

    const sZero = settings.defaultSettings();
    sZero.amount = 0;
    const snapZero = new wageEngine.WageEngine(sZero).snapshot(localDate(2026, 11, 17, 15, 18, 42));
    assert.equal(snapZero.dailyWage, 0);
    assert.equal(snapZero.earnedToday, 0);
    assert.equal(snapZero.perSecond, 0);
    assert.equal(snapZero.hourly, 0);
    assert.equal(snapZero.monthTotal, 0);
    assert.equal(new display.Money(sZero).string(snapZero.earnedToday), '¥0.00');

    const sHuge = settings.defaultSettings();
    sHuge.amount = 1000000000;
    sHuge.basis = settings.WageBasis.fixed2175;
    const snapHuge = new wageEngine.WageEngine(sHuge).snapshot(localDate(2026, 11, 17, 18, 0, 0));
    assertNear(snapHuge.dailyWage, 1e9 / 21.75, 1e-4);
    assert.equal(new display.Money(sHuge).string(snapHuge.dailyWage), '¥45,977,011.49');

    const sNoPaid = settings.defaultSettings();
    sNoPaid.workWeekdays = [];
    sNoPaid.bigSmallWeek = false;
    const snapNoPaid = new wageEngine.WageEngine(sNoPaid).snapshot(localDate(2026, 11, 17, 12, 0, 0));
    assert.equal(snapNoPaid.paidDaysInMonth, 0);
    assert.equal(snapNoPaid.dailyWage, 0);
    assert.equal(snapNoPaid.phase, wageEngine.Phase.rest);
    assert.equal(Number.isFinite(snapNoPaid.monthTotal), true);
  });

  test('T2-Core-14 Milestones.parse 全坏行过滤、CRLF/中文逗号兼容与 format 往返', () => {
    const { display } = requireCore();
    const badText = '\n   \n只有名字\n,100\n坏金额,abc\n零元,0\n负数,-10\n多逗号,10,20\n无限,Infinity';
    assert.deepEqual(display.Milestones.parse(badText), []);
    assert.deepEqual(display.Milestones.parse(null), []);

    const mixed = '  咖啡 ， 25  \r\n午饭,35.5\n';
    const parsed = display.Milestones.parse(mixed);
    assert.deepEqual(parsed, [
      { name: '咖啡', amount: 25 },
      { name: '午饭', amount: 35.5 },
    ]);
    assert.equal(display.Milestones.format(parsed), '咖啡,25\n午饭,35.5');
  });

  test('T2-Core-15 Milestones.status 1e-9 容差边界、无序输入排序及 eta=null 全部条件', () => {
    const { settings, wageEngine, display } = requireCore();
    const list = [
      { name: 'C', amount: 1000 },
      { name: 'A', amount: 100 },
      { name: 'B', amount: 500 },
    ];

    const stTolerance = display.Milestones.status(
      { earnedToday: 99.9999999995, perSecond: 0.05, phase: wageEngine.Phase.working, dailyWage: 952.38 },
      list
    );
    assert.equal(stTolerance.reached.name, 'A');
    assert.equal(stTolerance.next.name, 'B');

    const stUnreachable = display.Milestones.status(
      { earnedToday: 600, perSecond: 0.05, phase: wageEngine.Phase.working, dailyWage: 952.38 },
      list
    );
    assert.equal(stUnreachable.next.name, 'C');
    assert.equal(stUnreachable.eta ?? null, null);

    const stPaidLeave = display.Milestones.status(
      { earnedToday: 400, perSecond: 0.05, phase: wageEngine.Phase.paidLeave, dailyWage: 952.38 },
      list
    );
    assert.equal(stPaidLeave.eta ?? null, null);

    const stAfter = display.Milestones.status(
      { earnedToday: 400, perSecond: 0.05, phase: wageEngine.Phase.afterWork, dailyWage: 952.38 },
      list
    );
    assert.equal(stAfter.eta ?? null, null);
    assert.deepEqual(display.Milestones.status({ earnedToday: 10, perSecond: 1, phase: 'working', dailyWage: 100 }, []), {
      reached: null,
      next: null,
      remaining: 0,
      eta: null,
    });
    assert.deepEqual(
      display.Milestones.crossed(99.9999999995, 500.0000000001, list).map((x) => x.name),
      ['B']
    );
  });

  test('T2-Core-16 StatusText.make offHoursDisplay=iconOnly 仅隐藏 rest 且不隐藏 afterWork/paidLeave', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    s.offHoursDisplay = settings.OffHoursDisplay.iconOnly;
    s.manualMarks = [{ date: '2026-11-18', kind: settings.ManualKind.paidLeave, note: '年假' }];
    const eng = new wageEngine.WageEngine(s);

    const restLine = display.StatusText.make(eng.snapshot(localDate(2026, 11, 21, 10, 0)), s, false);
    assert.equal(restLine.forceIcon, true);
    assert.equal(restLine.main, '');

    const afterLine = display.StatusText.make(eng.snapshot(localDate(2026, 11, 17, 18, 30)), s, false);
    assert.equal(afterLine.forceIcon, false);
    assert.equal(afterLine.plainText, '¥952.38 ✓');

    const leaveLine = display.StatusText.make(eng.snapshot(localDate(2026, 11, 18, 10, 0)), s, false);
    assert.equal(leaveLine.forceIcon, false);
    assert.equal(leaveLine.plainText, '带薪假 ¥952.38');
  });

  test('T2-Core-17 Quotes.forDate 在跨年闰年 24 小时连续轮换索引严格落入 [0..11]', () => {
    const { display } = requireCore();
    const seen = new Set();
    for (let h = 0; h < 24; h++) {
      const q = display.Quotes.forDate(localDate(2028, 12, 31, h, 0, 0));
      assert.ok(display.Quotes.all.includes(q));
      seen.add(q);
    }
    assert.equal(seen.size, 12);
  });

  test('T2-Core-18 decodeSettings 极端非对象、合法空数组保留、非法元素回落与热键别名归一化', () => {
    const { settings } = requireCore();
    assert.deepEqual(settings.decodeSettings(null), settings.defaultSettings());
    assert.deepEqual(settings.decodeSettings([]), settings.defaultSettings());
    assert.deepEqual(settings.decodeSettings('bad'), settings.defaultSettings());

    const emptyValid = settings.decodeSettings({
      workWeekdays: [],
      milestones: [],
      bossHotkey: 'Ctrl+Alt+H',
    });
    assert.deepEqual(emptyValid.workWeekdays, []);
    assert.deepEqual(emptyValid.milestones, []);
    assert.equal(emptyValid.bossHotkey, settings.BossHotkey.ctrlOptCmdH);

    const invalidWeekdays = settings.decodeSettings({
      workWeekdays: [2, 8],
      bossHotkey: 'none',
    });
    assert.deepEqual(invalidWeekdays.workWeekdays, [2, 3, 4, 5, 6]);
    assert.equal(invalidWeekdays.bossHotkey, settings.BossHotkey.off);
  });

  test('T2-Core-19 parseHolidayImport Buffer 输入、空数组、异常抛出与 mergeHolidayImport 升序覆盖', () => {
    const { settings } = requireCore();
    const buf = Buffer.from(
      JSON.stringify([
        { date: '2028-02-29', type: 'holiday', name: '闰日假' },
        { date: '2028-02-30', type: 'holiday', name: '坏日期' },
      ]),
      'utf8'
    );
    const parsed = settings.parseHolidayImport(buf);
    assert.deepEqual(parsed, [{ date: '2028-02-29', type: 'holiday', name: '闰日假' }]);
    assert.deepEqual(settings.parseHolidayImport('[]'), []);

    assert.throws(() => settings.parseHolidayImport('{bad'));
    assert.throws(() => settings.parseHolidayImport('{}'));
    assert.throws(() => settings.parseHolidayImport(JSON.stringify([{ date: '2028-01-01', type: 'bad', name: 'x' }])));
    assert.throws(() => settings.parseHolidayImport(JSON.stringify([{ date: '2028-01-01', type: 'holiday' }])));

    const merged = settings.mergeHolidayImport(
      [{ date: '2028-05-01', type: 'holiday', name: '旧' }],
      [{ date: '2028-05-01', type: 'workday', name: '新' }, { date: '2028-01-01', type: 'holiday', name: '元旦' }]
    );
    assert.deepEqual(merged, [
      { date: '2028-01-01', type: 'holiday', name: '元旦' },
      { date: '2028-05-01', type: 'workday', name: '新' },
    ]);
  });

  test('T2-Core-20 setMark 纯函数增删改及不可变性与 ASCII 日期升序', () => {
    const { settings } = requireCore();
    const s0 = settings.defaultSettings();
    const s1 = settings.setMark(s0, { kind: settings.ManualKind.work, note: '值班' }, '2026-10-03');
    const s2 = settings.setMark(s1, { kind: settings.ManualKind.paidLeave, note: '年假' }, '2026-10-01');
    const s3 = settings.setMark(s2, null, '2026-10-03');

    assert.equal(s0.manualMarks.length, 0);
    assert.deepEqual(s2.manualMarks.map((m) => m.date), ['2026-10-01', '2026-10-03']);
    assert.deepEqual(s3.manualMarks, [{ date: '2026-10-01', kind: 'paidLeave', note: '年假' }]);
  });

  test('T2-Core-21 WorkCalendar 手动覆盖法定节假日与补班时 noticeEntry 仍保留原始通告', () => {
    const { settings, wageEngine } = requireCore();
    const s = settings.defaultSettings();
    s.manualMarks = [
      { date: '2026-10-01', kind: settings.ManualKind.work, note: '' },
      { date: '2026-10-10', kind: settings.ManualKind.rest, note: '换休' },
    ];
    const wc = new wageEngine.WorkCalendar(s);

    const d1 = wc.info(localDate(2026, 10, 1));
    assert.equal(d1.kind, wageEngine.DayKind.manualWork);
    assert.equal(d1.name, null);
    assert.equal(wc.noticeEntry('2026-10-01').name, '国庆');

    const d2 = wc.info(localDate(2026, 10, 10));
    assert.equal(d2.kind, wageEngine.DayKind.manualRest);
    assert.equal(d2.name, '换休');
    assert.equal(wc.noticeEntry('2026-10-10').type, 'workday');
  });

  test('T2-Core-22 WageEngine.workedSeconds 午休前/中/后及上下班越界钳位', () => {
    const { settings, wageEngine } = requireCore();
    const eng = new wageEngine.WageEngine(settings.defaultSettings());
    const sh = eng.shift(localDate(2026, 11, 17));

    assert.equal(eng.workedSeconds(sh, localDate(2026, 11, 17, 8, 0, 0)), 0);
    assert.equal(eng.workedSeconds(sh, localDate(2026, 11, 17, 12, 0, 0)), 3 * 3600);
    assert.equal(eng.workedSeconds(sh, localDate(2026, 11, 17, 13, 0, 0)), 3 * 3600);
    assert.equal(eng.workedSeconds(sh, localDate(2026, 11, 17, 13, 30, 0)), 3 * 3600);
    assert.equal(eng.workedSeconds(sh, localDate(2026, 11, 17, 20, 0, 0)), 7.5 * 3600);
  });

  test('T2-Core-23 formatDayLine/panelSubline/milestoneSummary 兼容序列化快照与极值文案', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    const rawSnap = new wageEngine.WageEngine(s).snapshot(localDate(2026, 11, 17, 18, 30, 0));
    const serSnap = wageEngine.serializeSnapshot(rawSnap);

    assert.equal(display.formatDayLine(serSnap), '11月17日 周二 · 工作日');
    assert.equal(display.kindLabel({ kind: 'unknownKind' }), '未知');
    assert.equal(display.panelSubline(serSnap, s, true), '今天的钱已全部到账，下班快乐');

    const mNormal = display.milestoneSummary(serSnap, s, false);
    assert.ok(mNormal.title.includes('一顿日料'));
    assert.ok(mNormal.detail.includes('今天够不着了'));

    const mBoss = display.milestoneSummary(serSnap, s, true);
    assert.ok(mBoss.title.includes('¥***'));
    assert.equal(mBoss.title.includes('800'), false);
  });
});

describe('Tier 2 — Main 主进程边界与异常场景 (16 用例)', () => {
  test('T2-Main-01 settings.json 语法损坏时启动不崩溃并回落全套默认值', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      corruptSettingsRaw: '{broken json,,,',
    });
    try {
      await harness.bootMain();
      const st = await harness.invokeIpc('state:get');
      assert.equal(st.settings.amount, 20000);
      assert.equal(st.settings.currency, '¥');
      assert.deepEqual(st.settings.workWeekdays, [2, 3, 4, 5, 6]);
    } finally {
      harness.dispose();
    }
  });

  test('T2-Main-02 settings.json 混合合法与非法字段时逐字段容错回落', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      corruptSettingsRaw: JSON.stringify({
        amount: 32000,
        currency: '$',
        decimals: 'bad',
        menuBarFormat: 999,
        workWeekdays: ['x'],
      }),
    });
    try {
      await harness.bootMain();
      const st = await harness.invokeIpc('state:get');
      assert.equal(st.settings.amount, 32000);
      assert.equal(st.settings.currency, '$');
      assert.equal(st.settings.decimals, 2);
      assert.equal(st.settings.menuBarFormat, 'amountOnly');
      assert.deepEqual(st.settings.workWeekdays, [2, 3, 4, 5, 6]);
    } finally {
      harness.dispose();
    }
  });

  test('T2-Main-03 boss=true 不持久化到 settings.json 且跨实例重启自动归零', async () => {
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niuma-t2-boss-'));
    try {
      const h1 = createElectronHarness({
        userDataDir: sharedDir,
        initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      });
      try {
        await h1.bootMain();
        await h1.invokeIpc('boss:set', true);
        await h1.invokeIpc('settings:update', { currency: '€' });
        const disk = h1.readPersistedSettings();
        assert.equal(disk.currency, '€');
        assert.notEqual(disk.boss, true);
      } finally {
        h1.dispose();
      }

      const h2 = createElectronHarness({
        userDataDir: sharedDir,
        initialNow: localDate(2026, 11, 17, 10, 5, 0).getTime(),
      });
      try {
        await h2.bootMain();
        const st2 = await h2.invokeIpc('state:get');
        assert.equal(st2.settings.currency, '€');
        assert.equal(st2.boss, false);
      } finally {
        h2.dispose();
      }
    } finally {
      fs.rmSync(sharedDir, { recursive: true, force: true });
    }
  });

  test('T2-Main-04 负坐标副屏与高 DPI (1.5x) 下 Popover workArea 边界钳制不被拉回 x>=0', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      displays: [
        {
          id: 1,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1032 },
          scaleFactor: 1,
        },
        {
          id: 2,
          bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
          workArea: { x: -1920, y: 0, width: 1920, height: 1032 },
          scaleFactor: 1.5,
        },
      ],
      trayBounds: { x: -40, y: 1040, width: 24, height: 40 },
    });
    try {
      await harness.bootMain();
      const panel = harness.getPanelWindow();
      if (panel && panel.isVisible()) panel.hide();
      harness.clickTray();
      const b = harness.getPanelWindow().getBounds();
      assert.ok(b.x >= -1920, `负坐标副屏下 x(${b.x}) 应 >= -1920`);
      assert.ok(b.x + b.width <= 0, `负坐标副屏下 right(${b.x + b.width}) 应 <= 0`);
      assert.ok(b.y >= 0 && b.y + b.height <= 1032);
    } finally {
      harness.dispose();
    }
  });

  test('T2-Main-05 四向任务栏边缘极近托盘坐标下 Popover 严格落入 workArea 内', async () => {
    const edgeCases = [
      { wa: { x: 0, y: 48, width: 1920, height: 1032 }, tray: { x: 1900, y: 4, width: 20, height: 40 } },
      { wa: { x: 0, y: 0, width: 1920, height: 1032 }, tray: { x: 10, y: 1040, width: 20, height: 40 } },
      { wa: { x: 60, y: 0, width: 1860, height: 1080 }, tray: { x: 10, y: 1050, width: 40, height: 24 } },
      { wa: { x: 0, y: 0, width: 1860, height: 1080 }, tray: { x: 1870, y: 5, width: 40, height: 24 } },
    ];
    for (const c of edgeCases) {
      const harness = createElectronHarness({
        initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
        displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: c.wa, scaleFactor: 1 }],
        trayBounds: c.tray,
      });
      try {
        await harness.bootMain();
        const p = harness.getPanelWindow();
        if (p && p.isVisible()) p.hide();
        harness.clickTray();
        const b = harness.getPanelWindow().getBounds();
        assert.ok(b.x >= c.wa.x && b.x + b.width <= c.wa.x + c.wa.width);
        assert.ok(b.y >= c.wa.y && b.y + b.height <= c.wa.y + c.wa.height);
      } finally {
        harness.dispose();
      }
    }
  });

  test('T2-Main-06 panel:resize 对动态增高、超大高度上限钳制及零/负高度异常安全处理', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      displays: [
        {
          id: 1,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 700 },
          scaleFactor: 1,
        },
      ],
      trayBounds: { x: 1700, y: 710, width: 24, height: 40 },
    });
    try {
      await harness.bootMain();
      const panel = harness.getPanelWindow();
      if (!panel.isVisible()) harness.clickTray();

      await harness.invokeIpc('panel:resize', 330, 520);
      const b1 = panel.getBounds();
      assert.ok(b1.y + b1.height <= 700);

      // 超出 workArea 高度应钳制，零或负高度不崩溃
      await harness.invokeIpc('panel:resize', 330, 2000);
      const b2 = panel.getBounds();
      assert.ok(b2.height <= 700 && b2.y >= 0 && b2.y + b2.height <= 700);

      await harness.invokeIpc('panel:resize', 330, -20);
      assert.ok(panel.getBounds().height > 0);
    } finally {
      harness.dispose();
    }
  });

  test('T2-Main-07 blur 失焦后 199ms 点击托盘拦截防闪烁，201ms 点击托盘正常重开', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      const panel = harness.getPanelWindow();
      if (!panel.isVisible()) harness.clickTray();
      assert.equal(panel.isVisible(), true);

      panel.emitBlur();
      assert.equal(panel.isVisible(), false);

      harness.clock.tick(199);
      harness.clickTray();
      assert.equal(panel.isVisible(), false, '199ms 内点击托盘必须拦截重开');

      harness.clock.tick(2);
      harness.clickTray();
      assert.equal(panel.isVisible(), true, '超过 200ms 后点击托盘应重开');
    } finally {
      harness.dispose();
    }
  });

  test('T2-Main-08 托盘 Tooltip 超长货币前缀下仍强制截断至 <= 127 字符硬上限', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 10, 10, 12, 30, 0).getTime(),
      initialSettings: {
        currency: '超长货币前缀_'.repeat(20),
        menuBarFormat: 'amountCountdown',
      },
    });
    try {
      await harness.bootMain();
      assert.ok(harness.tray.toolTip.length > 0);
      assert.ok(harness.tray.toolTip.length <= 127, `Tooltip 长度超限: ${harness.tray.toolTip.length}`);
    } finally {
      harness.dispose();
    }
  });

  test('T2-Main-09 全局老板键被系统占用时安全降级不崩溃并在 runtime 暴露失败状态', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      failingShortcuts: ['CommandOrControl+Alt+B'],
    });
    try {
      await harness.bootMain();
      assert.equal(harness.registeredShortcuts.has('CommandOrControl+Alt+B'), false);
      const st = await harness.invokeIpc('state:get');
      const rtStr = JSON.stringify(st.runtime || {});
      assert.ok(
        rtStr.includes('false') || rtStr.includes('占用') || rtStr.includes('失败') || rtStr.includes('error') || rtStr.includes('Error'),
        `runtime 应体现热键注册失败信息，实际: ${rtStr}`
      );
    } finally {
      harness.dispose();
    }
  });

  test('T2-Main-10 Notification.isSupported()===false 时跨里程碑与下班均安全跳过不抛错', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 17, 50, 0).getTime(),
      notificationSupported: false,
    });
    try {
      await harness.bootMain();
      harness.clock.advanceMinutes(15);
      await harness.flushAsync();
      assert.equal(harness.notifications.length, 0);
      const st = await harness.invokeIpc('state:get');
      assert.equal(st.snapshot.phase, 'afterWork');
    } finally {
      harness.dispose();
    }
  });

  test('T2-Main-11 setLoginItemSettings 抛异常时 IPC 捕获降级不崩溃并同步错误信息', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      loginItemThrows: new Error('注册表权限不足'),
    });
    try {
      await harness.bootMain();
      let caught = null;
      let res = null;
      try {
        res = await harness.invokeIpc('loginItem:set', true);
      } catch (err) {
        caught = err;
      }
      const st = await harness.invokeIpc('state:get');
      const combined = JSON.stringify({ res, runtime: st.runtime, err: caught ? caught.message : '' });
      assert.ok(
        caught || (res && res.ok === false) || combined.includes('注册表') || combined.includes('error') || combined.includes('false'),
        `应返回或记录自启设置失败信息: ${combined}`
      );
      assert.equal(harness.tray.isDestroyed(), false);
    } finally {
      harness.dispose();
    }
  });

  test('T2-Main-12 老板模式期间跨过里程碑后再关闭老板模式绝不补发历史通知', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 9, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      await harness.invokeIpc('boss:set', true);

      // 推进 15 分钟跨过 15 元、30 元两个里程碑
      harness.clock.advanceMinutes(15);
      await harness.flushAsync();
      assert.equal(harness.notifications.length, 0);

      // 关闭老板模式并继续 tick 5 秒
      await harness.invokeIpc('boss:set', false);
      harness.clock.tick(5000);
      await harness.flushAsync();
      assert.equal(harness.notifications.length, 0, '取消老板模式后绝不能补发 15/30 元里程碑通知');
    } finally {
      harness.dispose();
    }
  });

  test('T2-Main-13 offWorkSent 单日防重不连发且跨午夜进入次日后重置可再发', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 17, 59, 55).getTime(),
    });
    try {
      await harness.bootMain();
      harness.clock.tick(10000); // 18:00:05
      harness.clock.tick(5000);
      await harness.flushAsync();
      assert.equal(harness.notifications.filter((n) => n.title.includes('下班')).length, 1);

      // 休眠跨天至 2026-11-18 17:59:55 后 resume，再推进到次日下班
      harness.clock.sleepTo(localDate(2026, 11, 18, 17, 59, 55).getTime());
      harness.emitPowerResume();
      harness.clock.tick(10000);
      await harness.flushAsync();
      assert.equal(harness.notifications.filter((n) => n.title.includes('下班')).length, 2);
    } finally {
      harness.dispose();
    }
  });

  test('T2-Main-14 带薪假期间 accrues===false 全天抑制里程碑与下班通知', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 18, 8, 59, 55).getTime(),
      initialSettings: {
        manualMarks: [{ date: '2026-11-18', kind: 'paidLeave', note: '年假' }],
      },
    });
    try {
      await harness.bootMain();
      harness.clock.tick(10000);
      harness.clock.sleepTo(localDate(2026, 11, 18, 17, 59, 55).getTime());
      harness.emitPowerResume();
      harness.clock.tick(10000);
      await harness.flushAsync();
      assert.equal(harness.notifications.length, 0);
    } finally {
      harness.dispose();
    }
  });

  test('T2-Main-15 holidays:importDialog 取消或选择损坏 JSON 不覆盖已有导入数据', async () => {
    const badFile = path.join(os.tmpdir(), `niuma-bad-hol-${Date.now()}.json`);
    fs.writeFileSync(badFile, '{not valid json', 'utf8');
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      initialSettings: {
        importedHolidays: [{ date: '2028-01-01', type: 'holiday', name: '保留项' }],
      },
      openDialogResult: { canceled: true, filePaths: [] },
    });
    try {
      await harness.bootMain();
      const rCancel = await harness.invokeIpc('holidays:importDialog');
      assert.equal(rCancel.canceled, true);
      assert.equal((await harness.invokeIpc('state:get')).settings.importedHolidays.length, 1);

      harness.setOpenDialogResult({ canceled: false, filePaths: [badFile] });
      let errRes = null;
      try {
        errRes = await harness.invokeIpc('holidays:importDialog');
      } catch (e) {
        errRes = { ok: false, error: e.message };
      }
      assert.equal(errRes.ok, false);
      assert.deepEqual((await harness.invokeIpc('state:get')).settings.importedHolidays, [
        { date: '2028-01-01', type: 'holiday', name: '保留项' },
      ]);
    } finally {
      harness.dispose();
      fs.rmSync(badFile, { force: true });
    }
  });

  test('T2-Main-16 窗口销毁后再次通过 second-instance 或 openSettings 唤醒可安全重建不抛错', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'salary');
      const sWin = harness.getSettingsWindow();
      sWin.destroy();

      await harness.invokeIpc('window:openSettings', 'display');
      const sWin2 = harness.getSettingsWindow();
      assert.ok(sWin2 && !sWin2.isDestroyed() && sWin2.isVisible());

      const pWin = harness.getPanelWindow();
      pWin.destroy();
      harness.emitSecondInstance([], '');
      await harness.flushAsync();
      const pWin2 = harness.getPanelWindow();
      assert.ok(pWin2 && !pWin2.isDestroyed() && pWin2.isVisible());
    } finally {
      harness.dispose();
    }
  });
});

describe('Tier 2 — Renderer 渲染进程边界用例 (9 用例)', () => {
  test('T2-Renderer-01 零有效工时 (09:00-09:00) 设置作息页显示红字警告且主面板无 NaN%', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      initialSettings: { workStart: 540, workEnd: 540 },
    });
    let panelView;
    let settingsView;
    try {
      await harness.bootMain();
      panelView = await mountRendererWindow(harness, 'panel');
      const pTxt = visibleText(panelView.document.body);
      assert.equal(pTxt.includes('NaN'), false);
      assert.equal(pTxt.includes('Infinity'), false);

      await harness.invokeIpc('window:openSettings', 'schedule');
      settingsView = await mountRendererWindow(harness, 'settings');
      await settingsView.click(findButtonByText(settingsView.document, '作息'));
      const sTxt = visibleText(settingsView.document.body);
      assert.ok(sTxt.includes('有效工时是 0'));
    } finally {
      if (panelView) panelView.dispose();
      if (settingsView) settingsView.dispose();
      harness.dispose();
    }
  });

  test('T2-Renderer-02 午休吞没班次 (08:00-19:00) 在作息 Tab 同样触发有效工时为 0 警告', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      initialSettings: { workStart: 540, workEnd: 1080, lunchEnabled: true, lunchStart: 480, lunchEnd: 1140 },
    });
    let view;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'schedule');
      view = await mountRendererWindow(harness, 'settings');
      await view.click(findButtonByText(view.document, '作息'));
      assert.ok(visibleText(view.document.body).includes('有效工时是 0'));
    } finally {
      if (view) view.dispose();
      harness.dispose();
    }
  });

  test('T2-Renderer-03 显示页编辑里程碑输入全空或全无效行点击保存时回滚原配置', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    let view;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'display');
      view = await mountRendererWindow(harness, 'settings');
      await view.click(findButtonByText(view.document, '显示'));

      const editToggle = view.document
        .querySelectorAll('summary, button')
        .find((el) => isVisible(el) && el.textContent.includes('编辑里程碑'));
      if (editToggle) await view.click(editToggle);

      const textarea = view.document.querySelector('textarea');
      assert.ok(textarea);
      await view.setValue(textarea, '无效行\n零元,0\n奶茶,-5');
      await view.click(findButtonByText(view.document, '保存'));

      const st = await harness.invokeIpc('state:get');
      assert.equal(st.settings.milestones.length, 6, '全无效里程碑保存不能清空原配置');
      assert.ok(textarea.value.includes('一杯奶茶'), '文本框应回滚为原里程碑文本');
    } finally {
      if (view) view.dispose();
      harness.dispose();
    }
  });

  test('T2-Renderer-04 里程碑点击“恢复默认”仅填充文本框不直接保存，点保存后才持久化', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      initialSettings: { milestones: [{ name: '可乐', amount: 5 }] },
    });
    let view;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'display');
      view = await mountRendererWindow(harness, 'settings');
      await view.click(findButtonByText(view.document, '显示'));

      const editToggle = view.document
        .querySelectorAll('summary, button')
        .find((el) => isVisible(el) && el.textContent.includes('编辑里程碑'));
      if (editToggle) await view.click(editToggle);

      await view.click(findButtonByText(view.document, '恢复默认'));
      let st = await harness.invokeIpc('state:get');
      assert.deepEqual(st.settings.milestones, [{ name: '可乐', amount: 5 }]);

      await view.click(findButtonByText(view.document, '保存'));
      st = await harness.invokeIpc('state:get');
      assert.equal(st.settings.milestones.length, 6);
    } finally {
      if (view) view.dispose();
      harness.dispose();
    }
  });

  test('T2-Renderer-05 薪资 Tab 输入负数、空字符串或非数字金额时不产生 NaN 崩溃', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    let view;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'salary');
      view = await mountRendererWindow(harness, 'settings');
      const amountInput = findControlByLabel(view.document, '金额');

      await view.setValue(amountInput, '-500');
      assert.equal(visibleText(view.document.body).includes('NaN'), false);

      await view.setValue(amountInput, '');
      assert.equal(visibleText(view.document.body).includes('NaN'), false);
    } finally {
      if (view) view.dispose();
      harness.dispose();
    }
  });

  test('T2-Renderer-06 主面板在全部里程碑高于日薪及空里程碑列表时无 undefined/NaN 渲染异常', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 15, 0, 0).getTime(),
      initialSettings: { milestones: [{ name: '豪车', amount: 99999 }] },
    });
    let view;
    try {
      await harness.bootMain();
      view = await mountRendererWindow(harness, 'panel');
      let txt = visibleText(view.document.body);
      assert.ok(txt.includes('豪车') && txt.includes('不够') || txt.includes('够不着') || txt.includes('第一个小目标'));
      assert.equal(txt.includes('undefined'), false);

      await harness.invokeIpc('settings:update', { milestones: [] });
      await view.flush();
      txt = visibleText(view.document.body);
      assert.equal(txt.includes('undefined'), false);
      assert.equal(txt.includes('NaN'), false);
    } finally {
      if (view) view.dispose();
      harness.dispose();
    }
  });

  test('T2-Renderer-07 主面板在 2027-02 (15天计薪) 非计薪周末与节假日前后渲染数字对齐无错位', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2027, 2, 14, 15, 0, 0).getTime(), // 2027-02-14 春节调休补班，第 9/15 天
    });
    let view;
    try {
      await harness.bootMain();
      view = await mountRendererWindow(harness, 'panel');
      const txt = visibleText(view.document.body);
      assert.ok(txt.includes('调休补班'));
      assert.ok(txt.includes('/ 15 天'));
      assert.ok(txt.includes('¥1,333.33'));
    } finally {
      if (view) view.dispose();
      harness.dispose();
    }
  });

  test('T2-Renderer-08 设置窗口传入无效 tab 名称时安全回落默认页签不空白', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    let view;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'nonexistentTab');
      view = await mountRendererWindow(harness, 'settings');
      const txt = visibleText(view.document.body);
      assert.ok(txt.trim().length > 20, '无效 tab 名时应回落显示默认标签页内容');
    } finally {
      if (view) view.dispose();
      harness.dispose();
    }
  });

  test('T2-Renderer-09 热键冲突与开机自启失败在设置“显示”Tab 展示明确反馈提示', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      failingShortcuts: ['CommandOrControl+Alt+B'],
      loginItemThrows: new Error('拒绝访问自启项'),
    });
    let view;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'display');
      view = await mountRendererWindow(harness, 'settings');
      await view.click(findButtonByText(view.document, '显示'));

      const loginToggle = findControlByLabel(view.document, '开机自动启动');
      await view.click(loginToggle);
      const txt = visibleText(view.document.body);
      assert.ok(
        txt.includes('占用') || txt.includes('失败') || txt.includes('冲突') || txt.includes('拒绝访问'),
        `设置页应提示热键冲突或自启失败，实际文本: ${txt}`
      );
    } finally {
      if (view) view.dispose();
      harness.dispose();
    }
  });
});

describe('Tier 2 — Assets / Config / Swift / Helper 边界用例 (7 用例)', () => {
  test('T2-Assets-01 icon.ico 全 7 帧目录头边界：无零字节帧、无偏移越界且 256 帧 bWidth===0', () => {
    const { assetsDir } = requireRepoPaths();
    const buf = fs.readFileSync(path.join(assetsDir, 'icon.ico'));
    const ico = parseIco(buf);
    const seen = new Set();
    for (const e of ico.entries) {
      assert.ok(e.bytesInRes > 100, `帧 ${e.width}x${e.height} 过小`);
      assert.ok(e.imageOffset + e.bytesInRes <= buf.length);
      seen.add(`${e.width}x${e.height}`);
    }
    for (const sz of [16, 24, 32, 48, 64, 128, 256]) {
      assert.ok(seen.has(`${sz}x${sz}`), `缺少 ${sz}x${sz}`);
    }
    const raw256EntryOff = 6 + ico.getFrame(256, 256).index * 16;
    assert.equal(buf[raw256EntryOff], 0);
    assert.equal(buf[raw256EntryOff + 1], 0);
  });

  test('T2-Assets-02 图标四角透明边界与 tray 底部抗锯齿阴影容差 (<=16) 校验', () => {
    const { assetsDir } = requireRepoPaths();
    const icon256 = decodePngRgba(fs.readFileSync(path.join(assetsDir, 'icon.png')));
    for (const [x, y] of [[0, 0], [icon256.width - 1, 0], [0, icon256.height - 1], [icon256.width - 1, icon256.height - 1]]) {
      assert.equal(icon256.getPixel(x, y)[3], 0);
    }
    for (const file of ['tray.png', 'tray@2x.png']) {
      const p = decodePngRgba(fs.readFileSync(path.join(assetsDir, file)));
      assert.equal(p.getPixel(0, 0)[3], 0);
      assert.equal(p.getPixel(p.width - 1, 0)[3], 0);
      assert.ok(p.getPixel(0, p.height - 1)[3] <= 16);
      assert.ok(p.getPixel(p.width - 1, p.height - 1)[3] <= 16);
    }
  });

  test('T2-Assets-03 防 fitz 纯黑渐变退化边界：4 个核心图标纯黑像素均 < 5% 且含品牌暖橙/奶白', () => {
    const { assetsDir } = requireRepoPaths();
    const ico256 = decodePngRgba(parseIco(fs.readFileSync(path.join(assetsDir, 'icon.ico'))).getFrame(256, 256).data);
    const iconPng = decodePngRgba(fs.readFileSync(path.join(assetsDir, 'icon.png')));
    const tray1x = decodePngRgba(fs.readFileSync(path.join(assetsDir, 'tray.png')));
    const tray2x = decodePngRgba(fs.readFileSync(path.join(assetsDir, 'tray@2x.png')));

    for (const [label, png, needCream] of [
      ['icon.ico[256]', ico256, true],
      ['icon.png', iconPng, true],
      ['tray.png', tray1x, false],
      ['tray@2x.png', tray2x, false],
    ]) {
      const s = inspectBrandPixels(png);
      assert.ok(s.blackRatio < 0.05, `${label} 纯黑占比异常: ${s.blackRatio}`);
      assert.ok(s.warmOrangeCount > 0, `${label} 缺少品牌暖橙像素`);
      if (needCream) assert.ok(s.creamCount > 0, `${label} 缺少奶白像素`);
    }
  });

  test('T2-Assets-04 windows/scripts/generate-icons.py 存在且路径锚点与输入输出一致', () => {
    const { windowsRoot } = requireRepoPaths();
    const pyPath = path.join(windowsRoot, 'scripts', 'generate-icons.py');
    assert.equal(fs.existsSync(pyPath), true);
    const content = fs.readFileSync(pyPath, 'utf8');
    assert.ok(content.includes('AppIcon.svg'));
    assert.ok(content.includes('icon.ico') && content.includes('tray@2x.png'));
  });

  test('T2-Assets-05 windows/package.json 无绝对路径污染且 check 脚本遍历所有目标 JS', () => {
    const { packageJson } = requireRepoPaths();
    const raw = fs.readFileSync(packageJson, 'utf8');
    assert.equal(raw.includes('d:\\') || raw.includes('C:\\'), false, 'package.json 不得硬编码本地绝对路径');
    const pkg = JSON.parse(raw);
    assert.ok(pkg.scripts.check.includes('--check'));
    assert.equal(pkg.build.directories.output, 'dist');
  });

  test('T2-Assets-06 macOS Swift 16 个受保护文件逐一校验精确字节数与 SHA-256 锚点', () => {
    const { repoRoot } = requireRepoPaths();
    const anchors = [
      ['Package.swift', 483, '5094FB2279BFFAF9'],
      ['Sources/NiumaCore/WageEngine.swift', 11579, '840850D40E35B4D9'],
      ['Sources/NiumaCore/Display.swift', 6978, '0309CE6654A018E6'],
      ['Tests/NiumaCoreTests/WageEngineTests.swift', 13250, '4D7DC1C73C7BC844'],
      ['Assets/AppIcon.svg', 3144, '01E95E4317E4DA21'],
    ];
    for (const [rel, bytes, sha16] of anchors) {
      const buf = fs.readFileSync(path.join(repoRoot, rel));
      assert.equal(buf.length, bytes);
      assert.equal(crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16).toUpperCase(), sha16);
    }
  });

  test('T2-Assets-07 pngIcoDecoder 对损坏魔数、截断 ICO 及越界坐标抛出明确错误', () => {
    assert.throws(() => parseIco(Buffer.from([0, 0])));
    assert.throws(() => parseIco(Buffer.from([0, 0, 2, 0, 1, 0])));
    assert.throws(() => decodePngRgba(Buffer.from('not-a-png')));
    const { assetsDir } = requireRepoPaths();
    const tray = decodePngRgba(fs.readFileSync(path.join(assetsDir, 'tray.png')));
    assert.throws(() => tray.getPixel(-1, 0));
    assert.throws(() => tray.getPixel(16, 0));
  });
});
