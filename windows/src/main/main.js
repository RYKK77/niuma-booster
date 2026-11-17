'use strict';

/**
 * 牛马加油器 Electron 主进程入口与生命周期编排模块。
 * 持有单一数据源（settings、boss、WageEngine、Cheerleader），协调单实例锁、1s 主循环、系统休眠/跳变对齐、托盘、全局老板键、开机自启与全部 12 个 IPC 通道。
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  BuiltinHolidays,
  BossHotkeyMeta,
  MenuBarFormat,
  DayKey,
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
} = require('../core');
const { createSettingsStore, stripUtf8Bom } = require('./settingsStore');
const { createCheerleader } = require('./cheerleader');
const { createHotkeyManager } = require('./hotkeyManager');
const { createTrayManager } = require('./trayManager');
const { createWindowManager, normalizeSettingsTab } = require('./windowManager');

const APP_USER_MODEL_ID = 'local.niuma.booster';
const TICK_INTERVAL_MS = 1000;
const TIME_JUMP_THRESHOLD_MS = 5000;

const IPC_CHANNELS = [
  'state:get',
  'settings:update',
  'boss:toggle',
  'boss:set',
  'bigSmallWeek:toggle',
  'holidays:importDialog',
  'holidays:clearImported',
  'loginItem:set',
  'panel:resize',
  'window:openSettings',
  'window:hidePanel',
  'app:quit',
];

/**
 * 构建设置页显示标签 4 种格式的实时预览示例。
 * @param {object} rawSnapshot - 原始快照对象
 * @param {object} settings - 当前设置
 * @param {boolean} boss - 是否处于老板模式
 * @returns {{ amountOnly: string, amountProgress: string, amountCountdown: string, iconOnly: string }} 示例对象
 */
function buildStatusSamples(rawSnapshot, settings, boss) {
  const sampleFor = (fmt) => {
    const line = StatusText.make(rawSnapshot, { ...settings, menuBarFormat: fmt }, boss);
    return [line.prefix, line.main].filter(Boolean).join(' ') || line.plainText || '';
  };

  return {
    amountOnly: sampleFor(MenuBarFormat.amountOnly),
    amountProgress: sampleFor(MenuBarFormat.amountProgress),
    amountCountdown: sampleFor(MenuBarFormat.amountCountdown),
    iconOnly: '金额只在面板里看',
  };
}

/**
 * 安全读取系统开机自启状态。
 * @param {object} app - Electron App 实例
 * @param {boolean} [fallback=false] - 回落值
 * @returns {boolean} 当前开机自启开关状态
 */
function readOpenAtLogin(app, fallback = false) {
  if (!app || typeof app.getLoginItemSettings !== 'function') {
    return fallback;
  }
  try {
    const info = app.getLoginItemSettings();
    return Boolean(info && info.openAtLogin);
  } catch {
    return fallback;
  }
}

/**
 * 创建主进程应用控制器（支持在单元测试中传入 Mock Electron 对象）。
 * @param {object} electronApi - Electron 模块接口集合
 * @param {object} [options={}] - 可选扩展参数
 * @returns {object} 主进程控制器实例
 */
function createMainApp(electronApi, options = {}) {
  const {
    app,
    Tray,
    BrowserWindow,
    Menu,
    globalShortcut,
    Notification,
    powerMonitor,
    screen,
    dialog,
    ipcMain,
    nativeImage,
  } = electronApi || {};

  const logger = options.logger || console;
  const preloadPath = options.preloadPath || path.join(__dirname, 'preload.js');
  const rendererDir = options.rendererDir || path.resolve(__dirname, '../renderer');
  const assetDir = options.assetDir || path.resolve(__dirname, '../../assets');

  let settingsStore = null;
  let settings = null;
  let boss = false;
  let engine = null;
  let rawSnapshot = null;

  let cheerleader = null;
  let hotkeyManager = null;
  let trayManager = null;
  let windowManager = null;

  let tickTimer = null;
  let prevTickMs = Date.now();
  let prevDayKey = DayKey.key(prevTickMs);

  let openAtLogin = false;
  let loginError = null;
  let settingsTab = 'salary';
  let settingsTabNonce = 0;

  let initialized = false;
  let cleanedUp = false;
  let ipcRegistered = false;
  let isQuitting = false;
  let lockAcquired = false;

  const powerHandlers = [];

  /**
   * 重建计薪引擎实例。
   */
  function rebuildEngine() {
    engine = new WageEngine(settings);
  }

  /**
   * 按当前时间重算快照。
   * @param {number} [nowMs=Date.now()] - 当前毫秒时间戳
   */
  function recomputeSnapshot(nowMs = Date.now()) {
    if (!engine) {
      rebuildEngine();
    }
    rawSnapshot = engine.snapshot(new Date(nowMs));
  }

  /**
   * 构建向渲染层暴露与广播的统一状态载荷（`StatePayload`）。
   * @returns {object} 完整状态载荷
   */
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

    const hotkeyStatus = hotkeyManager
      ? hotkeyManager.getStatus()
      : {
          hotkeyLabel: (BossHotkeyMeta[settings.bossHotkey] || BossHotkeyMeta.off).label,
          hotkeyRegistered: false,
          hotkeyWarning: null,
        };

    const isPackaged = Boolean(app && app.isPackaged);
    const loginHint = !isPackaged
      ? '开发模式下开机自启可能受限于未打包路径，打包安装后可稳定生效。'
      : null;

    const appVersion =
      app && typeof app.getVersion === 'function' ? String(app.getVersion()) : '1.0.0';

    const lunchRangeLabel =
      settings.lunchEnabled && currentSnapshot.shift.lunchStart && currentSnapshot.shift.lunchEnd
        ? `午休 ${formatMinutes(settings.lunchStart)}–${formatMinutes(settings.lunchEnd)}`
        : null;

    const bossMeta = BossHotkeyMeta[settings.bossHotkey] || BossHotkeyMeta.off;

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
      loginItemSupported: Boolean(app && typeof app.setLoginItemSettings === 'function'),
      isPackaged,
      loginHint,
      loginError,
      loginItemError: loginError,
      hotkeyRegistered: hotkeyStatus.hotkeyRegistered,
      hotkeyWarning: hotkeyStatus.hotkeyWarning,
      hotkeyLabel: hotkeyStatus.hotkeyLabel,
      bossHotkeyLabel: hotkeyStatus.hotkeyLabel,
      isBigWeek: engine.workCalendar.isBigWeek(currentSnapshot.now),
      builtinYears: BuiltinHolidays.years,
      builtinHolidayYears: BuiltinHolidays.years,
      builtinHolidays: BuiltinHolidays.entries,
      statusSamples: buildStatusSamples(currentSnapshot, settings, boss),
      settingsTab,
      settingsTabNonce,
      appVersion,
      platform: process.platform,
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

  /**
   * 向全部存活窗口广播最新 `state:update` 载荷。
   * @param {object} [payload] - 可选已构建好的状态载荷
   */
  function broadcastState(payload) {
    if (!windowManager) {
      return;
    }
    const state = payload || buildStatePayload();
    const windows = windowManager.getWindows();
    for (const win of windows) {
      if (
        win &&
        (typeof win.isDestroyed !== 'function' || !win.isDestroyed()) &&
        win.webContents &&
        (typeof win.webContents.isDestroyed !== 'function' || !win.webContents.isDestroyed())
      ) {
        try {
          win.webContents.send('state:update', state);
        } catch {
          // 忽略窗口关闭瞬间发送异常
        }
      }
    }
  }

  /**
   * 同步更新托盘 Tooltip/右键菜单并向所有窗口广播状态。
   */
  function syncTrayAndBroadcast() {
    if (trayManager && rawSnapshot) {
      trayManager.update(rawSnapshot, settings, boss);
    }
    const payload = buildStatePayload();
    if (windowManager && typeof windowManager.syncMiniBar === 'function') {
      windowManager.syncMiniBar(payload.statusLine, settings, rawSnapshot);
    }
    broadcastState(payload);
  }

  /**
   * 切换或设置老板模式（仅内存态，不落盘）。
   * @param {boolean} [nextValue] - 若传入则显式设置，否则取反
   * @returns {object} 最新状态载荷
   */
  function setBossState(nextValue) {
    const target = nextValue === undefined ? !boss : Boolean(nextValue);
    boss = target;
    syncTrayAndBroadcast();
    return buildStatePayload();
  }

  /**
   * 休眠唤醒、跨班次日或时间跳变（>5000ms）后的静默对齐与全量刷新。
   */
  function realignAll() {
    if (!initialized || cleanedUp) {
      return;
    }
    const nowMs = Date.now();
    prevTickMs = nowMs;
    prevDayKey = DayKey.key(nowMs);
    rebuildEngine();
    recomputeSnapshot(nowMs);
    if (cheerleader) {
      cheerleader.prime(rawSnapshot);
    }
    syncTrayAndBroadcast();
  }

  /**
   * 1s 主循环周期函数。
   */
  function onTick() {
    if (!initialized || cleanedUp) {
      return;
    }
    const nowMs = Date.now();
    const curDayKey = DayKey.key(nowMs);
    const jumped = Math.abs(nowMs - prevTickMs) > TIME_JUMP_THRESHOLD_MS || curDayKey !== prevDayKey;
    prevTickMs = nowMs;
    prevDayKey = curDayKey;

    if (jumped) {
      rebuildEngine();
      recomputeSnapshot(nowMs);
      if (cheerleader) {
        cheerleader.prime(rawSnapshot);
      }
    } else {
      recomputeSnapshot(nowMs);
      if (cheerleader) {
        cheerleader.update(rawSnapshot, settings, boss);
      }
    }

    syncTrayAndBroadcast();
  }

  /**
   * 打开设置窗口并同步页签状态。
   * @param {string | number} [tab='salary'] - 目标页签
   * @returns {{ ok: boolean, tab: string }} 打开结果
   */
  function openSettingsWindow(tab = 'salary') {
    const normalizedTab = normalizeSettingsTab(tab);
    settingsTab = normalizedTab;
    settingsTabNonce += 1;
    if (windowManager) {
      windowManager.openSettings(normalizedTab);
    }
    broadcastState();
    return { ok: true, tab: normalizedTab };
  }

  /**
   * 触发优雅退出应用。
   */
  function requestQuit() {
    isQuitting = true;
    if (app && typeof app.quit === 'function') {
      app.quit();
    }
  }

  /**
   * 注册全部 12 个 IPC 处理器。
   */
  function registerIpcHandlers() {
    if (!ipcMain || typeof ipcMain.handle !== 'function' || ipcRegistered) {
      return;
    }
    ipcRegistered = true;

    ipcMain.handle('state:get', () => buildStatePayload());

    ipcMain.handle('settings:update', (_event, patchOrSettings) => {
      if (
        !patchOrSettings ||
        typeof patchOrSettings !== 'object' ||
        Array.isArray(patchOrSettings)
      ) {
        return buildStatePayload();
      }

      const prevHotkey = settings.bossHotkey;
      const prevBigSmall = settings.bigSmallWeek;
      let merged = { ...settings, ...patchOrSettings };

      if (
        !prevBigSmall &&
        merged.bigSmallWeek === true &&
        patchOrSettings.bigWeekAnchor === undefined &&
        !merged.bigWeekAnchor
      ) {
        merged = setBigSmallWeek(merged, true, new Date());
      }

      settings = decodeSettings(merged);
      settingsStore.save(settings);
      rebuildEngine();

      if (
        hotkeyManager &&
        (settings.bossHotkey !== prevHotkey ||
          Object.prototype.hasOwnProperty.call(patchOrSettings, 'bossHotkey'))
      ) {
        hotkeyManager.apply(settings.bossHotkey);
      }

      recomputeSnapshot();
      if (cheerleader) {
        cheerleader.prime(rawSnapshot);
      }
      syncTrayAndBroadcast();
      return buildStatePayload();
    });

    ipcMain.handle('boss:toggle', () => setBossState());

    ipcMain.handle('boss:set', (_event, enabled) => setBossState(Boolean(enabled)));

    ipcMain.handle('bigSmallWeek:toggle', (_event, enabled) => {
      settings = decodeSettings(setBigSmallWeek(settings, Boolean(enabled), new Date()));
      settingsStore.save(settings);
      rebuildEngine();
      recomputeSnapshot();
      if (cheerleader) {
        cheerleader.prime(rawSnapshot);
      }
      syncTrayAndBroadcast();
      return buildStatePayload();
    });

    ipcMain.handle('holidays:importDialog', async () => {
      const dialogOpts = {
        title: '导入节假日 JSON',
        properties: ['openFile'],
        filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      };
      const parentWin =
        (windowManager && windowManager.getSettingsWindow()) ||
        (BrowserWindow && typeof BrowserWindow.getFocusedWindow === 'function'
          ? BrowserWindow.getFocusedWindow()
          : null);

      const res =
        parentWin && dialog
          ? await dialog.showOpenDialog(parentWin, dialogOpts)
          : dialog
            ? await dialog.showOpenDialog(dialogOpts)
            : { canceled: true, filePaths: [] };

      if (!res || res.canceled || !Array.isArray(res.filePaths) || res.filePaths.length === 0) {
        return {
          ok: true,
          canceled: true,
          importedCount: 0,
          totalCount: settings.importedHolidays.length,
          message: '',
          error: null,
        };
      }

      try {
        const rawText = stripUtf8Bom(fs.readFileSync(res.filePaths[0], 'utf8'));
        const list = parseHolidayImport(rawText);
        const merged = mergeHolidayImport(settings.importedHolidays, list);
        settings = decodeSettings({ ...settings, importedHolidays: merged });
        settingsStore.save(settings);
        rebuildEngine();
        recomputeSnapshot();
        if (cheerleader) {
          cheerleader.prime(rawSnapshot);
        }
        syncTrayAndBroadcast();

        return {
          ok: true,
          canceled: false,
          importedCount: list.length,
          totalCount: merged.length,
          message: `已导入 ${list.length} 天。`,
          error: null,
          state: buildStatePayload(),
        };
      } catch (err) {
        return {
          ok: false,
          canceled: false,
          importedCount: 0,
          totalCount: settings.importedHolidays.length,
          message: '导入失败：文件不是正确的格式。',
          error: err && err.message ? err.message : String(err),
        };
      }
    });

    ipcMain.handle('holidays:clearImported', () => {
      settings = decodeSettings({ ...settings, importedHolidays: [] });
      settingsStore.save(settings);
      rebuildEngine();
      recomputeSnapshot();
      if (cheerleader) {
        cheerleader.prime(rawSnapshot);
      }
      syncTrayAndBroadcast();
      return buildStatePayload();
    });

    ipcMain.handle('loginItem:set', (_event, enabled) => {
      const flag = Boolean(enabled);
      if (app && typeof app.setLoginItemSettings === 'function') {
        try {
          app.setLoginItemSettings({ openAtLogin: flag });
          loginError = null;
        } catch (err) {
          loginError = `设置失败：${err && err.message ? err.message : String(err)}`;
        }
      } else {
        loginError = '当前环境不支持开机自启设置';
      }

      openAtLogin = readOpenAtLogin(app, loginError ? openAtLogin : flag);
      const state = buildStatePayload();
      broadcastState(state);

      return {
        ok: !loginError,
        enabled: openAtLogin,
        openAtLogin,
        error: loginError,
        state,
      };
    });

    ipcMain.handle('panel:resize', (_event, width, height) => {
      const bounds = windowManager
        ? windowManager.resizePanel(width, height)
        : { x: 0, y: 0, width: 330, height: 460 };
      return {
        ok: true,
        bounds,
        width: bounds.width,
        height: bounds.height,
      };
    });

    ipcMain.handle('window:openSettings', (_event, tab) => openSettingsWindow(tab));

    ipcMain.handle('window:hidePanel', () => {
      if (windowManager) {
        windowManager.hidePanel({ recordDebounce: false });
      }
      return { ok: true };
    });

    ipcMain.handle('app:quit', () => {
      requestQuit();
      return { ok: true };
    });
  }

  /**
   * 在 `app.whenReady()` 后初始化所有子系统与定时器。
   */
  function initOnReady() {
    if (initialized || cleanedUp) {
      return;
    }
    initialized = true;

    settingsStore = createSettingsStore({
      userDataDir: options.userDataDir,
      filePath: options.settingsFilePath,
      app,
      logger,
    });
    settings = settingsStore.load();
    boss = false;

    rebuildEngine();
    prevTickMs = Date.now();
    prevDayKey = DayKey.key(prevTickMs);
    recomputeSnapshot(prevTickMs);

    openAtLogin = readOpenAtLogin(app, false);
    loginError = null;

    cheerleader = createCheerleader({
      Notification,
      nativeImage,
      assetDir,
      logger,
    });
    cheerleader.prime(rawSnapshot);

    hotkeyManager = createHotkeyManager({
      globalShortcut,
      onToggle: () => {
        setBossState();
      },
      logger,
    });
    hotkeyManager.apply(settings.bossHotkey);

    windowManager = createWindowManager({
      BrowserWindow,
      screen,
      nativeImage,
      preloadPath,
      rendererDir,
      assetDir,
      getTrayBounds: () => (trayManager ? trayManager.getBounds() : null),
      onWindowReady: (win) => {
        if (win && win.webContents && typeof win.webContents.send === 'function') {
          try {
            win.webContents.send('state:update', buildStatePayload());
          } catch {
            // 忽略窗口加载后已关闭异常
          }
        }
      },
      logger,
    });

    trayManager = createTrayManager({
      Tray,
      Menu,
      nativeImage,
      assetDir,
      onTogglePanel: (bounds) => {
        if (windowManager) {
          windowManager.togglePanel(bounds);
        }
      },
      onToggleBoss: () => {
        setBossState();
      },
      onOpenPanel: () => {
        if (windowManager) {
          windowManager.showPanel(trayManager ? trayManager.getBounds() : null);
        }
      },
      onOpenSettings: () => {
        openSettingsWindow('salary');
      },
      onQuit: () => {
        requestQuit();
      },
      logger,
    });

    registerIpcHandlers();

    // 预创建隐藏的主面板窗口，保证首帧广播、热键与 second-instance 唤醒即刻可用
    windowManager.ensurePanelWindow();
    syncTrayAndBroadcast();

    if (Array.isArray(process.argv) && process.argv.includes('--show')) {
      const tb = trayManager ? trayManager.getBounds() : null;
      const win = windowManager.showPanel(tb, { stickyUntilFocus: true });
      if (logger && typeof logger.log === 'function' && win && typeof win.getBounds === 'function') {
        logger.log('[Niuma] 已启动并展示主面板:', JSON.stringify({ panelBounds: win.getBounds(), trayBounds: tb }));
      }
    }

    if (powerMonitor && typeof powerMonitor.on === 'function') {
      const onResume = () => realignAll();
      const onUnlock = () => realignAll();
      powerMonitor.on('resume', onResume);
      powerMonitor.on('unlock-screen', onUnlock);
      powerHandlers.push(['resume', onResume], ['unlock-screen', onUnlock]);
    }

    tickTimer = setInterval(onTick, TICK_INTERVAL_MS);
  }

  /**
   * 幂等释放主进程所有定时器、热键、监听器、窗口与托盘资源。
   */
  function cleanup() {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }

    if (powerMonitor && powerHandlers.length > 0) {
      for (const [ev, handler] of powerHandlers) {
        if (typeof powerMonitor.off === 'function') {
          powerMonitor.off(ev, handler);
        } else if (typeof powerMonitor.removeListener === 'function') {
          powerMonitor.removeListener(ev, handler);
        }
      }
      powerHandlers.length = 0;
    }

    if (hotkeyManager) {
      hotkeyManager.dispose();
    }

    if (windowManager) {
      windowManager.destroyAll();
    }

    if (trayManager) {
      trayManager.destroy();
    }

    if (ipcRegistered && ipcMain && typeof ipcMain.removeHandler === 'function') {
      for (const channel of IPC_CHANNELS) {
        try {
          ipcMain.removeHandler(channel);
        } catch {
          // 忽略卸载异常
        }
      }
      ipcRegistered = false;
    }
  }

  /**
   * 启动主进程应用（检查单实例锁并挂载应用生命周期）。
   * @returns {Promise<boolean>} 是否作为主实例启动成功
   */
  function start() {
    if (!app) {
      throw new Error('缺少 Electron app 实例，无法启动牛马加油器主进程');
    }

    if (typeof app.requestSingleInstanceLock === 'function') {
      lockAcquired = Boolean(app.requestSingleInstanceLock());
    } else {
      lockAcquired = true;
    }

    if (!lockAcquired) {
      // 获取单实例锁失败：严禁调用 process.exit()，仅调用 app.quit() 安全退出
      if (typeof app.quit === 'function') {
        app.quit();
      }
      return Promise.resolve(false);
    }

    if (typeof app.disableHardwareAcceleration === 'function') {
      app.disableHardwareAcceleration();
    }
    if (app.commandLine && typeof app.commandLine.appendSwitch === 'function') {
      app.commandLine.appendSwitch('disable-gpu');
    }

    if (typeof app.setAppUserModelId === 'function') {
      app.setAppUserModelId(APP_USER_MODEL_ID);
    }

    if (typeof app.on === 'function') {
      app.on('second-instance', () => {
        if (initialized && !cleanedUp && windowManager) {
          windowManager.showPanel(trayManager ? trayManager.getBounds() : null);
        }
      });

      // 所有窗口关闭时保持托盘常驻后台运行，不调用 app.quit()
      app.on('window-all-closed', () => {});

      app.on('before-quit', () => {
        isQuitting = true;
        cleanup();
      });

      app.on('will-quit', () => {
        cleanup();
      });
    }

    if (typeof app.isReady === 'function' && app.isReady()) {
      initOnReady();
      return Promise.resolve(true);
    }

    if (typeof app.whenReady === 'function') {
      return Promise.resolve(app.whenReady()).then(() => {
        initOnReady();
        return true;
      });
    }

    initOnReady();
    return Promise.resolve(true);
  }

  return {
    start,
    cleanup,
    realignAll,
    buildStatePayload,
    isQuitting: () => isQuitting,
    getState: () => ({ settings, boss, rawSnapshot }),
  };
}

/**
 * 使用指定 Electron API 启动主进程应用。
 * @param {object} electronApi - Electron 模块对象
 * @param {object} [options={}] - 可选配置
 * @returns {object} 主进程控制器实例
 */
function start(electronApi, options = {}) {
  const mainApp = createMainApp(electronApi, options);
  mainApp.start();
  return mainApp;
}

// 双模式自动启动：兼容真实 `electron .` 与测试环境通过 `Module._load` 注入后直接 `require('src/main/main.js')`
if (!process.env.NIUMA_NO_AUTO_START && !globalThis.__NIUMA_NO_AUTO_START__) {
  let resolvedElectron = null;
  try {
    resolvedElectron = require('electron');
  } catch {
    resolvedElectron = null;
  }
  if (resolvedElectron && typeof resolvedElectron === 'object' && resolvedElectron.app) {
    start(resolvedElectron);
  }
}

module.exports = {
  createMainApp,
  start,
  buildStatusSamples,
  APP_USER_MODEL_ID,
  IPC_CHANNELS,
};
