'use strict';

/**
 * WebView2 渲染桥接与主控状态机脚本。
 * 在所有 WebView2 窗口中暴露与 Electron preload.js 100% 兼容的 window.niumaAPI（13 个方法），
 * 并在 minibar 主控窗口中运行 NiumaCore 1s 计薪循环、里程碑/下班通知检测与多窗口状态同步。
 */

(function initWebView2Bridge() {
  const listeners = new Set();
  const pendingCalls = new Map();
  let callSeq = 1;
  let cachedState = window.__NIUMA_INITIAL_STATE__ || null;

  function postToHost(msg) {
    if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') {
      window.chrome.webview.postMessage(JSON.stringify(msg));
    }
  }

  function invokeHost(channel, payload) {
    return new Promise((resolve) => {
      const id = callSeq++;
      pendingCalls.set(id, resolve);
      postToHost({ type: 'ipc:invoke', id, channel, payload });
    });
  }

  function dispatchStateUpdate(state) {
    cachedState = state;
    for (const fn of Array.from(listeners)) {
      try {
        fn(state);
      } catch (err) {
        console.error('[niumaAPI] onStateUpdate 回调异常:', err);
      }
    }
  }

  window.addEventListener('niuma:local-state', (ev) => {
    if (ev && ev.detail) {
      dispatchStateUpdate(ev.detail);
    }
  });

  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener('message', (ev) => {
      let data = ev.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (!data || typeof data !== 'object') return;

      if (data.type === 'ipc:reply' && pendingCalls.has(data.id)) {
        const resolve = pendingCalls.get(data.id);
        pendingCalls.delete(data.id);
        resolve(data.result);
        return;
      }

      if (data.type === 'state:update' && data.state) {
        dispatchStateUpdate(data.state);
        return;
      }

      if (data.type === 'controller:command' && typeof window.__handleControllerCommand === 'function') {
        window.__handleControllerCommand(data);
      }
    });
  }

  const niumaAPI = Object.freeze({
    onStateUpdate(callback) {
      if (typeof callback !== 'function') return () => {};
      listeners.add(callback);
      if (cachedState) {
        Promise.resolve().then(() => {
          if (listeners.has(callback) && cachedState) callback(cachedState);
        });
      }
      return () => {
        listeners.delete(callback);
      };
    },
    getState() {
      if (typeof window.__getLocalControllerState === 'function') {
        return Promise.resolve(window.__getLocalControllerState());
      }
      return invokeHost('state:get');
    },
    updateSettings(patchOrSettings) {
      return invokeHost('settings:update', patchOrSettings);
    },
    toggleBoss() {
      return invokeHost('boss:toggle');
    },
    setBoss(enabled) {
      return invokeHost('boss:set', Boolean(enabled));
    },
    setBigSmallWeek(enabled) {
      return invokeHost('bigSmallWeek:toggle', Boolean(enabled));
    },
    importHolidaysDialog() {
      return invokeHost('holidays:importDialog');
    },
    clearImportedHolidays() {
      return invokeHost('holidays:clearImported');
    },
    setLoginItem(enabled) {
      return invokeHost('loginItem:set', Boolean(enabled));
    },
    resizePanel(width, height) {
      return invokeHost('panel:resize', { width, height });
    },
    openSettings(tab) {
      return invokeHost('window:openSettings', tab);
    },
    hidePanel() {
      return invokeHost('window:hidePanel');
    },
    quitApp() {
      return invokeHost('app:quit');
    },
  });

  Object.defineProperty(window, 'niumaAPI', {
    value: niumaAPI,
    writable: false,
    configurable: false,
    enumerable: true,
  });
})();
