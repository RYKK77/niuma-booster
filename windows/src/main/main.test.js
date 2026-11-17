'use strict';

/**
 * Windows Electron 主进程与 Preload 零外部依赖集成测试套件。
 * 使用内置 VirtualClock 与 `Module._load` Mock `electron`，完整覆盖单实例锁、200ms blur 去抖、
 * 多屏 workArea 四方位定位、Tooltip 4 模式与 127 字符截断、老板键、Cheerleader、开机自启、
 * settings.json 损坏恢复以及全部 12 个 IPC 通道与 preload 契约。
 */

process.env.TZ = 'Asia/Shanghai';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createSettingsStore,
  stripUtf8Bom,
} = require('./settingsStore');
const { Cheerleader } = require('./cheerleader');
const { createHotkeyManager } = require('./hotkeyManager');
const {
  IDLE_TOOLTIP,
  truncateTooltip,
  buildTrayTooltip,
  buildTrayMenuTemplate,
} = require('./trayManager');
const { computePopoverPosition } = require('./windowManager');
const { DayKey, Phase, MenuBarFormat, OffHoursDisplay, BossHotkey, WageEngine, defaultSettings } = require('../core');

const MAIN_ENTRY_PATH = path.resolve(__dirname, 'main.js');
const PRELOAD_PATH = path.resolve(__dirname, 'preload.js');
const SRC_MAIN_DIR = __dirname;

/**
 * 构造本地时区指定年月日的 Date 对象。
 * @param {number} y - 年
 * @param {number} m - 月（1..12）
 * @param {number} d - 日
 * @param {number} [hh=0] - 时
 * @param {number} [mm=0] - 分
 * @param {number} [ss=0] - 秒
 * @returns {Date} 本地时间 Date 实例
 */
function localDate(y, m, d, hh = 0, mm = 0, ss = 0) {
  return new Date(y, m - 1, d, hh, mm, ss, 0);
}

/**
 * 创建确定性虚拟时钟，接管全局 `Date`、`setTimeout`、`clearTimeout`、`setInterval` 与 `clearInterval`。
 * @param {number} initialMs - 初始 epoch 毫秒时间戳
 * @returns {object} 虚拟时钟控制器
 */
function createVirtualClock(initialMs) {
  const OrigDate = globalThis.Date;
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;

  let currentMs = initialMs;
  let nextTimerId = 1;
  let installed = false;
  /** @type {Map<number, { id: number, fn: Function, args: any[], interval: number | null, nextRun: number }>} */
  const timers = new Map();

  class FakeDate extends OrigDate {
    constructor(...args) {
      if (args.length === 0) {
        super(currentMs);
      } else {
        super(...args);
      }
    }
    static now() {
      return currentMs;
    }
  }
  FakeDate.UTC = OrigDate.UTC;
  FakeDate.parse = OrigDate.parse;

  function scheduleTimeout(fn, delay = 0, ...args) {
    const id = nextTimerId++;
    const ms = Math.max(0, Number(delay) || 0);
    timers.set(id, { id, fn, args, interval: null, nextRun: currentMs + ms });
    return id;
  }

  function scheduleInterval(fn, delay = 0, ...args) {
    const id = nextTimerId++;
    const ms = Math.max(1, Number(delay) || 1);
    timers.set(id, { id, fn, args, interval: ms, nextRun: currentMs + ms });
    return id;
  }

  function cancelTimer(id) {
    timers.delete(id);
  }

  function install() {
    if (installed) return;
    installed = true;
    globalThis.Date = FakeDate;
    globalThis.setTimeout = scheduleTimeout;
    globalThis.clearTimeout = cancelTimer;
    globalThis.setInterval = scheduleInterval;
    globalThis.clearInterval = cancelTimer;
  }

  function uninstall() {
    if (!installed) return;
    installed = false;
    timers.clear();
    globalThis.Date = OrigDate;
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }

  /**
   * 推进指定毫秒数并按时间顺序触发到期定时器。
   * @param {number} ms - 推进毫秒数
   */
  function tick(ms) {
    const targetMs = currentMs + Math.max(0, ms);
    while (true) {
      let earliest = null;
      for (const entry of timers.values()) {
        if (entry.nextRun <= targetMs) {
          if (!earliest || entry.nextRun < earliest.nextRun || (entry.nextRun === earliest.nextRun && entry.id < earliest.id)) {
            earliest = entry;
          }
        }
      }
      if (!earliest) {
        break;
      }
      currentMs = earliest.nextRun;
      if (earliest.interval !== null) {
        earliest.nextRun = currentMs + earliest.interval;
      } else {
        timers.delete(earliest.id);
      }
      if (typeof earliest.fn === 'function') {
        earliest.fn(...earliest.args);
      }
    }
    currentMs = targetMs;
  }

  /**
   * 模拟系统休眠或修改系统时间（直接跳变时钟且不补发中途错过的周期 tick）。
   * @param {number} targetMs - 目标 epoch 毫秒时间戳
   */
  function jumpTo(targetMs) {
    currentMs = targetMs;
    for (const entry of timers.values()) {
      if (entry.interval !== null) {
        entry.nextRun = currentMs + entry.interval;
      }
    }
  }

  return {
    install,
    uninstall,
    tick,
    jumpTo,
    now: () => currentMs,
    pendingTimers: () => timers.size,
  };
}

/**
 * 创建极简同步事件发射器。
 * @returns {object} EventEmitter 接口对象
 */
function createEmitter() {
  const map = new Map();
  return {
    on(ev, fn) {
      if (typeof fn !== 'function') return this;
      if (!map.has(ev)) map.set(ev, []);
      map.get(ev).push({ fn, once: false });
      return this;
    },
    once(ev, fn) {
      if (typeof fn !== 'function') return this;
      if (!map.has(ev)) map.set(ev, []);
      map.get(ev).push({ fn, once: true });
      return this;
    },
    off(ev, fn) {
      const list = map.get(ev);
      if (!list) return this;
      const next = list.filter((item) => item.fn !== fn);
      if (next.length > 0) map.set(ev, next);
      else map.delete(ev);
      return this;
    },
    removeListener(ev, fn) {
      return this.off(ev, fn);
    },
    emit(ev, ...args) {
      const list = map.get(ev);
      if (!list || list.length === 0) return false;
      const snapshot = list.slice();
      const rest = list.filter((item) => !item.once);
      if (rest.length > 0) map.set(ev, rest);
      else map.delete(ev);
      for (const item of snapshot) {
        item.fn(...args);
      }
      return true;
    },
    listenerCount(ev) {
      return (map.get(ev) || []).length;
    },
  };
}

/**
 * 创建零外部依赖的 Mock Electron 测试环境并拦截 `require('electron')`。
 * @param {object} [options={}] - 环境初始配置
 * @returns {object} 测试驱动夹具
 */
function createMockElectronHarness(options = {}) {
  const initialNow =
    options.initialNow !== undefined
      ? options.initialNow
      : localDate(2026, 11, 17, 10, 0, 0).getTime();

  const singleInstanceLock =
    options.singleInstanceLock !== undefined ? Boolean(options.singleInstanceLock) : true;
  const notificationSupported =
    options.notificationSupported !== undefined ? Boolean(options.notificationSupported) : true;
  const failingShortcuts = new Set(options.failingShortcuts || []);
  const loginItemThrows = options.loginItemThrows || null;
  const isPackaged = Boolean(options.isPackaged);
  const simulateMissingHtml = Boolean(options.simulateMissingHtml);

  let currentTrayBounds =
    options.trayBounds !== undefined
      ? options.trayBounds
        ? { ...options.trayBounds }
        : null
      : { x: 1700, y: 1040, width: 24, height: 40 };

  const currentDisplays = options.displays
    ? structuredClone(options.displays)
    : [
        {
          id: 1,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1032 },
          scaleFactor: 1,
        },
      ];

  let openDialogResult = options.openDialogResult
    ? structuredClone(options.openDialogResult)
    : { canceled: true, filePaths: [] };

  const userDataDir =
    options.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'niuma-main-test-'));
  const ownsUserDataDir = !options.userDataDir;

  const settingsPath = path.join(userDataDir, 'settings.json');
  if (options.rawSettingsText !== undefined && options.rawSettingsText !== null) {
    fs.writeFileSync(settingsPath, options.rawSettingsText, 'utf8');
  } else if (options.initialSettings !== undefined && options.initialSettings !== null) {
    fs.writeFileSync(settingsPath, JSON.stringify(options.initialSettings, null, 2), 'utf8');
  }

  const clock = createVirtualClock(initialNow);
  const appEmitter = createEmitter();
  const powerMonitorEmitter = createEmitter();
  const ipcHandlers = new Map();

  const state = {
    quitCalled: false,
    appUserModelId: null,
    loginItem: { openAtLogin: false },
    tray: null,
    windows: [],
    notifications: [],
    registeredShortcuts: new Map(),
    dialogCalls: [],
  };

  let origModuleLoad = null;
  let preloadOverride = null;
  let nextWinId = 1;

  const app = {
    ...appEmitter,
    requestSingleInstanceLock: () => singleInstanceLock,
    quit: () => {
      state.quitCalled = true;
      appEmitter.emit('before-quit', { preventDefault() {} });
      appEmitter.emit('will-quit', { preventDefault() {} });
    },
    getPath: (name) => (name === 'userData' ? userDataDir : path.join(userDataDir, name)),
    setAppUserModelId: (id) => {
      state.appUserModelId = id;
    },
    setLoginItemSettings: (opts = {}) => {
      if (loginItemThrows) {
        throw loginItemThrows instanceof Error
          ? loginItemThrows
          : new Error(String(loginItemThrows));
      }
      state.loginItem = { ...state.loginItem, ...opts };
    },
    getLoginItemSettings: () => ({ ...state.loginItem }),
    whenReady: () => Promise.resolve(),
    isReady: () => true,
    isPackaged,
    getVersion: () => '1.0.0',
  };

  class MockTray {
    constructor(image) {
      this._emitter = createEmitter();
      this.image = image;
      this.toolTip = '';
      this.contextMenu = null;
      this.destroyed = false;
      state.tray = this;
    }
    on(ev, fn) { this._emitter.on(ev, fn); return this; }
    emit(ev, ...args) { return this._emitter.emit(ev, ...args); }
    setToolTip(str) { this.toolTip = String(str); }
    setContextMenu(menu) { this.contextMenu = menu; }
    getBounds() { return currentTrayBounds ? { ...currentTrayBounds } : { x: 0, y: 0, width: 0, height: 0 }; }
    destroy() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
  }

  const Menu = {
    buildFromTemplate: (template) => {
      const items = template.map((it) => ({ ...it }));
      return {
        items,
        findItem: (substr) => items.find((it) => typeof it.label === 'string' && it.label.includes(substr)) || null,
        clickItem: (substr) => {
          const item = items.find((it) => typeof it.label === 'string' && it.label.includes(substr));
          if (!item) throw new Error(`未找到菜单项: ${substr}`);
          if (item.type === 'checkbox') item.checked = !item.checked;
          if (typeof item.click === 'function') item.click(item);
          return item;
        },
      };
    },
  };

  class MockBrowserWindow {
    constructor(opts = {}) {
      this._emitter = createEmitter();
      this._wcEmitter = createEmitter();
      this.id = nextWinId++;
      this.options = { ...opts };
      this._visible = Boolean(opts.show);
      this._focused = false;
      this._destroyed = false;
      this._minimized = false;
      this._bounds = {
        x: opts.x || 0,
        y: opts.y || 0,
        width: opts.width || 800,
        height: opts.height || 600,
      };
      this.loadedFile = null;
      this.loadOptions = null;
      this.loadedURL = null;

      const self = this;
      this.webContents = {
        id: this.id,
        sentMessages: [],
        on: (ev, fn) => { self._wcEmitter.on(ev, fn); return self.webContents; },
        once: (ev, fn) => { self._wcEmitter.once(ev, fn); return self.webContents; },
        isDestroyed: () => self._destroyed,
        send: (channel, ...args) => {
          if (self._destroyed) return;
          self.webContents.sentMessages.push({
            channel,
            args: args.map((v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))),
          });
        },
      };

      state.windows.push(this);
    }

    static getAllWindows() {
      return state.windows.filter((w) => !w.isDestroyed());
    }
    static getFocusedWindow() {
      return state.windows.find((w) => !w.isDestroyed() && w._focused) || null;
    }

    on(ev, fn) { this._emitter.on(ev, fn); return this; }
    once(ev, fn) { this._emitter.once(ev, fn); return this; }

    loadFile(filePath, loadOpts = {}) {
      this.loadedFile = filePath;
      this.loadOptions = loadOpts;
      if (simulateMissingHtml) {
        this._wcEmitter.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', `file://${filePath}`, true);
        return Promise.reject(new Error(`ERR_FILE_NOT_FOUND: ${filePath}`));
      }
      this._wcEmitter.emit('did-finish-load');
      return Promise.resolve();
    }

    loadURL(url) {
      this.loadedURL = url;
      return Promise.resolve();
    }

    show() {
      if (this._destroyed) return;
      this._visible = true;
      this._focused = true;
      this._emitter.emit('show');
    }

    hide() {
      if (this._destroyed) return;
      this._visible = false;
      this._focused = false;
      this._emitter.emit('hide');
    }

    focus() {
      if (this._destroyed) return;
      this._focused = true;
      this._emitter.emit('focus');
    }

    blur() {
      if (this._destroyed) return;
      this._focused = false;
      this._emitter.emit('blur');
    }

    restore() {
      this._minimized = false;
    }

    close() {
      if (this._destroyed) return;
      this.destroy();
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this._visible = false;
      this._focused = false;
      this._emitter.emit('closed');
      if (MockBrowserWindow.getAllWindows().length === 0) {
        appEmitter.emit('window-all-closed');
      }
    }

    isVisible() { return !this._destroyed && this._visible; }
    isFocused() { return !this._destroyed && this._focused; }
    isDestroyed() { return this._destroyed; }
    isMinimized() { return this._minimized; }
    setAlwaysOnTop() {}
    setMenuBarVisibility() {}
    setBounds(rect) {
      if (!rect) return;
      this._bounds = {
        x: rect.x !== undefined ? Math.round(rect.x) : this._bounds.x,
        y: rect.y !== undefined ? Math.round(rect.y) : this._bounds.y,
        width: rect.width !== undefined ? Math.round(rect.width) : this._bounds.width,
        height: rect.height !== undefined ? Math.round(rect.height) : this._bounds.height,
      };
    }
    getBounds() { return { ...this._bounds }; }
    emitKeyDown(key) {
      let prevented = false;
      this._wcEmitter.emit(
        'before-input-event',
        { preventDefault: () => { prevented = true; } },
        { type: 'keyDown', key }
      );
      return prevented;
    }
  }

  const globalShortcut = {
    register: (accel, cb) => {
      if (failingShortcuts.has(accel)) return false;
      state.registeredShortcuts.set(accel, cb);
      return true;
    },
    unregister: (accel) => {
      state.registeredShortcuts.delete(accel);
    },
    isRegistered: (accel) => state.registeredShortcuts.has(accel),
  };

  class MockNotification {
    static isSupported() {
      return notificationSupported;
    }
    constructor(opts = {}) {
      this.opts = { ...opts };
    }
    show() {
      state.notifications.push({ ...this.opts, at: clock.now() });
    }
  }

  const screen = {
    getPrimaryDisplay: () => structuredClone(currentDisplays[0]),
    getAllDisplays: () => structuredClone(currentDisplays),
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: ({ x, y }) => {
      for (const d of currentDisplays) {
        const b = d.bounds;
        if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) {
          return structuredClone(d);
        }
      }
      return structuredClone(currentDisplays[0]);
    },
  };

  const dialog = {
    showOpenDialog: async (winOrOpts, maybeOpts) => {
      const hasWin = maybeOpts !== undefined;
      state.dialogCalls.push({
        win: hasWin ? winOrOpts : null,
        opts: hasWin ? maybeOpts : winOrOpts,
      });
      return structuredClone(openDialogResult);
    },
  };

  const ipcMain = {
    handle: (channel, fn) => {
      ipcHandlers.set(channel, fn);
    },
    removeHandler: (channel) => {
      ipcHandlers.delete(channel);
    },
  };

  const nativeImage = {
    createFromPath: (p) => {
      const exists = Boolean(p) && fs.existsSync(p);
      return {
        _path: p,
        isEmpty: () => !exists,
      };
    },
  };

  const mockElectron = {
    app,
    Tray: MockTray,
    BrowserWindow: MockBrowserWindow,
    Menu,
    globalShortcut,
    Notification: MockNotification,
    powerMonitor: powerMonitorEmitter,
    screen,
    dialog,
    ipcMain,
    nativeImage,
  };

  function clearMainRequireCache() {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(SRC_MAIN_DIR + path.sep) && key !== __filename) {
        delete require.cache[key];
      }
    }
  }

  function installHook() {
    if (origModuleLoad) return;
    origModuleLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') {
        return preloadOverride || mockElectron;
      }
      return origModuleLoad.call(this, request, parent, isMain);
    };
  }

  function restoreHook() {
    if (!origModuleLoad) return;
    Module._load = origModuleLoad;
    origModuleLoad = null;
  }

  async function boot() {
    clock.install();
    installHook();
    clearMainRequireCache();
    require(MAIN_ENTRY_PATH);
    await Promise.resolve();
  }

  async function invokeIpc(channel, ...args) {
    const handler = ipcHandlers.get(channel);
    if (!handler) {
      throw new Error(`未注册 IPC 通道: ${channel}`);
    }
    const result = await handler({ sender: { id: 1 } }, ...args);
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  }

  function loadPreload() {
    installHook();
    const exposed = {};
    const rendererBus = createEmitter();
    const ipcRenderer = {
      invoke: (channel, ...args) => invokeIpc(channel, ...args),
      on: (channel, fn) => {
        rendererBus.on(channel, fn);
        return ipcRenderer;
      },
      removeListener: (channel, fn) => {
        rendererBus.off(channel, fn);
        return ipcRenderer;
      },
      off: (channel, fn) => {
        rendererBus.off(channel, fn);
        return ipcRenderer;
      },
      _emit: (channel, ...args) => rendererBus.emit(channel, { sender: 'mock-event' }, ...args),
      _listenerCount: (channel) => rendererBus.listenerCount(channel),
    };

    delete require.cache[require.resolve(PRELOAD_PATH)];
    preloadOverride = {
      contextBridge: {
        exposeInMainWorld: (key, api) => {
          exposed[key] = api;
        },
      },
      ipcRenderer,
    };
    try {
      require(PRELOAD_PATH);
    } finally {
      preloadOverride = null;
    }

    return { exposed, api: exposed.niumaAPI, ipcRenderer };
  }

  function getPanelWindow() {
    return (
      state.windows.find(
        (w) => !w.isDestroyed() && w.loadedFile && path.basename(w.loadedFile) === 'panel.html'
      ) || null
    );
  }

  function getSettingsWindow() {
    return (
      state.windows.find(
        (w) => !w.isDestroyed() && w.loadedFile && path.basename(w.loadedFile) === 'settings.html'
      ) || null
    );
  }

  function clickTray() {
    if (!state.tray) throw new Error('托盘尚未创建');
    state.tray.emit('click', {}, state.tray.getBounds());
  }

  function dispose() {
    try {
      if (state.tray && !state.tray.isDestroyed()) {
        appEmitter.emit('before-quit', { preventDefault() {} });
        appEmitter.emit('will-quit', { preventDefault() {} });
      }
    } finally {
      restoreHook();
      clearMainRequireCache();
      clock.uninstall();
      if (ownsUserDataDir) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
    }
  }

  return {
    state,
    clock,
    ipcHandlers,
    appEmitter,
    powerMonitorEmitter,
    settingsPath,
    userDataDir,
    boot,
    invokeIpc,
    loadPreload,
    getPanelWindow,
    getSettingsWindow,
    clickTray,
    setOpenDialogResult: (res) => {
      openDialogResult = structuredClone(res);
    },
    setTrayBounds: (bounds) => {
      currentTrayBounds = bounds ? { ...bounds } : null;
    },
    dispose,
  };
}

describe('1. 单实例锁、应用生命周期与资源清理', () => {
  test('首实例获锁成功并初始化托盘、AppUserModelID、热键与 1s 主循环', async () => {
    const h = createMockElectronHarness();
    try {
      await h.boot();
      assert.equal(h.state.quitCalled, false);
      assert.equal(h.state.appUserModelId, 'local.niuma.booster');
      assert.ok(h.state.tray, '应创建托盘实例');
      assert.ok(h.getPanelWindow(), '应预创建隐藏的主面板窗口');
      assert.equal(h.getPanelWindow().isVisible(), false);
      assert.equal(h.ipcHandlers.size, 12);
      assert.equal(h.clock.pendingTimers(), 1);
    } finally {
      h.dispose();
    }
  });

  test('获取单实例锁失败时仅调用 app.quit() 且不创建托盘/窗口/磁盘文件', async () => {
    const h = createMockElectronHarness({ singleInstanceLock: false });
    try {
      await h.boot();
      assert.equal(h.state.quitCalled, true);
      assert.equal(h.state.tray, null);
      assert.equal(h.state.windows.length, 0);
      assert.equal(h.state.registeredShortcuts.size, 0);
      assert.equal(fs.existsSync(h.settingsPath), false);
    } finally {
      h.dispose();
    }
  });

  test('second-instance 唤醒隐藏面板、window-all-closed 后台常驻与退出清理', async () => {
    const h = createMockElectronHarness();
    try {
      await h.boot();
      assert.equal(h.getPanelWindow().isVisible(), false);

      h.appEmitter.emit('second-instance', {}, ['--relaunch'], 'd:\\project');
      assert.equal(h.getPanelWindow().isVisible(), true);

      await h.invokeIpc('window:openSettings', 'salary');
      const sWin = h.getSettingsWindow();
      assert.ok(sWin);
      sWin.close();
      h.getPanelWindow().close();
      assert.equal(h.state.quitCalled, false, '关闭全部窗口后托盘后台应继续运行');
      assert.equal(h.state.tray.isDestroyed(), false);

      await h.invokeIpc('app:quit');
      assert.equal(h.state.quitCalled, true);
      assert.equal(h.clock.pendingTimers(), 0, '退出时应清理 1s 定时器');
      assert.equal(h.state.registeredShortcuts.size, 0, '退出时应注销全部全局热键');
      assert.equal(h.state.tray.isDestroyed(), true, '退出时应销毁托盘');
      assert.equal(h.ipcHandlers.size, 0, '退出时应注销全部 IPC handlers');
    } finally {
      h.dispose();
    }
  });
});

describe('2. 200ms blur 去抖、Esc 关闭与缺失 HTML 降级', () => {
  test('blur 失焦隐藏后 200ms 内点击托盘不重开，满 200ms 后恢复开启', async () => {
    const h = createMockElectronHarness();
    try {
      await h.boot();
      const panel = h.getPanelWindow();
      h.clickTray();
      assert.equal(panel.isVisible(), true);

      // 失焦自动隐藏并记录 lastBlurAt
      panel.blur();
      assert.equal(panel.isVisible(), false);

      // 199ms 内点击托盘：防重开去抖应保持隐藏
      h.clock.tick(150);
      h.clickTray();
      assert.equal(panel.isVisible(), false, '150ms 内再次点击不应重开');

      // 满 200ms 后点击托盘：正常重开
      h.clock.tick(50);
      h.clickTray();
      assert.equal(panel.isVisible(), true, '满 200ms 后点击应正常开启');

      // Esc 键关闭面板，且非 blur 隐藏后可立即再打开
      const prevented = panel.emitKeyDown('Escape');
      assert.equal(prevented, true);
      assert.equal(panel.isVisible(), false);
      h.clickTray();
      assert.equal(panel.isVisible(), true);
    } finally {
      h.dispose();
    }
  });

  test('M3 阶段 renderer HTML 未就绪时 loadHtmlSafe 降级占位页且无未捕获异常', async () => {
    const h = createMockElectronHarness({ simulateMissingHtml: true });
    try {
      await h.boot();
      const panel = h.getPanelWindow();
      assert.ok(panel);
      assert.ok(
        panel.loadedURL && panel.loadedURL.startsWith('data:text/html;charset=utf-8,'),
        'HTML 文件缺失时应降级加载内联占位 HTML'
      );
    } finally {
      h.dispose();
    }
  });
});

describe('3. 多屏 DPI workArea 四方位定位、负坐标与高度钳制', () => {
  test('computePopoverPosition 覆盖底/顶/左/右任务栏、自动隐藏与 0x0 trayBounds 兜底', () => {
    const cases = [
      {
        name: '底部任务栏',
        display: {
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1032 },
        },
        trayBounds: { x: 1700, y: 1040, width: 24, height: 40 },
        expectedEdge: 'bottom',
      },
      {
        name: '顶部任务栏',
        display: {
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 48, width: 1920, height: 1032 },
        },
        trayBounds: { x: 1700, y: 4, width: 24, height: 40 },
        expectedEdge: 'top',
      },
      {
        name: '左侧任务栏',
        display: {
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 60, y: 0, width: 1860, height: 1080 },
        },
        trayBounds: { x: 10, y: 980, width: 40, height: 24 },
        expectedEdge: 'left',
      },
      {
        name: '右侧任务栏',
        display: {
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1860, height: 1080 },
        },
        trayBounds: { x: 1870, y: 980, width: 40, height: 24 },
        expectedEdge: 'right',
      },
      {
        name: '多屏负坐标副屏（高 DPI 1.5x）',
        display: {
          bounds: { x: -1600, y: 0, width: 1600, height: 900 },
          workArea: { x: -1600, y: 0, width: 1600, height: 860 },
          scaleFactor: 1.5,
        },
        trayBounds: { x: -140, y: 868, width: 24, height: 32 },
        expectedEdge: 'bottom',
      },
      {
        name: '自动隐藏任务栏（无内缩）',
        display: {
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        },
        trayBounds: { x: 1800, y: 1076, width: 24, height: 4 },
        expectedEdge: 'bottom',
      },
      {
        name: '0x0 无效 trayBounds 兜底定位',
        display: {
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1032 },
        },
        trayBounds: { x: 0, y: 0, width: 0, height: 0 },
        expectedEdge: 'fallback',
      },
    ];

    for (const c of cases) {
      const pos = computePopoverPosition({
        trayBounds: c.trayBounds,
        display: c.display,
        panelWidth: 330,
        panelHeight: 460,
        gap: 8,
      });
      const wa = c.display.workArea;
      assert.equal(pos.edge, c.expectedEdge, `${c.name} 方位匹配`);
      assert.ok(pos.x >= wa.x, `${c.name}: x(${pos.x}) >= wa.x(${wa.x})`);
      assert.ok(pos.y >= wa.y, `${c.name}: y(${pos.y}) >= wa.y(${wa.y})`);
      assert.ok(pos.x + pos.width <= wa.x + wa.width, `${c.name}: 右侧不越界`);
      assert.ok(pos.y + pos.height <= wa.y + wa.height, `${c.name}: 底部不越界`);
    }
  });

  test('panel:resize 将过高面板钳制到 workArea.height - 16 并重新贴靠托盘上方', async () => {
    const h = createMockElectronHarness({
      displays: [
        {
          id: 1,
          bounds: { x: 0, y: 0, width: 1280, height: 720 },
          workArea: { x: 0, y: 0, width: 1280, height: 680 },
          scaleFactor: 1,
        },
      ],
      trayBounds: { x: 1100, y: 684, width: 24, height: 36 },
    });
    try {
      await h.boot();
      h.clickTray();
      const res = await h.invokeIpc('panel:resize', 330, 900);
      assert.equal(res.height, 680 - 16);
      const b = h.getPanelWindow().getBounds();
      assert.equal(b.height, 664);
      assert.ok(b.y >= 8 && b.y + b.height <= 680);
    } finally {
      h.dispose();
    }
  });
});

describe('4. 托盘 Tooltip 4 模式、UTF-16 127 字符安全截断与右键菜单', () => {
  test('4 种 MenuBarFormat、非工作时段与老板模式 Tooltip 及代理对截断保护', () => {
    const settings = defaultSettings();
    const engine = new WageEngine(settings);
    const snapWork = engine.snapshot(localDate(2026, 11, 17, 15, 18, 42));

    assert.equal(
      buildTrayTooltip(snapWork, { ...settings, menuBarFormat: MenuBarFormat.amountOnly }, false),
      '牛马加油器 · ¥611.01'
    );
    assert.equal(
      buildTrayTooltip(snapWork, { ...settings, menuBarFormat: MenuBarFormat.amountProgress }, false),
      '牛马加油器 · ¥611 · 64%'
    );
    assert.equal(
      buildTrayTooltip(snapWork, { ...settings, menuBarFormat: MenuBarFormat.amountCountdown }, false),
      '牛马加油器 · ¥611.01 · 2:41:18'
    );
    assert.equal(
      buildTrayTooltip(snapWork, { ...settings, menuBarFormat: MenuBarFormat.iconOnly }, false),
      IDLE_TOOLTIP
    );
    assert.equal(
      buildTrayTooltip(snapWork, { ...settings, menuBarFormat: MenuBarFormat.amountCountdown }, true),
      '牛马加油器 · ¥***.** · 2:41:18'
    );

    // 休息日 offHoursDisplay=iconOnly 时返回固定空闲提示
    const snapHoliday = engine.snapshot(localDate(2026, 10, 2, 10, 0, 0));
    assert.equal(
      buildTrayTooltip(snapHoliday, { ...settings, offHoursDisplay: OffHoursDisplay.text }, false),
      '牛马加油器 · 国庆休息'
    );
    assert.equal(
      buildTrayTooltip(snapHoliday, { ...settings, offHoursDisplay: OffHoursDisplay.iconOnly }, false),
      IDLE_TOOLTIP
    );

    // 超长货币符号或 emoji 代理对边界截断 <= 127 且不产生孤立高代理码元
    const longEmojiText = '牛马加油器 · ' + '💰'.repeat(80);
    const truncated = truncateTooltip(longEmojiText, 127);
    assert.ok(truncated.length <= 127);
    assert.ok(truncated.endsWith('…'));
    const charBeforeEllipsis = truncated.charCodeAt(truncated.length - 2);
    assert.equal(charBeforeEllipsis >= 0xd800 && charBeforeEllipsis <= 0xdbff, false);
  });

  test('托盘右键菜单包含 5 项且正确联动 boss 与快捷键标签', async () => {
    const h = createMockElectronHarness();
    try {
      await h.boot();
      const menu1 = h.state.tray.contextMenu;
      assert.equal(menu1.items.length, 5);
      assert.equal(menu1.items[0].label, '老板模式（Ctrl+Alt+B）');
      assert.equal(menu1.items[0].checked, false);
      assert.equal(menu1.items[1].label, '打开主面板');
      assert.equal(menu1.items[2].label, '设置…');
      assert.equal(menu1.items[3].type, 'separator');
      assert.equal(menu1.items[4].label, '退出牛马加油器');

      menu1.clickItem('老板模式');
      assert.equal((await h.invokeIpc('state:get')).boss, true);
      assert.equal(h.state.tray.contextMenu.items[0].checked, true);

      await h.invokeIpc('settings:update', { bossHotkey: BossHotkey.off });
      assert.equal(h.state.tray.contextMenu.items[0].label, '老板模式');

      const tpl = buildTrayMenuTemplate({ boss: true, bossHotkey: BossHotkey.ctrlOptCmdH });
      assert.equal(tpl[0].label, '老板模式（Ctrl+Alt+H）');
    } finally {
      h.dispose();
    }
  });
});

describe('5. 老板键注册、先注销后重注与占用冲突提示', () => {
  test('快捷键切换、停用与占用冲突均输出准确状态与中文告警', () => {
    const registered = new Map();
    const failing = new Set(['CommandOrControl+Alt+H']);
    const fakeGlobalShortcut = {
      register: (accel, cb) => {
        if (failing.has(accel)) return false;
        registered.set(accel, cb);
        return true;
      },
      unregister: (accel) => {
        registered.delete(accel);
      },
    };

    let toggled = 0;
    const hm = createHotkeyManager({
      globalShortcut: fakeGlobalShortcut,
      onToggle: () => {
        toggled += 1;
      },
    });

    const s1 = hm.apply(BossHotkey.ctrlOptB);
    assert.equal(s1.hotkeyRegistered, true);
    assert.equal(s1.hotkeyWarning, null);
    assert.equal(registered.has('CommandOrControl+Alt+B'), true);
    registered.get('CommandOrControl+Alt+B')();
    assert.equal(toggled, 1);

    // 切换到被占用的 ctrlOptCmdH：旧键应先被注销，且给出中文告警
    const s2 = hm.apply(BossHotkey.ctrlOptCmdH);
    assert.equal(registered.has('CommandOrControl+Alt+B'), false);
    assert.equal(s2.hotkeyRegistered, false);
    assert.ok(s2.hotkeyWarning && s2.hotkeyWarning.includes('Ctrl+Alt+H') && s2.hotkeyWarning.includes('占用'));

    // 停用 off：不注册且无告警
    const s3 = hm.apply(BossHotkey.off);
    assert.equal(s3.hotkeyRegistered, false);
    assert.equal(s3.hotkeyWarning, null);
  });
});

describe('6. Cheerleader 状态机、prime 去重、跨夜班与老板模式通知', () => {
  test('prime 静默对齐、跨夜班过零点不误重置、老板模式静默里程碑并打码下班通知', () => {
    const posts = [];
    const cheer = new Cheerleader({
      post: (title, body) => posts.push({ title, body }),
    });

    // 使用跨夜班设置（22:00 -> 次日 06:00，无午休）
    const settings = {
      ...defaultSettings(),
      workStart: 22 * 60,
      workEnd: 6 * 60,
      lunchEnabled: false,
      milestones: [
        { name: '一杯奶茶', amount: 15 },
        { name: '一份外卖', amount: 30 },
      ],
    };
    const engine = new WageEngine(settings);

    // 启动即处于 23:30，prime 应静默对齐不发历史通知
    const snap2330 = engine.snapshot(localDate(2026, 11, 17, 23, 30, 0));
    cheer.prime(snap2330);
    assert.equal(posts.length, 0);

    // 跨零点至次日 00:30 仍属 11-17 班次，prime 后的增量不再重复发 15/30
    const snap0030 = engine.snapshot(localDate(2026, 11, 18, 0, 30, 0));
    assert.equal(DayKey.key(snap0030.shiftDay), '2026-11-17');
    cheer.update(snap0030, settings, false);
    assert.equal(posts.length, 0);

    // 非 accrues 日（休息日）即使金额不变也更新 lastEarned 且不发通知
    const snapRest = {
      ...snap0030,
      shiftDay: localDate(2026, 11, 21, 0, 0, 0),
      day: { kind: 'weekend', name: null, isPaid: false, accrues: false },
      phase: Phase.rest,
      earnedToday: 0,
    };
    cheer.update(snapRest, settings, false);
    assert.equal(posts.length, 0);

    // 正常工作日从 09:00 推进：先跨 15 与 30，再老板模式下班
    const daySettings = defaultSettings();
    const dayEngine = new WageEngine(daySettings);
    cheer.prime(dayEngine.snapshot(localDate(2026, 11, 17, 9, 0, 0)));
    cheer.update(dayEngine.snapshot(localDate(2026, 11, 17, 9, 15, 0)), daySettings, false);
    assert.equal(posts.length, 2);
    assert.equal(posts[0].title, '刚挣够一杯奶茶');
    assert.equal(posts[1].title, '刚挣够一份外卖');

    // 老板模式下班：不泄露具体金额且只发 1 次
    cheer.update(dayEngine.snapshot(localDate(2026, 11, 17, 18, 0, 1)), daySettings, true);
    cheer.update(dayEngine.snapshot(localDate(2026, 11, 17, 18, 0, 2)), daySettings, true);
    assert.equal(posts.length, 3);
    assert.equal(posts[2].title, '下班啦');
    assert.equal(posts[2].body, '今天的钱已全部到账，润！');
  });

  test('powerMonitor resume 与时间跳变 >5000ms 自动 prime 且不补发历史通知', async () => {
    const h = createMockElectronHarness({
      initialNow: localDate(2026, 11, 17, 9, 0, 0).getTime(),
    });
    try {
      await h.boot();

      // 时间跳变 > 5000ms 到 16:00 后触发 1s tick：应识别跳变并 prime，不补发 4 条里程碑
      h.clock.jumpTo(localDate(2026, 11, 17, 16, 0, 0).getTime());
      h.clock.tick(1000);
      assert.equal(h.state.notifications.length, 0);
      const st1 = await h.invokeIpc('state:get');
      assert.ok(st1.snapshot.earnedToday > 600);

      // powerMonitor resume 同步重算与 prime
      h.clock.jumpTo(localDate(2026, 11, 17, 18, 5, 0).getTime());
      h.powerMonitorEmitter.emit('resume');
      assert.equal(h.state.notifications.length, 0);
      assert.ok(h.state.tray.toolTip.includes('¥952.38'));
      assert.ok(h.state.tray.toolTip.includes('✓'));
    } finally {
      h.dispose();
    }
  });
});

describe('7. 开机自启设置与异常捕获', () => {
  test('loginItem:set 在未打包态正常写入并回读，底层抛错时安全返回错误信息', async () => {
    const h1 = createMockElectronHarness({ isPackaged: false });
    try {
      await h1.boot();
      const resOn = await h1.invokeIpc('loginItem:set', true);
      assert.equal(resOn.ok, true);
      assert.equal(resOn.openAtLogin, true);
      assert.equal(h1.state.loginItem.openAtLogin, true);
      assert.ok(resOn.state.runtime.loginHint, '未打包态应附带开发提示');
    } finally {
      h1.dispose();
    }

    const h2 = createMockElectronHarness({ loginItemThrows: new Error('权限不足') });
    try {
      await h2.boot();
      const resErr = await h2.invokeIpc('loginItem:set', true);
      assert.equal(resErr.ok, false);
      assert.ok(resErr.error.includes('权限不足'));
      assert.equal(resErr.openAtLogin, false);
    } finally {
      h2.dispose();
    }
  });
});

describe('8. settings.json 容错读写、UTF-8 BOM、损坏备份与原子写入', () => {
  test('ENOENT 不提前落盘；UTF-8 BOM 正确读取；损坏 JSON 备份到 .corrupt.<ts>.bak 并重置为默认设置', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'niuma-store-'));
    try {
      const store = createSettingsStore({ userDataDir: dir, logger: { warn() {}, error() {} } });

      // 1. 首次缺失不提前创建文件
      const m1 = store.loadWithMeta();
      assert.equal(m1.status, 'missing');
      assert.equal(m1.settings.amount, 20000);
      assert.equal(fs.existsSync(store.filePath), false);

      // 2. 带 UTF-8 BOM 与多余非法键（含 boss）读取时保留合法字段并剔除脏字段
      assert.equal(stripUtf8Bom('\uFEFFabc'), 'abc');
      fs.writeFileSync(
        store.filePath,
        '\uFEFF' + JSON.stringify({ amount: 35000, incomeType: 'bad_enum', boss: true }),
        'utf8'
      );
      const m2 = store.loadWithMeta();
      assert.equal(m2.status, 'ok');
      assert.equal(m2.settings.amount, 35000);
      assert.equal(m2.settings.incomeType, 'monthly');
      assert.equal(m2.settings.boss, undefined);

      // 3. 损坏 JSON 备份到 .corrupt.<ts>.bak 且回落默认设置
      fs.writeFileSync(store.filePath, '{ "amount": ', 'utf8');
      const m3 = store.loadWithMeta();
      assert.equal(m3.status, 'corrupt');
      assert.ok(m3.backupPath && m3.backupPath.includes('.corrupt.') && m3.backupPath.endsWith('.bak'));
      assert.equal(fs.existsSync(m3.backupPath), true);
      assert.equal(m3.settings.amount, 20000);

      // 4. save() 净化后原子写入且不包含 boss
      const saveRes = store.save({ amount: 42000, boss: true, extraUnknown: 123 });
      assert.equal(saveRes.ok, true);
      const diskObj = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
      assert.equal(diskObj.amount, 42000);
      assert.equal(diskObj.boss, undefined);
      assert.equal(diskObj.extraUnknown, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('9. 全部 12 个 IPC handlers 与 preload.js 契约集成验证', () => {
  test('preload.js 仅暴露 window.niumaAPI 13 个方法，onStateUpdate 剥离 event 且幂等退订', async () => {
    const h = createMockElectronHarness();
    try {
      await h.boot();
      const { exposed, api, ipcRenderer } = h.loadPreload();

      assert.deepEqual(Object.keys(exposed), ['niumaAPI']);
      const expectedMethods = [
        'onStateUpdate',
        'getState',
        'updateSettings',
        'toggleBoss',
        'setBoss',
        'setBigSmallWeek',
        'importHolidaysDialog',
        'clearImportedHolidays',
        'setLoginItem',
        'resizePanel',
        'openSettings',
        'hidePanel',
        'quitApp',
      ];
      assert.deepEqual(Object.keys(api).sort(), expectedMethods.slice().sort());
      assert.equal(api.ipcRenderer, undefined);
      assert.equal(api.require, undefined);

      const received = [];
      const unsub = api.onStateUpdate((payload) => received.push(payload));
      assert.equal(ipcRenderer._listenerCount('state:update'), 1);

      ipcRenderer._emit('state:update', { boss: true });
      assert.equal(received.length, 1);
      assert.deepEqual(received[0], { boss: true });

      // 幂等退订
      unsub();
      unsub();
      assert.equal(ipcRenderer._listenerCount('state:update'), 0);

      const stateViaPreload = await api.getState();
      assert.equal(stateViaPreload.settings.amount, 20000);
    } finally {
      h.dispose();
    }
  });

  test('全部 12 个 IPC 通道完整链路：设置、大小周、节假日导入/清除、设置窗单实例与隐藏面板', async () => {
    const tmpHolidayGood = path.join(os.tmpdir(), `niuma-holiday-good-${Date.now()}.json`);
    const tmpHolidayBad = path.join(os.tmpdir(), `niuma-holiday-bad-${Date.now()}.json`);
    fs.writeFileSync(
      tmpHolidayGood,
      JSON.stringify([{ date: '2028-01-01', type: 'holiday', name: '2028元旦' }]),
      'utf8'
    );
    fs.writeFileSync(tmpHolidayBad, '{ not valid json', 'utf8');

    const h = createMockElectronHarness({
      initialNow: localDate(2026, 11, 17, 15, 18, 42).getTime(),
    });
    try {
      await h.boot();

      // 1. state:get
      const s0 = await h.invokeIpc('state:get');
      assert.equal(s0.boss, false);
      assert.ok(s0.panelText && s0.panelText.earned === '¥611.01');
      assert.ok(s0.runtime && s0.runtime.statusSamples.iconOnly === '金额只在面板里看');

      // 2. settings:update
      const s1 = await h.invokeIpc('settings:update', { amount: 40000 });
      assert.equal(s1.settings.amount, 40000);

      // 3 & 4. boss:toggle & boss:set
      const s2 = await h.invokeIpc('boss:toggle');
      assert.equal(s2.boss, true);
      assert.equal(s2.panelText.earned, '¥***.**');
      const s3 = await h.invokeIpc('boss:set', false);
      assert.equal(s3.boss, false);

      // 5. bigSmallWeek:toggle（自动锚定本周一 2026-11-16）
      const s4 = await h.invokeIpc('bigSmallWeek:toggle', true);
      assert.equal(s4.settings.bigSmallWeek, true);
      assert.equal(s4.settings.bigWeekAnchor, '2026-11-16');
      assert.equal(s4.runtime.isBigWeek, true);

      // 6. holidays:importDialog（取消 / 失败 / 成功）
      h.setOpenDialogResult({ canceled: true, filePaths: [] });
      const impCancel = await h.invokeIpc('holidays:importDialog');
      assert.equal(impCancel.canceled, true);

      h.setOpenDialogResult({ canceled: false, filePaths: [tmpHolidayBad] });
      const impFail = await h.invokeIpc('holidays:importDialog');
      assert.equal(impFail.ok, false);
      assert.equal(impFail.message, '导入失败：文件不是正确的格式。');

      h.setOpenDialogResult({ canceled: false, filePaths: [tmpHolidayGood] });
      const impOk = await h.invokeIpc('holidays:importDialog');
      assert.equal(impOk.ok, true);
      assert.equal(impOk.importedCount, 1);
      assert.equal(impOk.message, '已导入 1 天。');

      // 7. holidays:clearImported
      const s5 = await h.invokeIpc('holidays:clearImported');
      assert.equal(s5.settings.importedHolidays.length, 0);

      // 8 & 9 & 10 & 11. window:openSettings, window:hidePanel, panel:resize
      h.clickTray();
      assert.equal(h.getPanelWindow().isVisible(), true);

      const openRes1 = await h.invokeIpc('window:openSettings', 'holidays');
      assert.equal(openRes1.tab, 'holidays');
      assert.equal(h.getPanelWindow().isVisible(), false, '打开设置应先隐藏主面板');
      const sw1 = h.getSettingsWindow();
      assert.equal(sw1.loadOptions.query.tab, 'holidays');

      const openRes2 = await h.invokeIpc('window:openSettings', 3);
      assert.equal(openRes2.tab, 'display');
      assert.equal(h.getSettingsWindow(), sw1, '设置窗口应复用单实例');

      h.clickTray();
      assert.equal(h.getPanelWindow().isVisible(), true);
      await h.invokeIpc('window:hidePanel');
      assert.equal(h.getPanelWindow().isVisible(), false);

      const resizeRes = await h.invokeIpc('panel:resize', 330, 500);
      assert.equal(resizeRes.ok, true);
      assert.equal(resizeRes.height, 500);

      // 12. app:quit
      await h.invokeIpc('app:quit');
      assert.equal(h.state.quitCalled, true);
    } finally {
      h.dispose();
      fs.rmSync(tmpHolidayGood, { force: true });
      fs.rmSync(tmpHolidayBad, { force: true });
    }
  });
});
