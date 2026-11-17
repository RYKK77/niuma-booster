'use strict';

/**
 * 全局老板键注册与冲突状态管理模块。
 * 基于 `core.BossHotkeyMeta` 执行“先注销旧键再注册新键”，并精准输出注册态与中文冲突提示。
 */

const { BossHotkey, BossHotkeyMeta } = require('../core');

/**
 * 创建全局老板键管理器。
 * @param {object} [options={}] - 配置与依赖注入项
 * @param {object} [options.globalShortcut] - Electron `globalShortcut` 接口
 * @param {Function} [options.onToggle] - 热键触发回调
 * @param {object} [options.logger=console] - 日志记录器
 * @returns {object} 老板键管理器实例
 */
function createHotkeyManager(options = {}) {
  const globalShortcut = options.globalShortcut || null;
  const onToggle = typeof options.onToggle === 'function' ? options.onToggle : null;
  const logger = options.logger || console;

  let currentPreset = BossHotkey.off;
  let currentAccelerator = null;
  let hotkeyRegistered = false;
  let hotkeyWarning = null;

  /**
   * 注销当前已注册的全局快捷键。
   */
  function unregister() {
    if (currentAccelerator && globalShortcut && typeof globalShortcut.unregister === 'function') {
      try {
        globalShortcut.unregister(currentAccelerator);
      } catch {
        // 忽略应用退出或 mock 态下的注销异常
      }
    }
    currentAccelerator = null;
    hotkeyRegistered = false;
  }

  /**
   * 获取当前老板键注册状态与展示元数据。
   * @returns {{ hotkeyPreset: string, hotkeyLabel: string, hotkeyRegistered: boolean, hotkeyWarning: string | null }} 状态对象
   */
  function getStatus() {
    const meta = BossHotkeyMeta[currentPreset] || BossHotkeyMeta[BossHotkey.off];
    return {
      hotkeyPreset: currentPreset,
      hotkeyLabel: meta.label,
      hotkeyRegistered,
      hotkeyWarning,
    };
  }

  /**
   * 应用新的老板键预设：先注销旧键，再按预设停用或重新注册。
   * @param {string} bossHotkey - `BossHotkey` 枚举值（`ctrlOptB` | `ctrlOptCmdH` | `off`）
   * @returns {{ hotkeyPreset: string, hotkeyLabel: string, hotkeyRegistered: boolean, hotkeyWarning: string | null }} 最新状态
   */
  function apply(bossHotkey) {
    const meta = BossHotkeyMeta[bossHotkey] || BossHotkeyMeta[BossHotkey.off];

    // 先注销已持有的旧热键，避免旧键残留
    unregister();

    if (!meta.accelerator) {
      currentPreset = BossHotkey.off;
      hotkeyRegistered = false;
      hotkeyWarning = null;
      return getStatus();
    }

    let ok = false;
    if (globalShortcut && typeof globalShortcut.register === 'function') {
      try {
        ok = Boolean(
          globalShortcut.register(meta.accelerator, () => {
            if (onToggle) {
              onToggle();
            }
          })
        );
      } catch (err) {
        ok = false;
        if (logger && typeof logger.warn === 'function') {
          logger.warn('[hotkeyManager] 注册全局快捷键异常:', meta.accelerator, err);
        }
      }
    }

    currentPreset = meta.value;
    if (ok) {
      currentAccelerator = meta.accelerator;
      hotkeyRegistered = true;
      hotkeyWarning = null;
    } else {
      currentAccelerator = null;
      hotkeyRegistered = false;
      hotkeyWarning = `快捷键 ${meta.label} 已被其他程序占用，老板键暂未生效`;
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[hotkeyManager] ${hotkeyWarning}`);
      }
    }

    return getStatus();
  }

  /**
   * 释放管理器持有的所有全局快捷键资源。
   */
  function dispose() {
    unregister();
    hotkeyWarning = null;
  }

  return {
    apply,
    unregister,
    unregisterAll: dispose,
    getStatus,
    dispose,
  };
}

module.exports = {
  createHotkeyManager,
};
