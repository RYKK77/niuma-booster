'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { createVirtualClock } = require('./virtualClock');
const { requireRepoPaths } = require('./coreCompat');

const origSetImmediate = globalThis.setImmediate;

/**
 * 极简同步/微任务事件发射器（不依赖 node:events 外部行为差异）
 */
function createEmitter() {
  /** @type {Map<string, Array<{ fn: Function, once: boolean }>>} */
  const listeners = new Map();

  function on(event, fn) {
    if (typeof fn !== 'function') return this;
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push({ fn, once: false });
    return this;
  }

  function once(event, fn) {
    if (typeof fn !== 'function') return this;
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push({ fn, once: true });
    return this;
  }

  function off(event, fn) {
    const arr = listeners.get(event);
    if (!arr) return this;
    const filtered = arr.filter((item) => item.fn !== fn);
    if (filtered.length > 0) listeners.set(event, filtered);
    else listeners.delete(event);
    return this;
  }

  function removeAllListeners(event) {
    if (event === undefined) listeners.clear();
    else listeners.delete(event);
    return this;
  }

  function emit(event, ...args) {
    const arr = listeners.get(event);
    if (!arr || arr.length === 0) return false;
    const snapshot = arr.slice();
    const remaining = arr.filter((item) => !item.once);
    if (remaining.length > 0) listeners.set(event, remaining);
    else listeners.delete(event);
    for (const item of snapshot) {
      item.fn.apply(this, args);
    }
    return true;
  }

  function listenerCount(event) {
    return (listeners.get(event) || []).length;
  }

  return {
    on,
    addListener: on,
    once,
    off,
    removeListener: off,
    removeAllListeners,
    emit,
    listenerCount,
  };
}

function cloneIpcValue(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}

/**
 * 创建 Electron 主进程全链路 Mock Harness
 * 通过 Module._load 拦截 require('electron')，使用独立临时 userData 目录与 VirtualClock。
 */
function createElectronHarness(options = {}) {
  const paths = requireRepoPaths();
  const initialNow =
    options.initialNow !== undefined
      ? options.initialNow
      : new Date(2026, 10, 17, 10, 0, 0).getTime();

  const singleInstanceLock =
    options.singleInstanceLock !== undefined ? Boolean(options.singleInstanceLock) : true;
  const notificationSupported =
    options.notificationSupported !== undefined ? Boolean(options.notificationSupported) : true;
  const failingShortcuts = new Set(options.failingShortcuts || []);
  const loginItemThrows = options.loginItemThrows || null;
  const isPackaged = Boolean(options.isPackaged);

  let currentTrayBounds = options.trayBounds
    ? { ...options.trayBounds }
    : { x: 1700, y: 1040, width: 24, height: 40 };

  let currentDisplays = options.displays
    ? structuredClone(options.displays)
    : [
        {
          id: 1,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1032 },
          scaleFactor: 1,
        },
      ];

  let currentOpenDialogResult = options.openDialogResult
    ? structuredClone(options.openDialogResult)
    : { canceled: true, filePaths: [] };

  const userDataDir = options.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'niuma-e2e-'));
  const ownsUserDataDir = !options.userDataDir;

  // 预写入 settings.json（如指定）
  const settingsFilePath = path.join(userDataDir, 'settings.json');
  if (options.corruptSettingsRaw !== undefined && options.corruptSettingsRaw !== null) {
    fs.writeFileSync(settingsFilePath, String(options.corruptSettingsRaw), 'utf8');
  } else if (options.initialSettings !== undefined && options.initialSettings !== null) {
    const raw =
      typeof options.initialSettings === 'string'
        ? options.initialSettings
        : JSON.stringify(options.initialSettings, null, 2);
    fs.writeFileSync(settingsFilePath, raw, 'utf8');
  }

  const clock = createVirtualClock(initialNow);

  const state = {
    quitCalled: false,
    exitCode: null,
    appUserModelId: null,
    loginItem: { openAtLogin: false },
    windows: [],
    tray: null,
    notifications: [],
    registeredShortcuts: new Map(),
    dialogCalls: [],
    applicationMenu: null,
  };

  /** @type {Map<string, { fn: Function, once: boolean }>} */
  const ipcHandlers = new Map();
  const ipcListenerBus = createEmitter();

  const appEmitter = createEmitter();
  const powerMonitorEmitter = createEmitter();

  let nextWinId = 1;
  let origModuleLoad = null;
  let preloadElectronOverride = null;
  let booted = false;

  const app = {
    ...appEmitter,
    requestSingleInstanceLock: () => singleInstanceLock,
    releaseSingleInstanceLock: () => {},
    quit: () => {
      state.quitCalled = true;
      const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      appEmitter.emit('before-quit', ev);
      if (!ev.defaultPrevented) {
        appEmitter.emit('will-quit', ev);
        appEmitter.emit('quit', {}, 0);
      }
    },
    exit: (code = 0) => {
      state.quitCalled = true;
      state.exitCode = code;
    },
    getPath: (name) => {
      if (name === 'userData') return userDataDir;
      return path.join(userDataDir, name);
    },
    getAppPath: () => paths.windowsRoot,
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
    getName: () => '牛马加油器',
    getVersion: () => '1.0.0',
  };

  class MockTray {
    constructor(image) {
      this._emitter = createEmitter();
      this.image = image;
      this.toolTip = '';
      this.toolTipHistory = [];
      this.contextMenu = null;
      this.lastPoppedMenu = null;
      this.destroyed = false;
      state.tray = this;
    }
    on(ev, fn) { this._emitter.on(ev, fn); return this; }
    once(ev, fn) { this._emitter.once(ev, fn); return this; }
    off(ev, fn) { this._emitter.off(ev, fn); return this; }
    removeListener(ev, fn) { this._emitter.off(ev, fn); return this; }
    emit(ev, ...args) { return this._emitter.emit(ev, ...args); }
    setImage(img) { this.image = img; }
    setToolTip(str) {
      this.toolTip = String(str);
      this.toolTipHistory.push(this.toolTip);
    }
    setContextMenu(menu) { this.contextMenu = menu; }
    getBounds() { return { ...currentTrayBounds }; }
    popUpContextMenu(menu) {
      this.lastPoppedMenu = menu || this.contextMenu;
    }
    destroy() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
  }

  function wrapMenuTemplate(tpl) {
    const items = (tpl || []).map((rawItem) => {
      const item = { ...rawItem };
      if (Array.isArray(rawItem.submenu)) {
        item.submenu = buildMenuFromTemplate(rawItem.submenu);
      }
      return item;
    });
    return items;
  }

  function findMenuItem(items, labelSubstr) {
    for (const item of items) {
      if (typeof item.label === 'string' && item.label.includes(labelSubstr)) {
        return item;
      }
      if (item.submenu && Array.isArray(item.submenu.items)) {
        const found = findMenuItem(item.submenu.items, labelSubstr);
        if (found) return found;
      }
    }
    return null;
  }

  function buildMenuFromTemplate(tpl) {
    const items = wrapMenuTemplate(tpl);
    const menu = {
      items,
      findItem(labelSubstr) {
        return findMenuItem(items, labelSubstr);
      },
      clickItem(labelSubstr) {
        const item = findMenuItem(items, labelSubstr);
        if (!item) {
          throw new Error(`右键菜单中未找到匹配项: ${labelSubstr}`);
        }
        if (item.enabled === false) return item;
        if (item.type === 'checkbox') {
          item.checked = !item.checked;
        }
        if (typeof item.click === 'function') {
          const focused = state.windows.find((w) => !w.isDestroyed() && w.isFocused()) || null;
          item.click(item, focused, {});
        }
        return item;
      },
    };
    return menu;
  }

  const Menu = {
    buildFromTemplate: buildMenuFromTemplate,
    setApplicationMenu: (menu) => {
      state.applicationMenu = menu;
    },
  };

  class MockBrowserWindow {
    constructor(opts = {}) {
      this._emitter = createEmitter();
      this._wcEmitter = createEmitter();
      this.id = nextWinId++;
      this.options = { ...opts };
      this._visible = opts.show !== undefined ? Boolean(opts.show) : true;
      this._focused = false;
      this._destroyed = false;
      this._x = opts.x !== undefined ? Math.round(opts.x) : 0;
      this._y = opts.y !== undefined ? Math.round(opts.y) : 0;
      this._width = opts.width !== undefined ? Math.round(opts.width) : 800;
      this._height = opts.height !== undefined ? Math.round(opts.height) : 600;
      this._contentWidth = this._width;
      this._contentHeight = this._height;
      this._alwaysOnTop = Boolean(opts.alwaysOnTop);
      this._skipTaskbar = Boolean(opts.skipTaskbar);
      this.loadedFile = null;
      this.loadedURL = null;
      this._attachedIpcRenderers = [];

      const self = this;
      this.webContents = {
        id: this.id,
        sentMessages: [],
        on: (ev, fn) => { self._wcEmitter.on(ev, fn); return self.webContents; },
        once: (ev, fn) => { self._wcEmitter.once(ev, fn); return self.webContents; },
        off: (ev, fn) => { self._wcEmitter.off(ev, fn); return self.webContents; },
        removeListener: (ev, fn) => { self._wcEmitter.off(ev, fn); return self.webContents; },
        isDestroyed: () => self._destroyed,
        send: (channel, ...args) => {
          if (self._destroyed) return;
          const cloned = args.map(cloneIpcValue);
          self.webContents.sentMessages.push({ channel, args: cloned });
          for (const ipcR of self._attachedIpcRenderers) {
            ipcR._deliver(channel, ...args.map(cloneIpcValue));
          }
        },
        setWindowOpenHandler: () => {},
        openDevTools: () => {},
      };

      state.windows.push(this);
    }

    static getAllWindows() {
      return state.windows.filter((w) => !w.isDestroyed());
    }

    static fromWebContents(wc) {
      return state.windows.find((w) => w.webContents === wc) || null;
    }

    on(ev, fn) { this._emitter.on(ev, fn); return this; }
    once(ev, fn) { this._emitter.once(ev, fn); return this; }
    off(ev, fn) { this._emitter.off(ev, fn); return this; }
    removeListener(ev, fn) { this._emitter.off(ev, fn); return this; }

    loadFile(filePath, loadOpts = {}) {
      this.loadedFile = filePath;
      this.loadOptions = loadOpts;
      Promise.resolve().then(() => {
        if (!this._destroyed) {
          this._wcEmitter.emit('dom-ready');
          this._wcEmitter.emit('did-finish-load');
          this._emitter.emit('ready-to-show');
        }
      });
      return Promise.resolve();
    }

    loadURL(url) {
      this.loadedURL = url;
      Promise.resolve().then(() => {
        if (!this._destroyed) {
          this._wcEmitter.emit('dom-ready');
          this._wcEmitter.emit('did-finish-load');
          this._emitter.emit('ready-to-show');
        }
      });
      return Promise.resolve();
    }

    show() {
      if (this._destroyed) return;
      this._visible = true;
      this._focused = true;
      this._emitter.emit('show');
      this._emitter.emit('focus');
    }

    showInactive() {
      if (this._destroyed) return;
      this._visible = true;
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

    close() {
      if (this._destroyed) return;
      const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this._emitter.emit('close', ev);
      if (!ev.defaultPrevented) {
        this.destroy();
      }
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

    setPosition(x, y) {
      this._x = Math.round(x);
      this._y = Math.round(y);
    }

    getPosition() {
      return [this._x, this._y];
    }

    setBounds(r) {
      if (!r) return;
      if (r.x !== undefined) this._x = Math.round(r.x);
      if (r.y !== undefined) this._y = Math.round(r.y);
      if (r.width !== undefined) {
        this._width = Math.round(r.width);
        this._contentWidth = this._width;
      }
      if (r.height !== undefined) {
        this._height = Math.round(r.height);
        this._contentHeight = this._height;
      }
    }

    getBounds() {
      return { x: this._x, y: this._y, width: this._width, height: this._height };
    }

    setContentSize(w, h) {
      this._contentWidth = Math.round(w);
      this._contentHeight = Math.round(h);
      this._width = this._contentWidth;
      this._height = this._contentHeight;
    }

    getContentSize() {
      return [this._contentWidth, this._contentHeight];
    }

    setSize(w, h) {
      this._width = Math.round(w);
      this._height = Math.round(h);
      this._contentWidth = this._width;
      this._contentHeight = this._height;
    }

    getSize() {
      return [this._width, this._height];
    }

    setAlwaysOnTop(b) { this._alwaysOnTop = Boolean(b); }
    setSkipTaskbar(b) { this._skipTaskbar = Boolean(b); }
    setVisibleOnAllWorkspaces() {}
    setResizable(b) { this.options.resizable = Boolean(b); }
    setMinimizable() {}
    setMaximizable() {}
    setFullScreenable() {}
    setMenuBarVisibility() {}
    setAutoHideMenuBar() {}
    removeMenu() {}
    center() {
      const primary = currentDisplays[0];
      if (primary) {
        const wa = primary.workArea || primary.bounds;
        this._x = Math.round(wa.x + (wa.width - this._width) / 2);
        this._y = Math.round(wa.y + (wa.height - this._height) / 2);
      }
    }

    emitBlur() {
      this.blur();
    }

    emitClose() {
      this.close();
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
    unregisterAll: () => {
      state.registeredShortcuts.clear();
    },
    isRegistered: (accel) => state.registeredShortcuts.has(accel),
  };

  class MockNotification {
    static isSupported() {
      return notificationSupported;
    }
    constructor(opts = {}) {
      this._emitter = createEmitter();
      this._opts = {
        title: opts.title !== undefined ? String(opts.title) : '',
        body: opts.body !== undefined ? String(opts.body) : '',
        icon: opts.icon !== undefined ? opts.icon : null,
        silent: Boolean(opts.silent),
      };
    }
    on(ev, fn) { this._emitter.on(ev, fn); return this; }
    once(ev, fn) { this._emitter.once(ev, fn); return this; }
    off(ev, fn) { this._emitter.off(ev, fn); return this; }
    show() {
      state.notifications.push({ ...this._opts, at: clock.now() });
      this._emitter.emit('show');
    }
    close() {
      this._emitter.emit('close');
    }
  }

  const screen = {
    getPrimaryDisplay: () => structuredClone(currentDisplays[0]),
    getAllDisplays: () => structuredClone(currentDisplays),
    getDisplayNearestPoint: ({ x, y }) => {
      for (const d of currentDisplays) {
        const b = d.bounds;
        if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) {
          return structuredClone(d);
        }
      }
      // 不在任意矩形内时取最近矩形距离
      let best = currentDisplays[0];
      let bestDist = Infinity;
      for (const d of currentDisplays) {
        const b = d.bounds;
        const dx = x < b.x ? b.x - x : x > b.x + b.width ? x - (b.x + b.width) : 0;
        const dy = y < b.y ? b.y - y : y > b.y + b.height ? y - (b.y + b.height) : 0;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = d;
        }
      }
      return structuredClone(best);
    },
  };

  const dialog = {
    showOpenDialog: async (winOrOpts, maybeOpts) => {
      const hasWin = maybeOpts !== undefined;
      state.dialogCalls.push({
        win: hasWin ? winOrOpts : null,
        opts: hasWin ? maybeOpts : winOrOpts,
      });
      return structuredClone(currentOpenDialogResult);
    },
  };

  const ipcMain = {
    handle: (channel, fn) => {
      ipcHandlers.set(channel, { fn, once: false });
    },
    handleOnce: (channel, fn) => {
      ipcHandlers.set(channel, { fn, once: true });
    },
    removeHandler: (channel) => {
      ipcHandlers.delete(channel);
    },
    on: (channel, fn) => { ipcListenerBus.on(channel, fn); return ipcMain; },
    once: (channel, fn) => { ipcListenerBus.once(channel, fn); return ipcMain; },
    off: (channel, fn) => { ipcListenerBus.off(channel, fn); return ipcMain; },
    removeListener: (channel, fn) => { ipcListenerBus.off(channel, fn); return ipcMain; },
    removeAllListeners: (channel) => { ipcListenerBus.removeAllListeners(channel); return ipcMain; },
  };

  const nativeImage = {
    createFromPath: (p) => {
      const exists = Boolean(p) && fs.existsSync(p);
      return {
        _path: p,
        isEmpty: () => !exists,
        getSize: () => (exists ? { width: 16, height: 16 } : { width: 0, height: 0 }),
        resize: () => nativeImage.createFromPath(p),
        setTemplateImage: () => {},
      };
    },
    createEmpty: () => ({
      _path: '',
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: () => nativeImage.createEmpty(),
      setTemplateImage: () => {},
    }),
  };

  const shell = {
    openExternal: async () => {},
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
    shell,
  };

  function clearSrcRequireCache() {
    const srcRoot = path.join(paths.windowsRoot, 'src') + path.sep;
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(srcRoot)) {
        delete require.cache[key];
      }
    }
  }

  function installModuleHook() {
    if (origModuleLoad) return;
    origModuleLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') {
        return preloadElectronOverride || mockElectron;
      }
      return origModuleLoad.call(this, request, parent, isMain);
    };
  }

  function restoreModuleHook() {
    if (!origModuleLoad) return;
    Module._load = origModuleLoad;
    origModuleLoad = null;
  }

  async function flushAsync() {
    await Promise.resolve();
    await Promise.resolve();
    if (typeof origSetImmediate === 'function') {
      await new Promise((resolve) => origSetImmediate(resolve));
    }
    await Promise.resolve();
    await Promise.resolve();
  }

  async function bootMain() {
    if (booted) return;
    booted = true;
    clock.install();
    installModuleHook();
    clearSrcRequireCache();
    require(paths.mainEntry);
    await flushAsync();
  }

  async function invokeIpcOnWindow(win, channel, ...args) {
    const entry = ipcHandlers.get(channel);
    if (!entry) {
      throw new Error(`未注册 ipcMain.handle 通道: ${channel}`);
    }
    if (entry.once) {
      ipcHandlers.delete(channel);
    }
    const senderWc = win ? win.webContents : (getPanelWindow() || state.windows[0] || { webContents: { id: 0, isDestroyed: () => false } }).webContents;
    const event = { sender: senderWc };
    const clonedArgs = args.map(cloneIpcValue);
    const result = await entry.fn(event, ...clonedArgs);
    return cloneIpcValue(result);
  }

  function createWindowIpcRenderer(win) {
    const bus = createEmitter();
    const ipcRenderer = {
      invoke: (channel, ...args) => invokeIpcOnWindow(win, channel, ...args),
      send: (channel, ...args) => {
        const senderWc = win ? win.webContents : null;
        ipcListenerBus.emit(channel, { sender: senderWc }, ...args.map(cloneIpcValue));
      },
      on: (channel, fn) => { bus.on(channel, fn); return ipcRenderer; },
      once: (channel, fn) => { bus.once(channel, fn); return ipcRenderer; },
      off: (channel, fn) => { bus.off(channel, fn); return ipcRenderer; },
      removeListener: (channel, fn) => { bus.off(channel, fn); return ipcRenderer; },
      removeAllListeners: (channel) => { bus.removeAllListeners(channel); return ipcRenderer; },
      _deliver: (channel, ...args) => {
        bus.emit(channel, { sender: ipcRenderer }, ...args);
      },
    };
    if (win && Array.isArray(win._attachedIpcRenderers)) {
      win._attachedIpcRenderers.push(ipcRenderer);
    }
    return ipcRenderer;
  }

  function loadPreloadWithMeta(win) {
    installModuleHook();
    const exposed = {};
    const ipcRenderer = createWindowIpcRenderer(win);
    const contextBridge = {
      exposeInMainWorld: (key, api) => {
        exposed[key] = api;
      },
    };

    delete require.cache[require.resolve(paths.preloadPath)];
    preloadElectronOverride = { contextBridge, ipcRenderer };
    try {
      require(paths.preloadPath);
    } finally {
      preloadElectronOverride = null;
    }

    return {
      api: exposed.niumaAPI,
      exposed,
      ipcRenderer,
    };
  }

  function loadPreloadForWindow(win) {
    return loadPreloadWithMeta(win).api;
  }

  function getPanelWindow() {
    const alive = state.windows.filter(
      (w) => !w.isDestroyed() && w.loadedFile && path.basename(w.loadedFile) === 'panel.html'
    );
    if (alive.length > 0) return alive[alive.length - 1];
    const any = state.windows.filter(
      (w) => w.loadedFile && path.basename(w.loadedFile) === 'panel.html'
    );
    return any.length > 0 ? any[any.length - 1] : null;
  }

  function getSettingsWindow() {
    const alive = state.windows.filter(
      (w) => !w.isDestroyed() && w.loadedFile && path.basename(w.loadedFile) === 'settings.html'
    );
    if (alive.length > 0) return alive[alive.length - 1];
    const any = state.windows.filter(
      (w) => w.loadedFile && path.basename(w.loadedFile) === 'settings.html'
    );
    return any.length > 0 ? any[any.length - 1] : null;
  }

  function clickTray(overrides = {}) {
    if (!state.tray) throw new Error('Tray 尚未创建');
    const ev = { altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, ...overrides };
    state.tray.emit('click', ev, state.tray.getBounds());
  }

  function rightClickTray() {
    if (!state.tray) throw new Error('Tray 尚未创建');
    state.tray.emit('right-click', {}, state.tray.getBounds());
  }

  function triggerShortcut(accel) {
    const cb = state.registeredShortcuts.get(accel);
    if (!cb) return false;
    cb();
    return true;
  }

  function emitPowerResume() {
    powerMonitorEmitter.emit('resume');
  }

  function emitSecondInstance(argv = [], workingDirectory = '') {
    appEmitter.emit('second-instance', {}, argv, workingDirectory);
  }

  function emitWindowAllClosed() {
    appEmitter.emit('window-all-closed');
  }

  function setScreenConfig({ displays, trayBounds } = {}) {
    if (displays) currentDisplays = structuredClone(displays);
    if (trayBounds) currentTrayBounds = { ...trayBounds };
  }

  function setOpenDialogResult(res) {
    currentOpenDialogResult = structuredClone(res);
  }

  function readPersistedSettingsRaw() {
    if (!fs.existsSync(settingsFilePath)) return null;
    return fs.readFileSync(settingsFilePath, 'utf8');
  }

  function readPersistedSettings() {
    const raw = readPersistedSettingsRaw();
    return raw === null ? null : JSON.parse(raw);
  }

  function dispose() {
    try {
      clock.restore();
    } finally {
      restoreModuleHook();
      clearSrcRequireCache();
      if (ownsUserDataDir && fs.existsSync(userDataDir)) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
    }
  }

  return {
    clock,
    userDataDir,
    state,
    ipcHandlers,
    ipcListeners: ipcListenerBus,
    get tray() { return state.tray; },
    get windows() { return state.windows; },
    get notifications() { return state.notifications; },
    get registeredShortcuts() { return state.registeredShortcuts; },
    get dialogCalls() { return state.dialogCalls; },
    bootMain,
    dispose,
    clickTray,
    rightClickTray,
    triggerShortcut,
    emitPowerResume,
    emitSecondInstance,
    emitWindowAllClosed,
    setScreenConfig,
    setOpenDialogResult,
    loadPreloadForWindow,
    loadPreloadWithMeta,
    loadPreload: loadPreloadForWindow,
    invokeIpc: (channel, ...args) => invokeIpcOnWindow(null, channel, ...args),
    getPanelWindow,
    getSettingsWindow,
    readPersistedSettingsRaw,
    readPersistedSettings,
    flushAsync,
  };
}

module.exports = {
  createElectronHarness,
};
