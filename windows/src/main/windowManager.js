'use strict';

/**
 * 窗口管理模块（主面板 Popover 与单实例 4 标签设置窗口）。
 * 负责无边框 Popover 构造、多屏 DPI `workArea` 四方位定位与钳制、200ms `blur` 防重开去抖、`Esc` 关闭、动态调高及设置窗复用。
 */

const path = require('node:path');
const { resolveAssetPath } = require('./cheerleader');

const PANEL_WIDTH = 330;
const DEFAULT_PANEL_HEIGHT = 460;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 600;
const MIN_PANEL_HEIGHT = 180;
const EDGE_GAP = 8;
const BLUR_DEBOUNCE_MS = 200;
const SETTINGS_WIDTH = 720;
const SETTINGS_HEIGHT = 680;

const VALID_SETTINGS_TABS = ['salary', 'schedule', 'holidays', 'display'];

/**
 * 将数值安全钳位到 `[min, max]` 区间（当 `max < min` 时回落 `min`）。
 * @param {number} value - 目标数值
 * @param {number} min - 下界
 * @param {number} max - 上界
 * @returns {number} 钳位后的整数或数值
 */
function clamp(value, min, max) {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * 规范化设置窗口页签参数（支持字符串名称与 `0..3` 数字索引）。
 * @param {string | number} tab - 页签标识
 * @returns {'salary' | 'schedule' | 'holidays' | 'display'} 规范化页签名称
 */
function normalizeSettingsTab(tab) {
  if (typeof tab === 'number' && Number.isInteger(tab)) {
    return VALID_SETTINGS_TABS[tab] || 'salary';
  }
  if (typeof tab === 'string') {
    const trimmed = tab.trim();
    if (VALID_SETTINGS_TABS.includes(trimmed)) {
      return trimmed;
    }
    const asIndex = Number(trimmed);
    if (Number.isInteger(asIndex) && VALID_SETTINGS_TABS[asIndex]) {
      return VALID_SETTINGS_TABS[asIndex];
    }
  }
  return 'salary';
}

/**
 * 判断矩形边界是否为有效的非零区域。
 * @param {object} bounds - 矩形 `{ x, y, width, height }`
 * @returns {boolean} 是否有效
 */
function hasValidBounds(bounds) {
  return Boolean(
    bounds &&
      Number.isFinite(bounds.x) &&
      Number.isFinite(bounds.y) &&
      Number.isFinite(bounds.width) &&
      Number.isFinite(bounds.height) &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      !(bounds.x === 0 && bounds.y === 0)
  );
}

/**
 * 纯函数：根据托盘边界与显示器 `workArea` 计算 Popover 位置与钳制尺寸。
 * 兼容底/顶/左/右四方位任务栏、自动隐藏任务栏、多屏负坐标与 `0x0` `trayBounds` 兜底。
 * @param {object} params - 定位输入参数
 * @param {object | null} params.trayBounds - 托盘图标矩形
 * @param {object | null} params.display - Electron Display 对象
 * @param {number} [params.panelWidth=330] - 期望面板宽度
 * @param {number} [params.panelHeight=460] - 期望面板高度
 * @param {number} [params.gap=8] - 与屏幕/托盘边缘的安全间距
 * @returns {{ x: number, y: number, width: number, height: number, edge: string }} 计算结果
 */
function computePopoverPosition({
  trayBounds,
  display,
  panelWidth = PANEL_WIDTH,
  panelHeight = DEFAULT_PANEL_HEIGHT,
  gap = EDGE_GAP,
}) {
  const wa = (display && display.workArea) ||
    (display && display.bounds) || { x: 0, y: 0, width: 1920, height: 1080 };
  const db = (display && display.bounds) || wa;

  const maxW = Math.max(100, wa.width - gap * 2);
  const w = clamp(Math.round(panelWidth), Math.min(100, maxW), maxW);

  const maxH = Math.max(120, wa.height - gap * 2);
  const h = clamp(Math.round(panelHeight), Math.min(120, maxH), maxH);

  if (!hasValidBounds(trayBounds)) {
    const x = clamp(Math.round(wa.x + wa.width - w - gap), wa.x + gap, wa.x + wa.width - w - gap);
    const y = clamp(Math.round(wa.y + wa.height - h - gap), wa.y + gap, wa.y + wa.height - h - gap);
    return { x, y, width: w, height: h, edge: 'fallback' };
  }

  const trayCenterX = trayBounds.x + trayBounds.width / 2;
  const trayCenterY = trayBounds.y + trayBounds.height / 2;

  const insets = [
    { edge: 'bottom', value: db.y + db.height - (wa.y + wa.height) },
    { edge: 'top', value: wa.y - db.y },
    { edge: 'left', value: wa.x - db.x },
    { edge: 'right', value: db.x + db.width - (wa.x + wa.width) },
  ];

  let edge = 'bottom';
  let bestInset = 0;
  for (const item of insets) {
    if (item.value > bestInset) {
      bestInset = item.value;
      edge = item.edge;
    }
  }

  // 自动隐藏任务栏或无内缩副屏：按托盘中心到工作区四边的归一化距离就近判定方位
  if (bestInset <= 0) {
    const distances = [
      { edge: 'bottom', dist: Math.abs(wa.y + wa.height - trayCenterY) / Math.max(1, wa.height) },
      { edge: 'top', dist: Math.abs(trayCenterY - wa.y) / Math.max(1, wa.height) },
      { edge: 'left', dist: Math.abs(trayCenterX - wa.x) / Math.max(1, wa.width) },
      { edge: 'right', dist: Math.abs(wa.x + wa.width - trayCenterX) / Math.max(1, wa.width) },
    ];
    let bestDist = Infinity;
    for (const item of distances) {
      if (item.dist < bestDist) {
        bestDist = item.dist;
        edge = item.edge;
      }
    }
  }

  let x;
  let y;
  switch (edge) {
    case 'top':
      x = Math.round(trayCenterX - w / 2);
      y = Math.max(Math.round(trayBounds.y + trayBounds.height + gap), wa.y + gap);
      break;
    case 'left':
      x = Math.max(Math.round(trayBounds.x + trayBounds.width + gap), wa.x + gap);
      y = Math.round(trayCenterY - h / 2);
      break;
    case 'right':
      x = Math.min(Math.round(trayBounds.x - w - gap), wa.x + wa.width - w - gap);
      y = Math.round(trayCenterY - h / 2);
      break;
    case 'bottom':
    default:
      x = Math.round(trayCenterX - w / 2);
      y = Math.min(Math.round(trayBounds.y - h - gap), wa.y + wa.height - h - gap);
      break;
  }

  x = clamp(Math.round(x), wa.x + gap, wa.x + wa.width - w - gap);
  y = clamp(Math.round(y), wa.y + gap, wa.y + wa.height - h - gap);

  return { x, y, width: w, height: h, edge };
}

/**
 * 选择 Popover 定位所依赖的目标显示器（优先托盘中心所在屏，其次光标屏，最后主屏）。
 * @param {object} screen - Electron `screen` 模块
 * @param {object | null} trayBounds - 托盘矩形
 * @returns {object | null} Display 对象
 */
function selectDisplay(screen, trayBounds) {
  if (!screen) {
    return null;
  }
  try {
    if (hasValidBounds(trayBounds) && typeof screen.getDisplayNearestPoint === 'function') {
      return screen.getDisplayNearestPoint({
        x: Math.round(trayBounds.x + trayBounds.width / 2),
        y: Math.round(trayBounds.y + trayBounds.height / 2),
      });
    }
    if (
      typeof screen.getCursorScreenPoint === 'function' &&
      typeof screen.getDisplayNearestPoint === 'function'
    ) {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    }
    if (typeof screen.getPrimaryDisplay === 'function') {
      return screen.getPrimaryDisplay();
    }
  } catch {
    if (typeof screen.getPrimaryDisplay === 'function') {
      return screen.getPrimaryDisplay();
    }
  }
  return null;
}

/**
 * 安全加载本地 HTML 页面：保持真实 `loadFile` 调用，并在未创建 HTML 时通过 `did-fail-load` 与 `.catch` 降级到占位页，避免未捕获异常。
 * @param {object} win - BrowserWindow 实例
 * @param {string} htmlPath - 目标 HTML 路径
 * @param {object} loadOptions - `loadFile` 参数
 * @param {string} label - 窗口中文标识
 * @param {object} logger - 日志记录器
 */
function loadHtmlSafe(win, htmlPath, loadOptions, label, logger) {
  let fallbackLoaded = false;

  const loadFallback = () => {
    if (fallbackLoaded || !win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
      return;
    }
    fallbackLoaded = true;
    const safeTitle = label || '牛马加油器';
    const fallbackHtml =
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
      `<title>${safeTitle}</title></head>` +
      `<body style="font-family:system-ui,sans-serif;padding:16px;color:#333;">` +
      `<h3>${safeTitle}</h3><p>界面资源尚未就绪，主进程服务运行正常。</p></body></html>`;
    if (typeof win.loadURL === 'function') {
      Promise.resolve(
        win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fallbackHtml)}`)
      ).catch(() => {});
    }
  };

  if (win.webContents && typeof win.webContents.on === 'function') {
    win.webContents.on('did-fail-load', (_event, _errCode, errDesc, _url, isMainFrame) => {
      if (isMainFrame === false || fallbackLoaded) {
        return;
      }
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[windowManager] ${label}页面加载失败，已切换占位页:`, errDesc || htmlPath);
      }
      loadFallback();
    });
  }

  try {
    const result = win.loadFile(htmlPath, loadOptions);
    if (result && typeof result.catch === 'function') {
      result.catch((err) => {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`[windowManager] ${label}加载文件异常，已降级:`, err && err.message ? err.message : err);
        }
        loadFallback();
      });
    }
  } catch (err) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`[windowManager] ${label}调用 loadFile 异常，已降级:`, err && err.message ? err.message : err);
    }
    loadFallback();
  }
}

/**
 * 创建窗口管理器（管理 Popover 主面板与单实例设置窗口）。
 * @param {object} options - Electron API 与回调配置
 * @returns {object} 窗口管理器实例
 */
function createWindowManager(options = {}) {
  const {
    BrowserWindow,
    screen,
    nativeImage,
    preloadPath = path.join(__dirname, 'preload.js'),
    rendererDir = path.resolve(__dirname, '../renderer'),
    assetDir,
    getTrayBounds,
    onWindowReady,
    logger = console,
  } = options;

  let panelWindow = null;
  let settingsWindow = null;
  let miniBarWindow = null;
  let currentPanelWidth = PANEL_WIDTH;
  let currentPanelHeight = DEFAULT_PANEL_HEIGHT;
  let miniBarWidth = 128;
  let miniBarHeight = 34;
  let miniBarCustomPos = null;
  let lastTrayBounds = null;
  let lastBlurAt = 0;
  let programmaticHiding = false;
  let stickyUntilFocus = false;
  let pendingSettingsTab = 'salary';
  let cachedAppIcon;

  /**
   * 懒加载并缓存窗口图标 `icon.png`。
   * @returns {object | undefined} NativeImage 或 undefined
   */
  function resolveWindowIcon() {
    if (cachedAppIcon !== undefined) {
      return cachedAppIcon;
    }
    if (!nativeImage || typeof nativeImage.createFromPath !== 'function') {
      cachedAppIcon = undefined;
      return undefined;
    }
    try {
      const iconPath = resolveAssetPath('icon.png', assetDir);
      const img = nativeImage.createFromPath(iconPath);
      if (img && (typeof img.isEmpty !== 'function' || !img.isEmpty())) {
        cachedAppIcon = img;
        return img;
      }
    } catch {
      // 忽略图标加载异常
    }
    cachedAppIcon = undefined;
    return undefined;
  }

  /**
   * 安全获取托盘矩形边界。
   * @returns {object | null} 托盘边界矩形
   */
  function safeGetTrayBounds() {
    if (typeof getTrayBounds !== 'function') {
      return null;
    }
    try {
      return getTrayBounds();
    } catch {
      return null;
    }
  }

  /**
   * 计算并应用主面板在当前托盘位置下的坐标与尺寸。
   * @param {object} win - Popover 窗口
   * @param {object | null} trayBounds - 托盘矩形
   * @returns {{ x: number, y: number, width: number, height: number, edge: string }} 计算后的窗口边界
   */
  function positionPanel(win, trayBounds) {
    const refBounds = hasValidBounds(trayBounds)
      ? trayBounds
      : hasValidBounds(lastTrayBounds)
        ? lastTrayBounds
        : safeGetTrayBounds();
    const display = selectDisplay(screen, refBounds);
    const bounds = computePopoverPosition({
      trayBounds: refBounds,
      display,
      panelWidth: currentPanelWidth,
      panelHeight: currentPanelHeight,
      gap: EDGE_GAP,
    });
    if (win && (typeof win.isDestroyed !== 'function' || !win.isDestroyed())) {
      win.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
    }
    return bounds;
  }

  /**
   * 隐藏 Popover 主面板；可通过 `recordDebounce` 控制是否更新 `blur` 防重开时间戳。
   * @param {object} [opts={}] - 隐藏选项
   * @param {boolean} [opts.recordDebounce=false] - 是否记录防重开时间戳
   */
  function hidePanel({ recordDebounce = false } = {}) {
    if (!panelWindow || (typeof panelWindow.isDestroyed === 'function' && panelWindow.isDestroyed())) {
      return;
    }
    if (typeof panelWindow.isVisible === 'function' && panelWindow.isVisible()) {
      programmaticHiding = true;
      try {
        panelWindow.hide();
      } finally {
        programmaticHiding = false;
      }
    }
    if (recordDebounce) {
      lastBlurAt = Date.now();
    } else {
      lastBlurAt = 0;
    }
  }

  /**
   * 确保 Popover 主面板窗口已创建（默认 `show: false` 隐藏就绪）。
   * @returns {object} Popover BrowserWindow 实例
   */
  function ensurePanelWindow() {
    if (panelWindow && (typeof panelWindow.isDestroyed !== 'function' || !panelWindow.isDestroyed())) {
      return panelWindow;
    }

    const icon = resolveWindowIcon();
    const winOpts = {
      width: currentPanelWidth,
      height: currentPanelHeight,
      useContentSize: true,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    };
    if (icon) {
      winOpts.icon = icon;
    }

    panelWindow = new BrowserWindow(winOpts);

    if (typeof panelWindow.setAlwaysOnTop === 'function') {
      panelWindow.setAlwaysOnTop(true, 'pop-up-menu');
    }

    if (panelWindow.webContents && typeof panelWindow.webContents.on === 'function') {
      panelWindow.webContents.on('before-input-event', (event, input) => {
        if (input && input.type === 'keyDown' && input.key === 'Escape') {
          if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
          }
          hidePanel({ recordDebounce: false });
        }
      });

      panelWindow.webContents.on('did-finish-load', () => {
        if (typeof onWindowReady === 'function') {
          onWindowReady(panelWindow);
        }
      });
    }

    panelWindow.on('focus', () => {
      stickyUntilFocus = false;
    });

    panelWindow.on('blur', () => {
      if (programmaticHiding || stickyUntilFocus) {
        return;
      }
      if (
        panelWindow &&
        (typeof panelWindow.isDestroyed !== 'function' || !panelWindow.isDestroyed()) &&
        typeof panelWindow.isVisible === 'function' &&
        panelWindow.isVisible()
      ) {
        lastBlurAt = Date.now();
        panelWindow.hide();
      }
    });

    panelWindow.on('closed', () => {
      panelWindow = null;
    });

    const panelHtmlPath = path.join(rendererDir, 'panel.html');
    loadHtmlSafe(panelWindow, panelHtmlPath, {}, '主面板', logger);

    return panelWindow;
  }

  /**
   * 定位并显示主面板 Popover。
   * @param {object | null} [trayBounds] - 托盘矩形边界
   * @returns {object} 主面板 BrowserWindow 实例
   */
  function showPanel(trayBounds, opts = {}) {
    const win = ensurePanelWindow();
    lastBlurAt = 0;
    stickyUntilFocus = Boolean(opts && opts.stickyUntilFocus);
    if (hasValidBounds(trayBounds)) {
      lastTrayBounds = { ...trayBounds };
    }
    positionPanel(win, trayBounds);
    if (stickyUntilFocus && typeof win.showInactive === 'function') {
      // 启动时不抢焦点，直到用户点进面板后才启用失焦自动收起
      win.showInactive();
    } else {
      win.show();
    }
    if (!stickyUntilFocus && typeof win.focus === 'function') {
      win.focus();
    }
    return win;
  }

  /**
   * 切换主面板显示与隐藏（含 200ms `blur` 点击托盘防重开去抖）。
   * @param {object | null} [trayBounds] - 托盘矩形边界
   * @returns {boolean} 切换后面板是否处于显示状态
   */
  function togglePanel(trayBounds) {
    if (hasValidBounds(trayBounds)) {
      lastTrayBounds = { ...trayBounds };
    }

    if (
      panelWindow &&
      (typeof panelWindow.isDestroyed !== 'function' || !panelWindow.isDestroyed()) &&
      typeof panelWindow.isVisible === 'function' &&
      panelWindow.isVisible()
    ) {
      hidePanel({ recordDebounce: false });
      return false;
    }

    const elapsed = Date.now() - lastBlurAt;
    if (lastBlurAt > 0 && elapsed >= 0 && elapsed < BLUR_DEBOUNCE_MS) {
      return false;
    }

    showPanel(trayBounds);
    return true;
  }

  /**
   * 计算并应用桌面悬浮金额条窗口坐标（优先用户拖拽坐标，默认贴靠屏幕右下角任务栏上方）。
   * @param {object} win - 悬浮条 BrowserWindow
   * @returns {{ x: number, y: number, width: number, height: number }} 窗口边界
   */
  function positionMiniBar(win) {
    const refBounds = hasValidBounds(lastTrayBounds) ? lastTrayBounds : safeGetTrayBounds();
    const display = selectDisplay(screen, refBounds);
    const wa = (display && display.workArea) ||
      (display && display.bounds) || { x: 0, y: 0, width: 1920, height: 1080 };

    const w = clamp(Math.round(miniBarWidth), 44, Math.max(80, wa.width - 16));
    const h = clamp(Math.round(miniBarHeight), 28, Math.max(32, wa.height - 16));

    let x;
    let y;
    if (miniBarCustomPos && Number.isFinite(miniBarCustomPos.x) && Number.isFinite(miniBarCustomPos.y)) {
      x = clamp(Math.round(miniBarCustomPos.x), wa.x + 4, wa.x + wa.width - w - 4);
      y = clamp(Math.round(miniBarCustomPos.y), wa.y + 4, wa.y + wa.height - h - 4);
    } else if (hasValidBounds(refBounds)) {
      const trayCenterX = refBounds.x + refBounds.width / 2;
      x = clamp(Math.round(trayCenterX - w / 2), wa.x + 8, wa.x + wa.width - w - 8);
      y = clamp(Math.round(wa.y + wa.height - h - 6), wa.y + 8, wa.y + wa.height - h - 6);
    } else {
      x = clamp(Math.round(wa.x + wa.width - w - 16), wa.x + 8, wa.x + wa.width - w - 8);
      y = clamp(Math.round(wa.y + wa.height - h - 6), wa.y + 8, wa.y + wa.height - h - 6);
    }

    const bounds = { x, y, width: w, height: h };
    if (win && (typeof win.isDestroyed !== 'function' || !win.isDestroyed())) {
      win.setBounds(bounds);
    }
    return bounds;
  }

  /**
   * 确保桌面悬浮金额条窗口已创建。
   * @returns {object} 悬浮条 BrowserWindow
   */
  function ensureMiniBarWindow() {
    if (miniBarWindow && (typeof miniBarWindow.isDestroyed !== 'function' || !miniBarWindow.isDestroyed())) {
      return miniBarWindow;
    }

    const icon = resolveWindowIcon();
    const winOpts = {
      width: miniBarWidth,
      height: miniBarHeight,
      useContentSize: true,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    };
    if (icon) {
      winOpts.icon = icon;
    }

    miniBarWindow = new BrowserWindow(winOpts);

    if (typeof miniBarWindow.setAlwaysOnTop === 'function') {
      miniBarWindow.setAlwaysOnTop(true, 'floating');
    }

    if (miniBarWindow.webContents && typeof miniBarWindow.webContents.on === 'function') {
      miniBarWindow.webContents.on('did-finish-load', () => {
        if (typeof onWindowReady === 'function') {
          onWindowReady(miniBarWindow);
        }
      });
    }

    miniBarWindow.on('closed', () => {
      miniBarWindow = null;
    });

    const miniBarHtmlPath = path.join(rendererDir, 'minibar.html');
    loadHtmlSafe(miniBarWindow, miniBarHtmlPath, {}, '悬浮金额条', logger);
    positionMiniBar(miniBarWindow);

    return miniBarWindow;
  }

  /**
   * 根据状态栏文案、计薪阶段与设置同步悬浮金额条的显隐与位置。
   * 当显示格式为 `iconOnly`，或处于非上班时段（`rest` / `beforeWork` / `afterWork`）且设置了 `offHoursDisplay === 'iconOnly'` 时，自动隐藏桌面悬浮条（仅保留托盘图标）。
   * @param {object} statusLine - StatusText.make 生成的对象
   * @param {object} settings - 当前设置
   * @param {object} [snapshot] - 当前计薪快照
   */
  function syncMiniBar(statusLine, settings, snapshot) {
    const phase = snapshot && snapshot.phase ? snapshot.phase : null;
    const isOffHours = phase === 'rest' || phase === 'beforeWork' || phase === 'afterWork';
    const shouldHide =
      !settings ||
      settings.menuBarFormat === 'iconOnly' ||
      Boolean(statusLine && statusLine.forceIcon) ||
      (isOffHours && settings.offHoursDisplay === 'iconOnly');

    if (shouldHide) {
      if (
        miniBarWindow &&
        (typeof miniBarWindow.isDestroyed !== 'function' || !miniBarWindow.isDestroyed()) &&
        typeof miniBarWindow.isVisible === 'function' &&
        miniBarWindow.isVisible()
      ) {
        miniBarWindow.hide();
      }
      return;
    }

    const win = ensureMiniBarWindow();
    positionMiniBar(win);
    if (typeof win.isVisible === 'function' && !win.isVisible()) {
      if (typeof win.showInactive === 'function') {
        win.showInactive();
      } else {
        win.show();
      }
    }
  }

  /**
   * 响应面板自适应高度请求（同时兼容悬浮金额条的尺寸、拖拽位移与点击切换主面板请求）。
   * @param {number | { target?: string, action?: string, width?: number, height?: number, dx?: number, dy?: number }} widthOrSize - 宽度或指令对象
   * @param {number} [maybeHeight] - 高度
   * @returns {{ x: number, y: number, width: number, height: number, edge?: string }} 更新后的边界
   */
  function resizePanel(widthOrSize, maybeHeight) {
    if (widthOrSize && typeof widthOrSize === 'object' && widthOrSize.target === 'minibar') {
      const win = ensureMiniBarWindow();
      const action = widthOrSize.action || 'resize';
      if (action === 'resize') {
        if (Number.isFinite(widthOrSize.width) && widthOrSize.width > 0) {
          miniBarWidth = clamp(Math.round(widthOrSize.width), 44, 420);
        }
        if (Number.isFinite(widthOrSize.height) && widthOrSize.height > 0) {
          miniBarHeight = clamp(Math.round(widthOrSize.height), 28, 64);
        }
        return positionMiniBar(win);
      }
      if (action === 'moveBy') {
        const cur = typeof win.getBounds === 'function' ? win.getBounds() : positionMiniBar(win);
        const dx = Number.isFinite(widthOrSize.dx) ? Math.round(widthOrSize.dx) : 0;
        const dy = Number.isFinite(widthOrSize.dy) ? Math.round(widthOrSize.dy) : 0;
        miniBarCustomPos = { x: cur.x + dx, y: cur.y + dy };
        return positionMiniBar(win);
      }
      if (action === 'togglePanel') {
        const mbBounds = typeof win.getBounds === 'function' ? win.getBounds() : null;
        togglePanel(mbBounds);
        return mbBounds || { x: 0, y: 0, width: miniBarWidth, height: miniBarHeight };
      }
      return positionMiniBar(win);
    }

    let rawW = widthOrSize;
    let rawH = maybeHeight;
    if (widthOrSize && typeof widthOrSize === 'object') {
      rawW = widthOrSize.width;
      rawH = widthOrSize.height;
    }

    if (Number.isFinite(rawW) && rawW > 0) {
      currentPanelWidth = clamp(Math.round(rawW), MIN_PANEL_WIDTH, MAX_PANEL_WIDTH);
    }
    if (Number.isFinite(rawH) && rawH > 0) {
      currentPanelHeight = Math.max(MIN_PANEL_HEIGHT, Math.round(rawH));
    }

    const win = ensurePanelWindow();
    return positionPanel(win, lastTrayBounds || safeGetTrayBounds());
  }

  /**
   * 打开或前置单实例 4 标签设置窗口，并支持切换到指定页签。
   * @param {string | number} [tab='salary'] - 目标页签
   * @returns {{ window: object, tab: string }} 设置窗口与规范化页签
   */
  function openSettings(tab = 'salary') {
    const targetTab = normalizeSettingsTab(tab);
    pendingSettingsTab = targetTab;

    // 打开设置窗口前先隐藏主面板
    hidePanel({ recordDebounce: false });

    if (
      settingsWindow &&
      (typeof settingsWindow.isDestroyed !== 'function' || !settingsWindow.isDestroyed())
    ) {
      if (typeof settingsWindow.isMinimized === 'function' && settingsWindow.isMinimized()) {
        settingsWindow.restore();
      }
      settingsWindow.show();
      if (typeof settingsWindow.focus === 'function') {
        settingsWindow.focus();
      }
      if (settingsWindow.webContents && typeof settingsWindow.webContents.send === 'function') {
        settingsWindow.webContents.send('settings:selectTab', targetTab);
      }
      return { window: settingsWindow, tab: targetTab };
    }

    const icon = resolveWindowIcon();
    const winOpts = {
      width: SETTINGS_WIDTH,
      height: SETTINGS_HEIGHT,
      minWidth: 640,
      minHeight: 560,
      resizable: true,
      autoHideMenuBar: true,
      title: '牛马加油器 — 设置',
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    };
    if (icon) {
      winOpts.icon = icon;
    }

    settingsWindow = new BrowserWindow(winOpts);

    if (typeof settingsWindow.setMenuBarVisibility === 'function') {
      settingsWindow.setMenuBarVisibility(false);
    }

    if (settingsWindow.webContents && typeof settingsWindow.webContents.on === 'function') {
      settingsWindow.webContents.on('did-finish-load', () => {
        if (
          settingsWindow &&
          (typeof settingsWindow.isDestroyed !== 'function' || !settingsWindow.isDestroyed()) &&
          settingsWindow.webContents
        ) {
          if (typeof settingsWindow.webContents.send === 'function') {
            settingsWindow.webContents.send('settings:selectTab', pendingSettingsTab);
          }
          if (typeof onWindowReady === 'function') {
            onWindowReady(settingsWindow);
          }
        }
      });
    }

    settingsWindow.on('closed', () => {
      settingsWindow = null;
    });

    const settingsHtmlPath = path.join(rendererDir, 'settings.html');
    loadHtmlSafe(
      settingsWindow,
      settingsHtmlPath,
      { query: { tab: targetTab } },
      '设置窗口',
      logger
    );

    settingsWindow.show();
    if (typeof settingsWindow.focus === 'function') {
      settingsWindow.focus();
    }

    return { window: settingsWindow, tab: targetTab };
  }

  /**
   * 获取全部存活的渲染窗口列表。
   * @returns {Array<object>} 未销毁的 BrowserWindow 数组
   */
  function getWindows() {
    const list = [];
    if (panelWindow && (typeof panelWindow.isDestroyed !== 'function' || !panelWindow.isDestroyed())) {
      list.push(panelWindow);
    }
    if (
      settingsWindow &&
      (typeof settingsWindow.isDestroyed !== 'function' || !settingsWindow.isDestroyed())
    ) {
      list.push(settingsWindow);
    }
    if (
      miniBarWindow &&
      (typeof miniBarWindow.isDestroyed !== 'function' || !miniBarWindow.isDestroyed())
    ) {
      list.push(miniBarWindow);
    }
    return list;
  }

  /**
   * 销毁全部由窗口管理器持有的窗口实例。
   */
  function destroyAll() {
    for (const win of [panelWindow, settingsWindow, miniBarWindow]) {
      if (win && (typeof win.isDestroyed !== 'function' || !win.isDestroyed())) {
        try {
          win.destroy();
        } catch {
          // 忽略销毁阶段异常
        }
      }
    }
    panelWindow = null;
    settingsWindow = null;
    miniBarWindow = null;
  }

  return {
    ensurePanelWindow,
    ensureMiniBarWindow,
    syncMiniBar,
    showPanel,
    hidePanel,
    togglePanel,
    resizePanel,
    openSettings,
    getPanelWindow: () =>
      panelWindow && (typeof panelWindow.isDestroyed !== 'function' || !panelWindow.isDestroyed())
        ? panelWindow
        : null,
    getSettingsWindow: () =>
      settingsWindow &&
      (typeof settingsWindow.isDestroyed !== 'function' || !settingsWindow.isDestroyed())
        ? settingsWindow
        : null,
    getWindows,
    destroyAll,
  };
}

module.exports = {
  PANEL_WIDTH,
  DEFAULT_PANEL_HEIGHT,
  EDGE_GAP,
  BLUR_DEBOUNCE_MS,
  SETTINGS_WIDTH,
  SETTINGS_HEIGHT,
  clamp,
  normalizeSettingsTab,
  hasValidBounds,
  computePopoverPosition,
  createWindowManager,
};
