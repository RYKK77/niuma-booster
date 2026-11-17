'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createElectronHarness } = require('./helpers/electronMock');
const { mountRendererWindow } = require('./helpers/domHarness');
const {
  requireCore,
  toMs,
  applyBigSmallWeek,
  localDate,
} = require('./helpers/coreCompat');

function assertNear(actual, expected, eps = 1e-6, msg) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${msg ? msg + ': ' : ''}期望 ${expected} (±${eps})，实际 ${actual}`
  );
}

// --- 渲染进程黑盒语义定位辅助 ---

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

function findInteractiveChoice(doc, substr) {
  const candidates = doc
    .querySelectorAll('button, input[type="radio"], input[type="checkbox"], option, [role="radio"], [role="tab"], label')
    .filter((el) => {
      if (!isVisible(el)) return false;
      if (el.localName === 'label') {
        const hasCtrl = Boolean(el.querySelector('input, select') || (el.getAttribute('for') && doc.getElementById(el.getAttribute('for'))));
        return hasCtrl && el.textContent.includes(substr);
      }
      if (el.localName === 'input') {
        const lbl = el.closest('label');
        const aria = el.getAttribute('aria-label') || el.title || '';
        return aria.includes(substr) || (lbl && lbl.textContent.includes(substr));
      }
      return el.textContent.includes(substr);
    });
  assert.ok(candidates.length > 0, `未找到包含 "${substr}" 的可交互选项`);
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

describe('Tier 3 — Core 跨功能成对组合测试 (8 用例)', () => {
  test('T3-Core-01 年薪 + fixed2175 + 调休补班 + amountProgress + 老板模式切换', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    s.incomeType = settings.IncomeType.yearly;
    s.amount = 360000;
    s.basis = settings.WageBasis.fixed2175;
    s.menuBarFormat = settings.MenuBarFormat.amountProgress;
    s.decimals = 2;

    const snap = new wageEngine.WageEngine(s).snapshot(localDate(2026, 10, 10, 10, 0, 0));
    const money = new display.Money(s);
    assert.equal(snap.day.kind, wageEngine.DayKind.makeupWorkday);
    assert.equal(money.string(snap.dailyWage), '¥1,379.31');
    assert.equal(money.string(snap.earnedToday), '¥183.91');
    assert.equal(Math.floor(snap.progress * 100), 13);

    const normal = display.StatusText.make(snap, s, false);
    assert.equal(normal.badge, '班');
    assert.equal(normal.prefix ?? null, null);
    assert.equal(normal.main, '¥184 · 13%');
    assert.equal(normal.check, false);
    assert.equal(normal.plainText, '班 ¥184 · 13%');

    const boss = display.StatusText.make(snap, s, true);
    assert.equal(boss.badge, '班');
    assert.equal(boss.main, '¥*** · 13%');
    assert.equal(boss.plainText, '班 ¥*** · 13%');
  });

  test('T3-Core-02 时薪 + 跨夜班 + 跨午夜午休 + 大小周 + 里程碑 + amountCountdown', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    s.incomeType = settings.IncomeType.hourly;
    s.amount = 120;
    s.workStart = 21 * 60;
    s.workEnd = 6 * 60;
    s.lunchEnabled = true;
    s.lunchStart = 60;
    s.lunchEnd = 150;
    s.bigSmallWeek = true;
    s.bigWeekAnchor = '2026-12-28';
    s.menuBarFormat = settings.MenuBarFormat.amountCountdown;

    const snap = new wageEngine.WageEngine(s).snapshot(localDate(2027, 1, 17, 3, 0, 0));
    assert.equal(toMs(snap.shiftDay), localDate(2027, 1, 16).getTime());
    assert.equal(snap.day.kind, wageEngine.DayKind.workday);
    assert.equal(snap.day.name, '大周');
    assert.equal(snap.shift.effectiveSeconds, 7.5 * 3600);
    assertNear(snap.dailyWage, 900, 1e-9);
    assertNear(snap.hourly, 120, 1e-9);
    assertNear(snap.perSecond, 1 / 30, 1e-9);
    assertNear(snap.earnedToday, 540, 1e-6);
    assert.equal(snap.secondsToEnd, 10800);

    assert.equal(display.StatusText.make(snap, s, false).main, '¥540.00 · 3:00:00');
    const ms = display.Milestones.status(snap, settings.DEFAULT_MILESTONES);
    assert.equal(ms.reached.name, '一顿火锅');
    assert.equal(ms.next.name, '一顿日料');
    assertNear(ms.remaining, 260, 1e-6);
    assertNear(ms.eta, 7800, 1e-6);
    assert.equal(display.Duration.words(ms.eta), '2 小时 10 分');
  });

  test('T3-Core-03 4 级优先级同月交织 + actualWorkdays 日薪动态联动', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    s.importedHolidays = [{ date: '2026-05-09', type: settings.HolidayEntryType.holiday, name: '司庆放假' }];
    s.manualMarks = [{ date: '2026-05-01', kind: settings.ManualKind.paidLeave, note: '值班调休' }];
    const eng = new wageEngine.WageEngine(s);

    const may1 = eng.snapshot(localDate(2026, 5, 1, 11, 0, 0));
    assert.equal(may1.paidDaysInMonth, 19);
    assert.equal(may1.paidDayIndex, 1);
    assert.equal(may1.day.kind, wageEngine.DayKind.paidLeave);
    assert.equal(may1.phase, wageEngine.Phase.paidLeave);
    assert.equal(new display.Money(s).string(may1.earnedToday), '¥1,052.63');
    assert.equal(display.StatusText.make(may1, s, false).plainText, '带薪假 ¥1,052.63');
    assert.equal(display.formatDayLine(may1), '5月1日 周五 · 带薪假（值班调休）');

    const may9 = eng.snapshot(localDate(2026, 5, 9, 11, 0, 0));
    assert.equal(may9.day.kind, wageEngine.DayKind.holiday);
    assert.equal(may9.day.name, '司庆放假');
    assert.equal(may9.phase, wageEngine.Phase.rest);
    assert.equal(may9.earnedToday, 0);
    assert.equal(display.StatusText.make(may9, s, false).main, '司庆放假休息');
  });

  test('T3-Core-04 offHoursDisplay × menuBarFormat 在法定假日/周末/下班后全交叉矩阵', () => {
    const { settings, wageEngine, display } = requireCore();
    const points = [
      localDate(2026, 10, 2, 10, 0, 0),
      localDate(2026, 11, 21, 10, 0, 0),
      localDate(2026, 11, 17, 18, 30, 0),
    ];

    for (const offHours of [settings.OffHoursDisplay.text, settings.OffHoursDisplay.iconOnly]) {
      for (const fmt of [settings.MenuBarFormat.amountOnly, settings.MenuBarFormat.iconOnly]) {
        const s = settings.defaultSettings();
        s.offHoursDisplay = offHours;
        s.menuBarFormat = fmt;
        const eng = new wageEngine.WageEngine(s);

        for (const dt of points) {
          const snap = eng.snapshot(dt);
          const line = display.StatusText.make(snap, s, false);
          if (fmt === settings.MenuBarFormat.iconOnly) {
            assert.equal(line.forceIcon, true);
            assert.equal(line.main, '');
          } else if (snap.phase === wageEngine.Phase.rest && offHours === settings.OffHoursDisplay.iconOnly) {
            assert.equal(line.forceIcon, true);
            assert.equal(line.main, '');
          } else if (snap.phase === wageEngine.Phase.afterWork) {
            assert.equal(line.forceIcon, false);
            assert.equal(line.plainText, '¥952.38 ✓');
          } else {
            assert.equal(line.forceIcon, false);
            assert.ok(line.main.includes('休息'));
          }
        }
      }
    }
  });

  test('T3-Core-05 零固定工作日 + 大小周 + 手动上班 + 4位小数 decodeSettings 组合', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.parseSettingsJson(
      JSON.stringify({
        workWeekdays: [],
        bigSmallWeek: true,
        bigWeekAnchor: '2026-11-16',
        manualMarks: [{ date: '2026-11-18', kind: 'work', note: '特勤' }],
        decimals: 4,
      })
    );
    const snap = new wageEngine.WageEngine(s).snapshot(localDate(2026, 11, 18, 18, 0, 0));
    assert.deepEqual(s.workWeekdays, []);
    assert.equal(snap.paidDaysInMonth, 3);
    assert.equal(snap.paidDayIndex, 2);
    assert.equal(new display.Money(s).string(snap.dailyWage), '¥6,666.6667');
    assert.equal(display.StatusText.make(snap, s, true).plainText, '¥***.**** ✓');
  });

  test('T3-Core-06 跨年跨月夜班 + 跨午夜午休 + Milestones.crossed + Quotes + amountCountdown', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    s.workStart = 22 * 60;
    s.workEnd = 6 * 60;
    s.lunchEnabled = true;
    s.lunchStart = 23 * 60 + 30;
    s.lunchEnd = 30;
    s.menuBarFormat = settings.MenuBarFormat.amountCountdown;
    const eng = new wageEngine.WageEngine(s);

    const atLunch = eng.snapshot(localDate(2027, 1, 1, 0, 15, 0));
    assert.equal(atLunch.phase, wageEngine.Phase.lunch);
    assert.equal(toMs(atLunch.shiftDay), localDate(2026, 12, 31).getTime());
    assert.deepEqual(
      display.Milestones.crossed(0, atLunch.earnedToday, s.milestones).map((m) => m.amount),
      [15, 30, 60, 150]
    );

    const atWork = eng.snapshot(localDate(2027, 1, 1, 5, 30, 0));
    assert.equal(atWork.phase, wageEngine.Phase.working);
    const crossed = display.Milestones.crossed(atLunch.earnedToday, atWork.earnedToday, s.milestones);
    assert.deepEqual(crossed.map((m) => m.amount), [800]);
    assert.ok(display.StatusText.make(atWork, s, false).main.includes('0:30:00'));
    assert.ok(display.Quotes.all.includes(display.Quotes.forDate(localDate(2027, 1, 1, 5, 30, 0))));
  });

  test('T3-Core-07 年薪 + actualWorkdays + 大小周 + 手动带薪假组合下 Milestones eta 为 null', () => {
    const { settings, wageEngine, display } = requireCore();
    let s = settings.defaultSettings();
    s.incomeType = settings.IncomeType.yearly;
    s.amount = 360000;
    s = applyBigSmallWeek(settings, s, true, localDate(2026, 11, 17));
    s = settings.setMark(s, { kind: settings.ManualKind.paidLeave, note: '年假' }, '2026-11-21');

    const snap = new wageEngine.WageEngine(s).snapshot(localDate(2026, 11, 21, 10, 0, 0));
    assert.equal(snap.paidDaysInMonth, 23);
    assert.equal(snap.phase, wageEngine.Phase.paidLeave);
    assertNear(snap.earnedToday, 30000 / 23, 1e-6);
    assert.equal(display.Milestones.status(snap, s.milestones).eta ?? null, null);
  });

  test('T3-Core-08 自定义货币 3 位小数 + parseHolidayImport 过滤合并 + WorkCalendar 计薪联动', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    s.currency = 'HK$';
    s.decimals = 3;
    const valid = settings.parseHolidayImport(
      JSON.stringify([
        { date: '2026-11-18', type: 'holiday', name: '港股休市' },
        { date: '2026-11-31', type: 'holiday', name: '坏日期' },
      ])
    );
    s.importedHolidays = settings.mergeHolidayImport(s.importedHolidays, valid);

    const eng = new wageEngine.WageEngine(s);
    const snap = eng.snapshot(localDate(2026, 11, 17, 18, 0, 0));
    assert.equal(snap.paidDaysInMonth, 20);
    assert.equal(new display.Money(s).string(snap.dailyWage), 'HK$1,000.000');
    assert.equal(display.StatusText.make(snap, s, false).plainText, 'HK$1,000.000 ✓');
  });
});

describe('Tier 3 — Main + Preload + Renderer 成对组合联动测试 (10 用例)', () => {
  test('T3-Main-01 多窗口双向状态同步：设置页/快捷键切换老板模式同步托盘、面板与里程碑', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 15, 18, 42).getTime(),
    });
    let panelView;
    let settingsView;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'display');
      panelView = await mountRendererWindow(harness, 'panel');
      settingsView = await mountRendererWindow(harness, 'settings');
      await settingsView.click(findButtonByText(settingsView.document, '显示'));

      const bossToggle = findControlByLabel(settingsView.document, '现在开启');
      await settingsView.click(bossToggle);
      await panelView.flush();

      assert.ok(harness.tray.toolTip.includes('¥***.**'));
      const pTxt = visibleText(panelView.document.body);
      assert.ok(pTxt.includes('¥***.**'));
      assert.ok(pTxt.includes('一顿火锅'));
      assert.equal(pTxt.includes('611.01'), false);
      assert.ok(visibleText(settingsView.document.body).includes('¥***.**'));

      harness.rightClickTray();
      const menu = harness.tray.contextMenu || harness.tray.lastPoppedMenu;
      assert.equal(menu.findItem('老板模式').checked, true);

      // 通过全局热键解除老板模式
      harness.triggerShortcut('CommandOrControl+Alt+B');
      await panelView.flush();
      await settingsView.flush();
      assert.ok(visibleText(panelView.document.body).includes('¥611.01'));
    } finally {
      if (panelView) panelView.dispose();
      if (settingsView) settingsView.dispose();
      harness.dispose();
    }
  });

  test('T3-Main-02 节假日月历改当日为带薪假即时联动主面板、ShiftBar 隐藏与 Tooltip', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    let panelView;
    let settingsView;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'holidays');
      panelView = await mountRendererWindow(harness, 'panel');
      settingsView = await mountRendererWindow(harness, 'settings');
      await settingsView.click(findButtonByText(settingsView.document, '节假日'));

      assert.ok(visibleText(panelView.document.body).includes('有效工时'));

      const dayBtn = settingsView.document.querySelectorAll('button').find((b) => {
        if (!isVisible(b)) return false;
        const aria = b.getAttribute('aria-label') || '';
        return aria.includes('11月17日') || /^17(\D|$)/.test(b.textContent.trim());
      });
      assert.ok(dayBtn);
      await settingsView.click(dayBtn);
      await settingsView.click(findInteractiveChoice(settingsView.document, '带薪假'));
      await settingsView.setValue(findControlByLabel(settingsView.document, '备注'), '年假');
      await panelView.flush();

      const pTxt = visibleText(panelView.document.body);
      assert.ok(pTxt.includes('带薪假，全天照算'));
      assert.equal(pTxt.includes('有效工时'), false);
      assert.ok(harness.tray.toolTip.includes('带薪假'));
      assert.equal(harness.readPersistedSettings().manualMarks[0].kind, 'paidLeave');
    } finally {
      if (panelView) panelView.dispose();
      if (settingsView) settingsView.dispose();
      harness.dispose();
    }
  });

  test('T3-Main-03 大小周 + 跨夜班 (22:00-06:00) + amountCountdown 在主进程与面板跨午夜联动', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 21, 23, 30, 0).getTime(), // 2026-11-21 大周六
      initialSettings: {
        workStart: 22 * 60,
        workEnd: 6 * 60,
        lunchEnabled: true,
        lunchStart: 60,
        lunchEnd: 120,
        bigSmallWeek: true,
        bigWeekAnchor: '2026-11-16',
        menuBarFormat: 'amountCountdown',
      },
    });
    let panelView;
    try {
      await harness.bootMain();
      panelView = await mountRendererWindow(harness, 'panel');
      assert.ok(visibleText(panelView.document.body).includes('大周周六'));
      assert.ok(harness.tray.toolTip.includes('6:30:00'));

      harness.clock.sleepTo(localDate(2026, 11, 22, 2, 30, 0).getTime());
      harness.emitPowerResume();
      await panelView.flush();
      assert.ok(visibleText(panelView.document.body).includes('大周周六'));
      assert.ok(harness.tray.toolTip.includes('3:30:00'));
    } finally {
      if (panelView) panelView.dispose();
      harness.dispose();
    }
  });

  test('T3-Main-04 JSON 导入节假日 + 月历统计刷新 + 清除导入完整闭环', async () => {
    const tmpJson = path.join(os.tmpdir(), `niuma-t3-hol-${Date.now()}.json`);
    fs.writeFileSync(
      tmpJson,
      JSON.stringify([
        { date: '2028-01-01', type: 'holiday', name: '元旦' },
        { date: '2028-01-02', type: 'workday', name: '补班' },
      ]),
      'utf8'
    );
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      openDialogResult: { canceled: false, filePaths: [tmpJson] },
    });
    let view;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'holidays');
      view = await mountRendererWindow(harness, 'settings');
      await view.click(findButtonByText(view.document, '节假日'));

      await view.click(findButtonByText(view.document, '导入 JSON'));
      assert.ok(visibleText(view.document.body).includes('另外导入了 2 天') || visibleText(view.document.body).includes('已导入 2 天'));

      await view.click(findButtonByText(view.document, '清除导入'));
      assert.equal((await harness.invokeIpc('state:get')).settings.importedHolidays.length, 0);
    } finally {
      if (view) view.dispose();
      harness.dispose();
      fs.rmSync(tmpJson, { force: true });
    }
  });

  test('T3-Main-05 薪资口径切换 (monthly -> hourly) 实时刷新主面板与设置预览日薪', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 15, 0, 0).getTime(),
    });
    let panelView;
    let settingsView;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'salary');
      panelView = await mountRendererWindow(harness, 'panel');
      settingsView = await mountRendererWindow(harness, 'settings');

      const hourlyChoice = findInteractiveChoice(settingsView.document, '时薪');
      if (hourlyChoice.localName === 'option') {
        await settingsView.setValue(hourlyChoice.parentElement, hourlyChoice.value);
      } else {
        await settingsView.click(hourlyChoice);
      }
      await settingsView.setValue(findControlByLabel(settingsView.document, '金额'), '200');
      await panelView.flush();

      const pTxt = visibleText(panelView.document.body);
      assert.ok(pTxt.includes('¥1,500.00'));
      assert.ok(pTxt.includes('¥200.00'));
    } finally {
      if (panelView) panelView.dispose();
      if (settingsView) settingsView.dispose();
      harness.dispose();
    }
  });

  test('T3-Main-06 午休开关关闭与重启联动主面板 ShiftBar 午休文案与干饭中状态', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 12, 30, 0).getTime(),
    });
    let panelView;
    let settingsView;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'schedule');
      panelView = await mountRendererWindow(harness, 'panel');
      settingsView = await mountRendererWindow(harness, 'settings');
      await settingsView.click(findButtonByText(settingsView.document, '作息'));

      assert.ok(visibleText(panelView.document.body).includes('干饭中'));
      assert.ok(harness.tray.toolTip.includes('干饭中'));

      const lunchToggle = findControlByLabel(settingsView.document, '午休');
      await settingsView.click(lunchToggle);
      await panelView.flush();

      assert.equal(visibleText(panelView.document.body).includes('干饭中'), false);
      assert.equal(harness.tray.toolTip.includes('干饭中'), false);
    } finally {
      if (panelView) panelView.dispose();
      if (settingsView) settingsView.dispose();
      harness.dispose();
    }
  });

  test('T3-Main-07 老板键预设切换 (ctrlOptB -> ctrlOptCmdH -> off) 与托盘右键菜单文本同步', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      await harness.invokeIpc('settings:update', { bossHotkey: 'ctrlOptCmdH' });
      assert.equal(harness.registeredShortcuts.has('CommandOrControl+Alt+H'), true);
      assert.equal(harness.registeredShortcuts.has('CommandOrControl+Alt+B'), false);

      harness.rightClickTray();
      const menu = harness.tray.contextMenu || harness.tray.lastPoppedMenu;
      assert.ok(menu.findItem('老板模式').label.includes('Ctrl+Alt+H') || menu.findItem('老板模式').accelerator);

      harness.triggerShortcut('CommandOrControl+Alt+H');
      assert.equal((await harness.invokeIpc('state:get')).boss, true);

      await harness.invokeIpc('settings:update', { bossHotkey: 'off' });
      assert.equal(harness.registeredShortcuts.size, 0);
    } finally {
      harness.dispose();
    }
  });

  test('T3-Main-08 自定义里程碑保存 + 开关联动主面板卡片显隐与系统通知', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 9, 0, 0).getTime(),
    });
    let panelView;
    let settingsView;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'display');
      panelView = await mountRendererWindow(harness, 'panel');
      settingsView = await mountRendererWindow(harness, 'settings');
      await settingsView.click(findButtonByText(settingsView.document, '显示'));

      const editToggle = settingsView.document
        .querySelectorAll('summary, button')
        .find((el) => isVisible(el) && el.textContent.includes('编辑里程碑'));
      if (editToggle) await settingsView.click(editToggle);
      await settingsView.setValue(settingsView.document.querySelector('textarea'), '早餐包子,10\n午餐加鸡腿,40');
      await settingsView.click(findButtonByText(settingsView.document, '保存'));
      await panelView.flush();

      assert.ok(visibleText(panelView.document.body).includes('早餐包子'));

      harness.clock.advanceMinutes(6);
      await harness.flushAsync();
      assert.equal(harness.notifications.length, 1);
      assert.ok(harness.notifications[0].title.includes('早餐包子'));
    } finally {
      if (panelView) panelView.dispose();
      if (settingsView) settingsView.dispose();
      harness.dispose();
    }
  });

  test('T3-Main-09 周末 offHoursDisplay 与 quotesEnabled 组合控制 Tooltip 与主面板语录', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 21, 10, 0, 0).getTime(),
    });
    let panelView;
    try {
      await harness.bootMain();
      panelView = await mountRendererWindow(harness, 'panel');
      assert.ok(harness.tray.toolTip.includes('休息'));

      await harness.invokeIpc('settings:update', { offHoursDisplay: 'iconOnly', quotesEnabled: false });
      await panelView.flush();
      assert.equal(harness.tray.toolTip.includes('休息'), false);
      const { display } = requireCore();
      const txt = visibleText(panelView.document.body);
      for (const q of display.Quotes.all) {
        assert.equal(txt.includes(q), false);
      }
    } finally {
      if (panelView) panelView.dispose();
      harness.dispose();
    }
  });

  test('T3-Main-10 主面板内容高度变化触发 ResizeObserver -> resizePanel -> 底部工作区自动重定位', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 21, 10, 0, 0).getTime(),
      displays: [
        {
          id: 1,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1032 },
          scaleFactor: 1,
        },
      ],
      trayBounds: { x: 1700, y: 1040, width: 24, height: 40 },
    });
    let panelView;
    try {
      await harness.bootMain();
      harness.clickTray();
      panelView = await mountRendererWindow(harness, 'panel');
      await panelView.triggerResize(330, 260);
      const bSmall = harness.getPanelWindow().getBounds();

      // 临时改为工作日并增大高度，重定位后底边仍不越出 workArea
      await harness.invokeIpc('settings:update', {
        manualMarks: [{ date: '2026-11-21', kind: 'work', note: '加班' }],
      });
      await panelView.flush();
      await panelView.triggerResize(330, 500);
      const bLarge = harness.getPanelWindow().getBounds();

      assert.equal(bLarge.height, 500);
      assert.ok(bLarge.y <= bSmall.y);
      assert.ok(bLarge.y + bLarge.height <= 1032);
    } finally {
      if (panelView) panelView.dispose();
      harness.dispose();
    }
  });
});
