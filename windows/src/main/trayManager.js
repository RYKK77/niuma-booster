'use strict';

/**
 * 系统托盘图标、动态 Tooltip 与原生右键上下文菜单管理模块。
 * 复用 `core.StatusText.make` 与 `core.BossHotkeyMeta`，兼容 `tray@2x.png` 与 Windows 127 字符限制。
 */

const { MenuBarFormat, BossHotkey, BossHotkeyMeta, StatusText } = require('../core');
const { resolveAssetPath } = require('./cheerleader');

const IDLE_TOOLTIP = '牛马加油器（点击打开面板）';
const MAX_TOOLTIP_LENGTH = 127;

/**
 * 按 UTF-16 码元安全截断托盘 Tooltip 文本，避免超过 Windows 127 字符限制或撕裂代理对。
 * @param {string} text - 原始文本
 * @param {number} [maxLen=127] - 最大允许长度
 * @returns {string} 截断后的安全文本
 */
function truncateTooltip(text, maxLen = MAX_TOOLTIP_LENGTH) {
  if (typeof text !== 'string') {
    return '';
  }
  if (text.length <= maxLen) {
    return text;
  }
  let end = Math.max(0, maxLen - 1);
  if (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      end -= 1;
    }
  }
  return `${text.slice(0, end)}…`;
}

/**
 * 构建当前状态的系统托盘 Tooltip 文案。
 * @param {object} snapshot - 当前计薪快照对象
 * @param {object} settings - 当前 AppSettings 对象
 * @param {boolean} boss - 是否处于老板模式
 * @returns {string} 长度不超过 127 字符的 Tooltip 文案
 */
function buildTrayTooltip(snapshot, settings, boss) {
  if (!snapshot || !settings || settings.menuBarFormat === MenuBarFormat.iconOnly) {
    return IDLE_TOOLTIP;
  }
  const line = StatusText.make(snapshot, settings, Boolean(boss));
  const plain = typeof line.plainText === 'string' ? line.plainText.trim() : '';
  if (plain.length === 0) {
    return IDLE_TOOLTIP;
  }
  return truncateTooltip(`牛马加油器 · ${plain}`, MAX_TOOLTIP_LENGTH);
}

/**
 * 构建 5 项托盘右键原生菜单模板。
 * @param {object} params - 菜单构建参数
 * @param {boolean} params.boss - 当前是否处于老板模式
 * @param {string} params.bossHotkey - 当前老板键预设枚举
 * @param {Function} [params.onToggleBoss] - 切换老板模式回调
 * @param {Function} [params.onOpenPanel] - 打开主面板回调
 * @param {Function} [params.onOpenSettings] - 打开设置窗口回调
 * @param {Function} [params.onQuit] - 退出应用回调
 * @returns {Array<object>} Electron Menu 模板数组
 */
function buildTrayMenuTemplate({
  boss,
  bossHotkey,
  onToggleBoss,
  onOpenPanel,
  onOpenSettings,
  onQuit,
}) {
  const meta = BossHotkeyMeta[bossHotkey] || BossHotkeyMeta[BossHotkey.off];
  const bossLabel = meta.accelerator ? `老板模式（${meta.label}）` : '老板模式';

  return [
    {
      id: 'boss-mode',
      label: bossLabel,
      type: 'checkbox',
      checked: Boolean(boss),
      click: () => {
        if (typeof onToggleBoss === 'function') {
          onToggleBoss();
        }
      },
    },
    {
      id: 'open-panel',
      label: '打开主面板',
      click: () => {
        if (typeof onOpenPanel === 'function') {
          onOpenPanel();
        }
      },
    },
    {
      id: 'open-settings',
      label: '设置…',
      click: () => {
        if (typeof onOpenSettings === 'function') {
          onOpenSettings();
        }
      },
    },
    {
      type: 'separator',
    },
    {
      id: 'quit',
      label: '退出牛马加油器',
      click: () => {
        if (typeof onQuit === 'function') {
          onQuit();
        }
      },
    },
  ];
}

/**
 * 加载托盘图标（优先 `tray.png` 以自动匹配 `tray@2x.png`，空图时回落 `icon.png`）。
 * @param {object} nativeImage - Electron `nativeImage` 模块
 * @param {string} [assetDir] - 可选资产目录
 * @returns {object} NativeImage 实例
 */
function loadTrayImage(nativeImage, assetDir) {
  const trayPath = resolveAssetPath('tray.png', assetDir);
  let image = nativeImage.createFromPath(trayPath);
  if (image && typeof image.isEmpty === 'function' && image.isEmpty()) {
    const fallbackPath = resolveAssetPath('icon.png', assetDir);
    const fallbackImg = nativeImage.createFromPath(fallbackPath);
    if (fallbackImg && (typeof fallbackImg.isEmpty !== 'function' || !fallbackImg.isEmpty())) {
      image = fallbackImg;
    }
  }
  return image;
}

/**
 * 创建系统托盘管理器。
 * @param {object} options - Electron API 与回调配置
 * @returns {object} 托盘管理器实例
 */
function createTrayManager(options = {}) {
  const {
    Tray,
    Menu,
    nativeImage,
    assetDir,
    onTogglePanel,
    onToggleBoss,
    onOpenPanel,
    onOpenSettings,
    onQuit,
    logger = console,
  } = options;

  const image = loadTrayImage(nativeImage, assetDir);
  let tray = new Tray(image);
  if (logger && typeof logger.log === 'function' && image && typeof image.isEmpty === 'function') {
    const size = typeof image.getSize === 'function' ? image.getSize() : null;
    logger.log('[Niuma] 托盘图标已创建:', JSON.stringify({ empty: image.isEmpty(), size }));
  }
  let lastTooltip = null;
  let lastMenuKey = null;

  /**
   * 安全获取托盘图标屏幕边界矩形。
   * @returns {object | null} 矩形对象或 null
   */
  function getBounds() {
    if (!tray || (typeof tray.isDestroyed === 'function' && tray.isDestroyed())) {
      return null;
    }
    try {
      return typeof tray.getBounds === 'function' ? tray.getBounds() : null;
    } catch {
      return null;
    }
  }

  tray.on('click', (_event, bounds) => {
    if (typeof onTogglePanel === 'function') {
      onTogglePanel(bounds || getBounds());
    }
  });

  /**
   * 根据最新状态更新托盘 Tooltip 与右键上下文菜单（带变更去重）。
   * @param {object} snapshot - 计薪快照
   * @param {object} settings - 当前设置
   * @param {boolean} boss - 是否处于老板模式
   */
  function update(snapshot, settings, boss) {
    if (!tray || (typeof tray.isDestroyed === 'function' && tray.isDestroyed())) {
      return;
    }

    const nextTooltip = buildTrayTooltip(snapshot, settings, boss);
    if (nextTooltip !== lastTooltip) {
      lastTooltip = nextTooltip;
      try {
        tray.setToolTip(nextTooltip);
      } catch (err) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('[trayManager] 更新托盘 Tooltip 失败:', err);
        }
      }
    }

    const hotkey = settings && settings.bossHotkey ? settings.bossHotkey : BossHotkey.off;
    const menuKey = `${Boolean(boss)}:${hotkey}`;
    if (menuKey !== lastMenuKey) {
      lastMenuKey = menuKey;
      try {
        const template = buildTrayMenuTemplate({
          boss,
          bossHotkey: hotkey,
          onToggleBoss,
          onOpenPanel,
          onOpenSettings,
          onQuit,
        });
        const menu = Menu.buildFromTemplate(template);
        tray.setContextMenu(menu);
      } catch (err) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('[trayManager] 更新托盘右键菜单失败:', err);
        }
      }
    }
  }

  /**
   * 销毁托盘实例并释放系统资源。
   */
  function destroy() {
    if (tray && (typeof tray.isDestroyed !== 'function' || !tray.isDestroyed())) {
      try {
        tray.destroy();
      } catch {
        // 忽略销毁阶段异常
      }
    }
    tray = null;
  }

  return {
    getTray: () => tray,
    getBounds,
    update,
    destroy,
  };
}

module.exports = {
  IDLE_TOOLTIP,
  MAX_TOOLTIP_LENGTH,
  truncateTooltip,
  buildTrayTooltip,
  buildTrayMenuTemplate,
  createTrayManager,
};
