'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
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

describe('Tier 4 — 真实打工人全生命周期端到端应用场景 (8 场景)', () => {
  test('T4-01 场景1：春节前调休补班全天生命周期 (Core + 显示 + 里程碑 + 语录 + 老板模式)', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    s.amount = 24000;
    s.menuBarFormat = settings.MenuBarFormat.amountCountdown;
    const eng = new wageEngine.WageEngine(s);
    const money = new display.Money(s);

    // 1. 08:45 上班前
    const t1 = eng.snapshot(localDate(2026, 2, 14, 8, 45, 0));
    assert.equal(t1.phase, wageEngine.Phase.beforeWork);
    assert.equal(t1.day.kind, wageEngine.DayKind.makeupWorkday);
    assert.equal(t1.paidDaysInMonth, 16);
    assert.equal(t1.paidDayIndex, 11);
    assert.equal(t1.earnedToday, 0);
    assert.equal(t1.secondsToStart, 900);
    assert.equal(t1.secondsToEnd, 33300);
    assert.equal(money.string(t1.monthTotal), '¥15,000.00');
    assert.equal(display.StatusText.make(t1, s, false).plainText, '班 ¥0.00');
    const ms1 = display.Milestones.status(t1, s.milestones);
    assert.equal(ms1.reached, null);
    assert.equal(ms1.next.name, '一杯奶茶');
    assert.equal(display.Duration.words(ms1.eta), '5 分钟');

    // 2. 12:30 午休冻结
    const t2 = eng.snapshot(localDate(2026, 2, 14, 12, 30, 0));
    assert.equal(t2.phase, wageEngine.Phase.lunch);
    assertNear(t2.earnedToday, 600, 1e-6);
    assertNear(t2.progress, 0.4, 1e-9);
    assert.equal(display.StatusText.make(t2, s, false).plainText, '班 干饭中 ¥600.00 · 5:30:00');
    assert.equal(display.Quotes.forDate(localDate(2026, 2, 14, 12, 30, 0)), '再坚持一下，钱就到账了。');

    // 3. 14:30 达成 800 元「一顿日料」与老板模式遮罩
    const t3 = eng.snapshot(localDate(2026, 2, 14, 14, 30, 0));
    assert.equal(t3.phase, wageEngine.Phase.working);
    assertNear(t3.earnedToday, 800, 1e-6);
    assert.equal(money.string(t3.monthTotal), '¥15,800.00');
    assert.deepEqual(
      display.Milestones.crossed(t2.earnedToday, t3.earnedToday, s.milestones).map((m) => m.name),
      ['一顿日料']
    );
    const ms3 = display.Milestones.status(t3, s.milestones);
    assert.equal(ms3.reached.name, '一顿日料');
    assert.equal(ms3.next.name, '一双球鞋');
    assert.equal(display.Duration.words(ms3.eta), '2 小时');
    assert.equal(display.StatusText.make(t3, s, true).plainText, '班 ¥***.** · 3:30:00');

    // 4. 18:00 下班瞬间达成「一双球鞋」
    const t4 = eng.snapshot(localDate(2026, 2, 14, 18, 0, 0));
    assert.equal(t4.phase, wageEngine.Phase.afterWork);
    assertNear(t4.earnedToday, 1500, 1e-6);
    assertNear(t4.monthTotal, 16500, 1e-6);
    assert.deepEqual(
      display.Milestones.crossed(t3.earnedToday, t4.earnedToday, s.milestones).map((m) => m.name),
      ['一双球鞋']
    );
    assert.equal(display.StatusText.make(t4, s, false).plainText, '班 ¥1,500.00 ✓');
  });

  test('T4-02 场景2：真实打工人完整一天 Electron 端到端全链路 (含午休/里程碑/老板键/休眠唤醒 prime)', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 8, 30, 0).getTime(),
    });
    let panelView;
    try {
      await harness.bootMain();
      panelView = await mountRendererWindow(harness, 'panel');

      // 08:30 上班前：prime 静默无通知，主面板显示倒计时
      assert.equal(harness.notifications.length, 0);
      assert.ok(visibleText(panelView.document.body).includes('还没上班'));

      // 跳至 08:59:55 后推进 16 分钟跨过 15 元(一杯奶茶)、30 元(一份外卖)
      harness.clock.sleepTo(localDate(2026, 11, 17, 8, 59, 55).getTime());
      harness.emitPowerResume();
      harness.clock.advanceMinutes(16);
      await panelView.flush();
      assert.equal(harness.notifications.length, 2);
      assert.ok(harness.notifications[0].title.includes('一杯奶茶'));
      assert.ok(harness.notifications[1].title.includes('一份外卖'));

      // 12:00 午休冻结且干饭期间金额不变
      harness.clock.sleepTo(localDate(2026, 11, 17, 12, 0, 0).getTime());
      harness.emitPowerResume();
      await panelView.flush();
      const lunchSt1 = await harness.invokeIpc('state:get');
      assert.ok(visibleText(panelView.document.body).includes('干饭中'));
      assert.ok(harness.tray.toolTip.includes('干饭中'));
      harness.clock.advanceMinutes(1);
      const lunchSt2 = await harness.invokeIpc('state:get');
      assertNear(lunchSt1.snapshot.earnedToday, lunchSt2.snapshot.earnedToday, 1e-9);

      // 16:45 按老板键遮罩，跨过 800 元「一顿日料」不发通知，16:50 解除不补发
      harness.clock.sleepTo(localDate(2026, 11, 17, 16, 45, 0).getTime());
      harness.emitPowerResume();
      harness.triggerShortcut('CommandOrControl+Alt+B');
      await panelView.flush();
      assert.ok(visibleText(panelView.document.body).includes('¥***.**'));
      assert.ok(harness.tray.toolTip.includes('¥***.**'));

      const notifCountBeforeBoss = harness.notifications.length;
      harness.clock.advanceMinutes(5); // 跨过 16:48 的 800 元节点
      await harness.flushAsync();
      assert.equal(harness.notifications.length, notifCountBeforeBoss);

      harness.triggerShortcut('CommandOrControl+Alt+B');
      harness.clock.tick(3000);
      await panelView.flush();
      assert.equal(harness.notifications.length, notifCountBeforeBoss, '解除老板模式后不能补发里程碑');

      // 18:00 下班收到唯一 1 条下班通知
      harness.clock.sleepTo(localDate(2026, 11, 17, 17, 59, 55).getTime());
      harness.emitPowerResume();
      harness.clock.tick(10000);
      await panelView.flush();
      const offWorkNotifs = harness.notifications.filter((n) => n.title.includes('下班'));
      assert.equal(offWorkNotifs.length, 1);
      assert.ok(harness.tray.toolTip.includes('✓'));
      assert.ok(visibleText(panelView.document.body).includes('今天的钱已全部到账，下班快乐'));

      // 合盖休眠至次日 2026-11-18 10:00 后唤醒，prime 静默对齐不补发历史通知
      const countEndOfDay = harness.notifications.length;
      harness.clock.sleepTo(localDate(2026, 11, 18, 10, 0, 0).getTime());
      harness.emitPowerResume();
      harness.clock.tick(3000);
      await panelView.flush();
      assert.equal(harness.notifications.length, countEndOfDay, '次日唤醒 prime 绝不补发历史通知');
      const nextSt = await harness.invokeIpc('state:get');
      assert.equal(nextSt.snapshot.paidDayIndex, 13);
    } finally {
      if (panelView) panelView.dispose();
      harness.dispose();
    }
  });

  test('T4-03 场景3：老版本损坏配置迁移 + 导入 2028 年 JSON(含闰日/坏日期) + 大小周 + 手动婚假', () => {
    const { settings, wageEngine, display } = requireCore();
    const legacyRaw = JSON.stringify({
      incomeType: 'yearly',
      amount: 300000,
      basis: 'actualWorkdays',
      menuBarFormat: 'legacyInvalid',
      bossHotkey: 'ctrlOptCmdH',
      bigSmallWeek: false,
      importedHolidays: [{ date: '2028-01-01', type: 'holiday', name: '元旦' }],
    });

    let s = settings.parseSettingsJson(legacyRaw);
    assert.equal(s.incomeType, settings.IncomeType.yearly);
    assert.equal(s.amount, 300000);
    assert.equal(s.bossHotkey, settings.BossHotkey.ctrlOptCmdH);
    assert.equal(s.menuBarFormat, settings.MenuBarFormat.amountOnly);
    assert.deepEqual(s.workWeekdays, [2, 3, 4, 5, 6]);
    assert.equal(s.milestones.length, 6);

    // 2028-01-05(周三)开启大小周 -> 锚点 2028-01-03(周一)
    s = applyBigSmallWeek(settings, s, true, localDate(2028, 1, 5, 10, 0, 0));
    assert.equal(s.bigWeekAnchor, '2028-01-03');

    // 导入 2028 补班及闰日假、过滤坏日期 2028-02-30
    const parsedImport = settings.parseHolidayImport(
      JSON.stringify([
        { date: '2028-01-01', type: 'workday', name: '元旦加班' },
        { date: '2028-02-29', type: 'holiday', name: '闰日假' },
        { date: '2028-02-30', type: 'holiday', name: '错误日期' },
      ])
    );
    assert.equal(parsedImport.length, 2);
    s.importedHolidays = settings.mergeHolidayImport(s.importedHolidays, parsedImport);
    assert.deepEqual(
      s.importedHolidays.map((e) => e.date),
      ['2028-01-01', '2028-02-29']
    );
    assert.equal(s.importedHolidays[0].type, settings.HolidayEntryType.workday);

    // 2028-01-08(大周周六)加手动婚假
    s = settings.setMark(s, { kind: settings.ManualKind.paidLeave, note: '婚假' }, '2028-01-08');
    const eng = new wageEngine.WageEngine(s);
    const wc = eng.workCalendar;

    assert.equal(wc.info(localDate(2028, 1, 1)).kind, wageEngine.DayKind.makeupWorkday);
    const jan8 = eng.snapshot(localDate(2028, 1, 8, 12, 0, 0));
    assert.equal(jan8.day.kind, wageEngine.DayKind.paidLeave);
    assert.equal(display.formatDayLine(jan8), '1月8日 周六 · 带薪假（婚假）');
    assert.equal(wc.info(localDate(2028, 1, 15)).kind, wageEngine.DayKind.weekend);
    const jan22 = eng.snapshot(localDate(2028, 1, 22, 12, 0, 0));
    assert.equal(jan22.day.kind, wageEngine.DayKind.workday);
    assert.equal(display.formatDayLine(jan22), '1月22日 周六 · 大周周六');
    assert.equal(wc.info(localDate(2028, 2, 29)).kind, wageEngine.DayKind.holiday);
    assert.equal(wc.info(localDate(2028, 2, 29)).name, '闰日假');
  });

  test('T4-04 场景4：4页完整设置流 + 关闭设置窗常驻不退 + 退出重启持久化 + 二次启动唤醒', async () => {
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niuma-t4-s4-'));
    try {
      const h1 = createElectronHarness({
        userDataDir: sharedDir,
        initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      });
      let sView;
      try {
        await h1.bootMain();
        await h1.invokeIpc('window:openSettings', 'salary');
        sView = await mountRendererWindow(h1, 'settings');

        // 薪资页：年薪 360000 + 21.75 + 美元 $ + 4 位小数
        const yearlyChoice = findInteractiveChoice(sView.document, '年薪');
        if (yearlyChoice.localName === 'option') await sView.setValue(yearlyChoice.parentElement, yearlyChoice.value);
        else await sView.click(yearlyChoice);
        await sView.setValue(findControlByLabel(sView.document, '金额'), '360000');
        await sView.click(findInteractiveChoice(sView.document, '21.75'));
        await sView.setValue(findControlByLabel(sView.document, '货币'), '$');
        const decChoice = findInteractiveChoice(sView.document, '4 位');
        if (decChoice.localName === 'option') await sView.setValue(decChoice.parentElement, decChoice.value);
        else await sView.click(decChoice);

        // 作息页：开启大小周
        await sView.click(findButtonByText(sView.document, '作息'));
        await sView.click(findControlByLabel(sView.document, '大小周'));

        // 显示页：切换热键 ctrlOptCmdH 与开机自启
        await sView.click(findButtonByText(sView.document, '显示'));
        const hkChoice = findInteractiveChoice(sView.document, 'Ctrl+Alt+H');
        if (hkChoice.localName === 'option') await sView.setValue(hkChoice.parentElement, hkChoice.value);
        else await sView.click(hkChoice);
        await sView.click(findControlByLabel(sView.document, '开机自动启动'));

        // 关闭设置窗口后应用常驻不退出
        h1.getSettingsWindow().close();
        h1.emitWindowAllClosed();
        await h1.flushAsync();
        assert.equal(h1.state.quitCalled, false);

        // 通过退出 IPC 终止实例1
        await h1.invokeIpc('app:quit');
        assert.equal(h1.state.quitCalled, true);
      } finally {
        if (sView) sView.dispose();
        h1.dispose();
      }

      // 同一 userData 重启新实例并验证所有配置完整恢复，随后模拟 second-instance 唤醒主面板
      const h2 = createElectronHarness({
        userDataDir: sharedDir,
        initialNow: localDate(2026, 11, 17, 10, 5, 0).getTime(),
      });
      try {
        await h2.bootMain();
        const st2 = await h2.invokeIpc('state:get');
        assert.equal(st2.settings.incomeType, 'yearly');
        assert.equal(st2.settings.amount, 360000);
        assert.equal(st2.settings.basis, 'fixed2175');
        assert.equal(st2.settings.currency, '$');
        assert.equal(st2.settings.decimals, 4);
        assert.equal(st2.settings.bigSmallWeek, true);
        assert.equal(st2.settings.bossHotkey, 'ctrlOptCmdH');
        assert.equal(h2.registeredShortcuts.has('CommandOrControl+Alt+H'), true);

        const p = h2.getPanelWindow();
        if (p && p.isVisible()) p.hide();
        h2.emitSecondInstance([], '');
        await h2.flushAsync();
        assert.equal(h2.getPanelWindow().isVisible(), true);
      } finally {
        h2.dispose();
      }
    } finally {
      fs.rmSync(sharedDir, { recursive: true, force: true });
    }
  });

  test('T4-05 场景5：跨年跨月连续夜班班次周期 (2026-12-31 22:00 ~ 2027-01-01 06:00 及次晚元旦休假切换)', () => {
    const { settings, wageEngine, display } = requireCore();
    const s = settings.defaultSettings();
    s.workStart = 22 * 60;
    s.workEnd = 6 * 60;
    s.lunchEnabled = false;
    s.menuBarFormat = settings.MenuBarFormat.amountCountdown;
    const eng = new wageEngine.WageEngine(s);
    const money = new display.Money(s);

    // 2026-12-31 23:00：属于 2026-12-31 工作日夜班
    const dec31Night = eng.snapshot(localDate(2026, 12, 31, 23, 0, 0));
    assert.equal(toMs(dec31Night.shiftDay), localDate(2026, 12, 31).getTime());
    assert.equal(dec31Night.phase, wageEngine.Phase.working);
    assert.equal(dec31Night.paidDaysInMonth, 23);

    // 2027-01-01 05:59:59：仍属于 2026-12-31 班次
    const jan1Early = eng.snapshot(localDate(2027, 1, 1, 5, 59, 59));
    assert.equal(toMs(jan1Early.shiftDay), localDate(2026, 12, 31).getTime());
    assert.equal(jan1Early.phase, wageEngine.Phase.working);

    // 2027-01-01 06:00:00：切入 2027-01-01（元旦假期休息）
    const jan1End = eng.snapshot(localDate(2027, 1, 1, 6, 0, 0));
    assert.equal(toMs(jan1End.shiftDay), localDate(2027, 1, 1).getTime());
    assert.equal(jan1End.day.kind, wageEngine.DayKind.holiday);
    assert.equal(jan1End.day.name, '元旦');
    assert.equal(jan1End.phase, wageEngine.Phase.rest);
    assert.equal(jan1End.paidDaysInMonth, 21);
    assert.equal(display.StatusText.make(jan1End, s, false).main, '元旦休息');

    // 2027-01-02 02:00:00：处于 2027-01-01 跨夜区间，因开始日是元旦故仍为休息
    const jan2Early = eng.snapshot(localDate(2027, 1, 2, 2, 0, 0));
    assert.equal(toMs(jan2Early.shiftDay), localDate(2027, 1, 1).getTime());
    assert.equal(jan2Early.phase, wageEngine.Phase.rest);
    assert.equal(money.string(jan2Early.earnedToday), '¥0.00');
  });

  test('T4-06 场景6：节假日应急变更闭环 (工作日中途改带薪假 -> 抑制通知 -> 再改休息)', async () => {
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

      // 选中 17 号改为带薪假
      const btn17 = settingsView.document.querySelectorAll('button').find((b) => {
        if (!isVisible(b)) return false;
        const aria = b.getAttribute('aria-label') || '';
        return aria.includes('11月17日') || /^17(\D|$)/.test(b.textContent.trim());
      });
      assert.ok(btn17);
      await settingsView.click(btn17);
      await settingsView.click(findInteractiveChoice(settingsView.document, '带薪假'));
      await panelView.flush();

      assert.equal(visibleText(panelView.document.body).includes('有效工时'), false);
      assert.ok(harness.tray.toolTip.includes('带薪假'));

      // 推进至下班后，带薪假不触发下班弹窗
      harness.clock.sleepTo(localDate(2026, 11, 17, 17, 59, 55).getTime());
      harness.emitPowerResume();
      harness.clock.tick(10000);
      await panelView.flush();
      assert.equal(harness.notifications.length, 0);

      // 再次改为休息（不计薪）
      await settingsView.click(findInteractiveChoice(settingsView.document, '休息'));
      await panelView.flush();
      const pTxt = visibleText(panelView.document.body);
      assert.ok(pTxt.includes('不计薪，养精蓄锐'));
      assert.ok(harness.tray.toolTip.includes('休息'));
    } finally {
      if (panelView) panelView.dispose();
      if (settingsView) settingsView.dispose();
      harness.dispose();
    }
  });

  test('T4-07 场景7：多显示器移动办公 (负坐标副屏 + 顶部任务栏 + 动态增高 + 200ms 防重开 + Esc)', async () => {
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
          workArea: { x: -1920, y: 48, width: 1920, height: 1032 },
          scaleFactor: 1.25,
        },
      ],
      trayBounds: { x: -180, y: 8, width: 24, height: 40 },
    });
    let panelView;
    try {
      await harness.bootMain();
      const pWin = harness.getPanelWindow();
      if (pWin && pWin.isVisible()) pWin.hide();

      harness.clickTray();
      panelView = await mountRendererWindow(harness, 'panel');
      await panelView.triggerResize(330, 440);
      const b = harness.getPanelWindow().getBounds();
      assert.ok(b.x >= -1920 && b.x + b.width <= 0);
      assert.ok(b.y >= 48 && b.y + b.height <= 1080);

      // blur 后 199ms 点击托盘保持隐藏，201ms 重开，Esc 隐藏
      harness.getPanelWindow().emitBlur();
      assert.equal(harness.getPanelWindow().isVisible(), false);
      harness.clock.tick(199);
      harness.clickTray();
      assert.equal(harness.getPanelWindow().isVisible(), false);
      harness.clock.tick(2);
      harness.clickTray();
      assert.equal(harness.getPanelWindow().isVisible(), true);

      await panelView.dispatchKey({ key: 'Escape', code: 'Escape' });
      assert.equal(harness.getPanelWindow().isVisible(), false);
    } finally {
      if (panelView) panelView.dispose();
      harness.dispose();
    }
  });

  test('T4-08 场景8：安装前交付物终检流水线 (图标像素/package.json/.gitignore/README/16 Swift 文件)', () => {
    const paths = requireRepoPaths();

    // 1. 图标 7 尺寸与像素色域
    const ico = parseIco(fs.readFileSync(path.join(paths.assetsDir, 'icon.ico')));
    for (const sz of [16, 24, 32, 48, 64, 128, 256]) {
      assert.ok(ico.getFrame(sz, sz), `icon.ico 缺少 ${sz}x${sz}`);
    }
    const ico256 = decodePngRgba(ico.getFrame(256, 256).data);
    assert.equal(ico256.getPixel(0, 0)[3], 0);
    assert.equal(decodePngRgba(fs.readFileSync(path.join(paths.assetsDir, 'icon.png'))).width, 256);
    assert.equal(decodePngRgba(fs.readFileSync(path.join(paths.assetsDir, 'tray.png'))).width, 16);
    assert.equal(decodePngRgba(fs.readFileSync(path.join(paths.assetsDir, 'tray@2x.png'))).width, 32);

    // 2. package.json 与 .gitignore
    const pkg = JSON.parse(fs.readFileSync(paths.packageJson, 'utf8'));
    assert.equal(pkg.main, 'src/main/main.js');
    assert.equal(pkg.build.appId, 'local.niuma.booster');
    assert.ok(pkg.scripts.start && pkg.scripts.test && pkg.scripts.check && pkg.scripts.pack && pkg.scripts.dist);
    const gi = fs.readFileSync(paths.gitignore, 'utf8');
    assert.ok(gi.includes('.build/') && gi.includes('windows/dist/'));

    // 3. README.md 兼顾 macOS 原文与 Windows 中文指南
    const readme = fs.readFileSync(paths.readmeMd, 'utf8');
    for (const anchor of ['macOS 13+', './build.sh', 'swift test', 'Windows', 'Electron', 'npm install', 'npm start', 'npm test', 'npm run dist']) {
      assert.ok(readme.includes(anchor), `README.md 缺少关键章节锚点: ${anchor}`);
    }

    // 4. macOS 16 个基线文件完好性与 git status 干净
    const gitStatus = execFileSync(
      'git',
      ['-C', paths.repoRoot, 'status', '--porcelain', '--', 'Package.swift', 'Sources', 'Tests', 'build.sh', 'Scripts', 'Assets'],
      { encoding: 'utf8' }
    );
    assert.equal(gitStatus.trim(), '');
    const swiftSha = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(paths.repoRoot, 'Package.swift')))
      .digest('hex')
      .slice(0, 16)
      .toUpperCase();
    assert.equal(swiftSha, '5094FB2279BFFAF9');
  });
});
