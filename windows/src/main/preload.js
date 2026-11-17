'use strict';

/**
 * Electron Preload 安全桥接脚本。
 * 严格遵循 `contextIsolation: true` 契约，仅向渲染进程暴露 `window.niumaAPI` 规定的 13 个方法，不泄漏任何原生 Node/Electron 对象。
 */

const { contextBridge, ipcRenderer } = require('electron');

const niumaAPI = Object.freeze({
  /**
   * 订阅主进程推送的 `state:update` 状态广播（自动剥离底层 event 对象）。
   * @param {(payload: object) => void} callback - 状态更新回调
   * @returns {() => void} 幂等取消订阅函数
   */
  onStateUpdate(callback) {
    if (typeof callback !== 'function') {
      return () => {};
    }
    let active = true;
    const listener = (_event, payload) => {
      callback(payload);
    };
    ipcRenderer.on('state:update', listener);
    return () => {
      if (!active) {
        return;
      }
      active = false;
      if (typeof ipcRenderer.removeListener === 'function') {
        ipcRenderer.removeListener('state:update', listener);
      } else if (typeof ipcRenderer.off === 'function') {
        ipcRenderer.off('state:update', listener);
      }
    };
  },

  /** 获取当前完整应用状态载荷 */
  getState() {
    return ipcRenderer.invoke('state:get');
  },

  /** 提交局部或完整设置更新 */
  updateSettings(patchOrSettings) {
    return ipcRenderer.invoke('settings:update', patchOrSettings);
  },

  /** 切换老板模式（仅内存态） */
  toggleBoss() {
    return ipcRenderer.invoke('boss:toggle');
  },

  /** 显式设置老板模式开关 */
  setBoss(enabled) {
    return ipcRenderer.invoke('boss:set', Boolean(enabled));
  },

  /** 切换大小周开关（自动处理本周一大周锚点） */
  setBigSmallWeek(enabled) {
    return ipcRenderer.invoke('bigSmallWeek:toggle', Boolean(enabled));
  },

  /** 打开文件对话框导入并合并节假日 JSON */
  importHolidaysDialog() {
    return ipcRenderer.invoke('holidays:importDialog');
  },

  /** 清空已导入的节假日列表 */
  clearImportedHolidays() {
    return ipcRenderer.invoke('holidays:clearImported');
  },

  /** 设置开机自动启动开关 */
  setLoginItem(enabled) {
    return ipcRenderer.invoke('loginItem:set', Boolean(enabled));
  },

  /** 通知主进程按最新内容尺寸重定位 Popover 面板 */
  resizePanel(width, height) {
    return ipcRenderer.invoke('panel:resize', width, height);
  },

  /** 打开或聚焦单实例设置窗口并定位到指定页签 */
  openSettings(tab) {
    return ipcRenderer.invoke('window:openSettings', tab);
  },

  /** 隐藏主面板 Popover */
  hidePanel() {
    return ipcRenderer.invoke('window:hidePanel');
  },

  /** 退出牛马加油器 */
  quitApp() {
    return ipcRenderer.invoke('app:quit');
  },
});

contextBridge.exposeInMainWorld('niumaAPI', niumaAPI);
