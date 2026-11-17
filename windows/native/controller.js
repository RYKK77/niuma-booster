'use strict';

/**
 * 原生 WebView2 宿主主控状态机（运行于常驻 MiniBar WebView2 实例中）。
 * 直接调用 window.__NiumaCore 执行每秒计薪计算、里程碑与下班通知判定、托盘 Tooltip 生成及多窗口状态广播。
 */

(function initHostController() {
  if (!window.__NIUMA_IS_CONTROLLER__ || !window.__NiumaCore) {
    return;
  }

  const {
    BuiltinHolidays,
    BossHotkeyMeta,
    MenuBarFormat,
    DayKey,
    Phase,
    Money,
    WageEngine,
    serializeSnapshot,
    StatusText,
    Milestones,
    Quotes,
    Duration,
    formatDayLine,
    kindLabel,
    formatMinutes,
    formatAmount,
    panelSubline,
    milestoneSummary,
    decodeSettings,
    setBigSmallWeek,
    parseHolidayImport,
    mergeHolidayImport,
  } = window.__NiumaCore;

  const initCfg = window.__NIUMA_HOST_INIT__ || {};
  let settings = decodeSettings(initCfg.settings || {});
  let boss = false;
  let openAtLogin = Boolean(initCfg.openAtLogin);
  let loginError = null;
  let hotkeyRegistered = initCfg.hotkeyRegistered !== undefined ? Boolean(initCfg.hotkeyRegistered) : true;
  let hotkeyWarning = initCfg.hotkeyWarning || null;
  let settingsTab = 'salary';
  let settingsTabNonce = 0;

  let engine = new WageEngine(settings);
  let rawSnapshot = engine.snapshot(new Date());
  let prevTickMs = Date.now();
  let prevDayKey = DayKey.key(prevTickMs);

  // Cheerleader 状态机（里程碑与下班通知）
  let cheerDayKey = null;
  let cheerLastEarned = 0;
  let cheerOffWorkSent = false;

  function primeCheer(snap) {
    if (!snap) return;
    cheerDayKey = DayKey.key(snap.shiftDay);
    cheerLastEarned = snap.earnedToday;
    cheerOffWorkSent = snap.phase === Phase.afterWork;
  }

  function updateCheer(snap) {
    if (!snap) return [];
    const notifications = [];
    const key = DayKey.key(snap.shiftDay);
    if (key !== cheerDayKey) {
      cheerDayKey = key;
      cheerLastEarned = 0;
      cheerOffWorkSent = false;
    }
    const prevEarned = cheerLastEarned;
    cheerLastEarned = snap.earnedToday;

    if (!snap.day || !snap.day.accrues) {
      return notifications;
    }

    const money = new Money(settings);
    if (settings.milestonesEnabled && !boss) {
      const crossed = Milestones.crossed(prevEarned, snap.earnedToday, settings.milestones);
      for (const m of crossed) {
        notifications.push({
          title: `刚挣够${m.name}`,
          body: `今日已到账 ${money.string(m.amount, 0)}+，继续加油。`,
        });
      }
    }

    if (snap.phase === Phase.afterWork && !cheerOffWorkSent) {
      cheerOffWorkSent = true;
      if (settings.offWorkNotification) {
        notifications.push({
          title: '到点下班',
          body: boss ? '今天辛苦了。' : `今日到账 ${money.string(snap.earnedToday)}，收拾东西走人。`,
        });
      }
    }

    return notifications;
  }

  function buildStatusSamples(snap) {
    const sampleFor = (fmt) => {
      const line = StatusText.make(snap, { ...settings, menuBarFormat: fmt }, boss);
      return [line.prefix, line.main].filter(Boolean).join(' ') || line.plainText || '';
    };
    return {
      amountOnly: sampleFor(MenuBarFormat.amountOnly),
      amountProgress: sampleFor(MenuBarFormat.amountProgress),
      amountCountdown: sampleFor(MenuBarFormat.amountCountdown),
      iconOnly: '金额只在面板里看',
    };
  }

  function buildTrayTooltip(snap, line) {
    if (!snap || !settings || settings.menuBarFormat === MenuBarFormat.iconOnly) {
      return '牛马加油器（点击打开面板）';
    }
    const phase = snap.phase;
    const isOffHours = phase === 'rest' || phase === 'beforeWork' || phase === 'afterWork';
    if (isOffHours && settings.offHoursDisplay === 'iconOnly') {
      return '牛马加油器（点击打开面板）';
    }
    const plain = line && typeof line.plainText === 'string' ? line.plainText.trim() : '';
    if (!plain) return '牛马加油器（点击打开面板）';
    const full = `牛马加油器 · ${plain}`;
    return full.length <= 127 ? full : `${full.slice(0, 126)}…`;
  }

  function buildStatePayload() {
    const currentSnapshot = rawSnapshot || engine.snapshot(new Date());
    const serialized = serializeSnapshot(currentSnapshot);
    const statusLine = StatusText.make(currentSnapshot, settings, boss);
    const msBase = Milestones.status(currentSnapshot, settings.milestones);
    const msSummary = milestoneSummary(currentSnapshot, settings, boss);
    const milestoneStatus = {
      reached: msBase.reached,
      next: msBase.next,
      remaining: msBase.remaining,
      eta: msBase.eta,
      title: msSummary.title,
      detail: msSummary.detail,
    };

    const bossMeta = BossHotkeyMeta[settings.bossHotkey] || BossHotkeyMeta.off;
    const lunchRangeLabel =
      settings.lunchEnabled && currentSnapshot.shift.lunchStart && currentSnapshot.shift.lunchEnd
        ? `午休 ${formatMinutes(settings.lunchStart)}–${formatMinutes(settings.lunchEnd)}`
        : null;

    const panelText = {
      headerTitle: currentSnapshot.day.isPaid ? '今日已到账' : '今天休息',
      dayLine: formatDayLine(currentSnapshot),
      kindLabel: kindLabel(currentSnapshot.day),
      earned: formatAmount(currentSnapshot.earnedToday, settings, boss),
      subline: panelSubline(currentSnapshot, settings, boss),
      workStartLabel: formatMinutes(settings.workStart),
      workEndLabel: formatMinutes(settings.workEnd),
      lunchRangeLabel,
      progressPercent: Math.floor(currentSnapshot.progress * 100),
      countdownText:
        currentSnapshot.secondsToEnd != null ? Duration.clock(currentSnapshot.secondsToEnd) : '已下班',
      dailyWageLabel: currentSnapshot.day.isPaid ? '今日日薪' : '本月日薪',
      dailyWage: formatAmount(currentSnapshot.dailyWage, settings, boss),
      hourly: formatAmount(currentSnapshot.hourly, settings, boss),
      monthTotal: formatAmount(currentSnapshot.monthTotal, settings, boss),
      perSecond: formatAmount(currentSnapshot.perSecond, settings, boss, 4),
      paidDaysValue: currentSnapshot.day.isPaid
        ? `第 ${currentSnapshot.paidDayIndex} / ${currentSnapshot.paidDaysInMonth} 天`
        : `已过 ${currentSnapshot.paidDayIndex} / ${currentSnapshot.paidDaysInMonth} 天`,
      bossRowTitle: boss ? '老板模式：已开启' : '老板模式',
      bossShortcutHint: bossMeta.accelerator ? bossMeta.label : '',
      milestone: msSummary,
    };

    const runtime = {
      openAtLogin,
      loginItemEnabled: openAtLogin,
      loginItemSupported: true,
      isPackaged: true,
      loginHint: null,
      loginError,
      loginItemError: loginError,
      hotkeyRegistered,
      hotkeyWarning,
      hotkeyLabel: bossMeta.label,
      bossHotkeyLabel: bossMeta.label,
      isBigWeek: engine.workCalendar.isBigWeek(currentSnapshot.now),
      builtinYears: BuiltinHolidays.years,
      builtinHolidayYears: BuiltinHolidays.years,
      builtinHolidays: BuiltinHolidays.entries,
      statusSamples: buildStatusSamples(currentSnapshot),
      settingsTab,
      settingsTabNonce,
      appVersion: '1.0.0',
      platform: 'win32',
    };

    return {
      settings,
      boss,
      snapshot: serialized,
      statusLine,
      milestoneStatus,
      quote: Quotes.forDate(currentSnapshot.now),
      panelText,
      runtime,
    };
  }

  function postHostSync(payload, notifications = [], saveSettings = false) {
    const phase = payload.snapshot && payload.snapshot.phase ? payload.snapshot.phase : null;
    const isOffHours = phase === 'rest' || phase === 'beforeWork' || phase === 'afterWork';
    const shouldHideMiniBar =
      !settings ||
      settings.menuBarFormat === 'iconOnly' ||
      Boolean(payload.statusLine && payload.statusLine.forceIcon) ||
      (isOffHours && settings.offHoursDisplay === 'iconOnly');

    const tooltip = buildTrayTooltip(rawSnapshot, payload.statusLine);
    const bossMeta = BossHotkeyMeta[settings.bossHotkey] || BossHotkeyMeta.off;
    const bossMenuLabel = bossMeta.accelerator ? `老板模式（${bossMeta.label}）` : '老板模式';

    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage(
        JSON.stringify({
          type: 'controller:sync',
          state: payload,
          tooltip,
          boss,
          bossHotkey: settings.bossHotkey,
          bossMenuLabel,
          shouldShowMiniBar: !shouldHideMiniBar,
          saveSettings: saveSettings ? settings : null,
          notifications,
        })
      );
    }

    // 同步触发本窗口（MiniBar）的 onStateUpdate 监听器
    if (window.chrome && window.chrome.webview) {
      window.dispatchEvent(new CustomEvent('niuma:local-state', { detail: payload }));
    }
  }

  window.__getLocalControllerState = () => buildStatePayload();

  window.__handleControllerCommand = (cmd) => {
    const { action, arg, reqId } = cmd;
    let save = false;
    let reply = null;

    if (action === 'realign') {
      const nowMs = Date.now();
      prevTickMs = nowMs;
      prevDayKey = DayKey.key(nowMs);
      engine = new WageEngine(settings);
      rawSnapshot = engine.snapshot(new Date(nowMs));
      primeCheer(rawSnapshot);
      const state = buildStatePayload();
      postHostSync(state, [], false);
      return;
    }

    if (action === 'hotkeyStatus') {
      hotkeyRegistered = Boolean(arg && arg.registered);
      hotkeyWarning = (arg && arg.warning) || null;
      const state = buildStatePayload();
      postHostSync(state, [], false);
      return;
    }

    if (action === 'loginStatus') {
      openAtLogin = Boolean(arg && arg.openAtLogin);
      loginError = (arg && arg.error) || null;
      const state = buildStatePayload();
      postHostSync(state, [], false);
      if (reqId) {
        window.chrome.webview.postMessage(
          JSON.stringify({
            type: 'controller:reply',
            reqId,
            result: { ok: !loginError, enabled: openAtLogin, openAtLogin, error: loginError, state },
          })
        );
      }
      return;
    }

    if (action === 'selectTab') {
      settingsTab = String(arg || 'salary');
      settingsTabNonce += 1;
      const state = buildStatePayload();
      postHostSync(state, [], false);
      if (reqId) {
        window.chrome.webview.postMessage(
          JSON.stringify({ type: 'controller:reply', reqId, result: { ok: true, tab: settingsTab } })
        );
      }
      return;
    }

    if (action === 'state:get') {
      reply = buildStatePayload();
    } else if (action === 'boss:toggle') {
      boss = !boss;
      reply = buildStatePayload();
      postHostSync(reply, [], false);
    } else if (action === 'boss:set') {
      boss = Boolean(arg);
      reply = buildStatePayload();
      postHostSync(reply, [], false);
    } else if (action === 'settings:update') {
      if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
        const prevBigSmall = settings.bigSmallWeek;
        let merged = { ...settings, ...arg };
        if (!prevBigSmall && merged.bigSmallWeek === true && arg.bigWeekAnchor === undefined && !merged.bigWeekAnchor) {
          merged = setBigSmallWeek(merged, true, new Date());
        }
        settings = decodeSettings(merged);
        engine = new WageEngine(settings);
        rawSnapshot = engine.snapshot(new Date());
        primeCheer(rawSnapshot);
        save = true;
      }
      reply = buildStatePayload();
      postHostSync(reply, [], save);
    } else if (action === 'bigSmallWeek:toggle') {
      settings = decodeSettings(setBigSmallWeek(settings, Boolean(arg), new Date()));
      engine = new WageEngine(settings);
      rawSnapshot = engine.snapshot(new Date());
      primeCheer(rawSnapshot);
      reply = buildStatePayload();
      postHostSync(reply, [], true);
    } else if (action === 'holidays:clearImported') {
      settings = decodeSettings({ ...settings, importedHolidays: [] });
      engine = new WageEngine(settings);
      rawSnapshot = engine.snapshot(new Date());
      primeCheer(rawSnapshot);
      reply = buildStatePayload();
      postHostSync(reply, [], true);
    } else if (action === 'holidays:importRaw') {
      try {
        const rawText = String(arg || '').replace(/^\uFEFF/, '');
        const list = parseHolidayImport(rawText);
        const merged = mergeHolidayImport(settings.importedHolidays, list);
        settings = decodeSettings({ ...settings, importedHolidays: merged });
        engine = new WageEngine(settings);
        rawSnapshot = engine.snapshot(new Date());
        primeCheer(rawSnapshot);
        const state = buildStatePayload();
        postHostSync(state, [], true);
        reply = {
          ok: true,
          canceled: false,
          importedCount: list.length,
          totalCount: merged.length,
          message: `已导入 ${list.length} 天。`,
          error: null,
          state,
        };
      } catch (err) {
        reply = {
          ok: false,
          canceled: false,
          importedCount: 0,
          totalCount: settings.importedHolidays.length,
          message: '导入失败：文件不是正确的格式。',
          error: err && err.message ? err.message : String(err),
        };
      }
    }

    if (reqId && window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage(
        JSON.stringify({ type: 'controller:reply', reqId, result: reply })
      );
    }
  };

  // 启动首帧初始化与 1s 定时器
  primeCheer(rawSnapshot);
  const initialPayload = buildStatePayload();
  postHostSync(initialPayload, [], false);

  setInterval(() => {
    const nowMs = Date.now();
    const curDayKey = DayKey.key(nowMs);
    const jumped = Math.abs(nowMs - prevTickMs) > 5000 || curDayKey !== prevDayKey;
    prevTickMs = nowMs;
    prevDayKey = curDayKey;

    if (jumped) {
      engine = new WageEngine(settings);
      rawSnapshot = engine.snapshot(new Date(nowMs));
      primeCheer(rawSnapshot);
      postHostSync(buildStatePayload(), [], false);
    } else {
      rawSnapshot = engine.snapshot(new Date(nowMs));
      const notifs = updateCheer(rawSnapshot);
      postHostSync(buildStatePayload(), notifs, false);
    }
  }, 1000);
})();
