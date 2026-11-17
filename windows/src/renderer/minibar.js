'use strict';

/**
 * 牛马加油器 Windows 桌面悬浮金额条渲染脚本。
 * 实时展示状态栏金额/进度/倒计时，支持按住拖拽移动位置、左键单击弹出/收起主面板、右键打开设置。
 */

(function initMiniBar() {
  const api = window.niumaAPI;

  const els = {
    root: document.getElementById('minibar-root'),
    icon: document.getElementById('minibar-icon'),
    badge: document.getElementById('minibar-badge'),
    prefix: document.getElementById('minibar-prefix'),
    main: document.getElementById('minibar-main'),
    check: document.getElementById('minibar-check'),
  };

  let lastReportedWidth = 0;
  let lastReportedHeight = 0;

  function setVisible(el, visible) {
    if (!el) return;
    if (visible) {
      el.hidden = false;
      el.removeAttribute('hidden');
      el.style.display = '';
      el.classList.remove('hidden');
    } else {
      el.hidden = true;
      el.style.display = 'none';
      el.classList.add('hidden');
    }
  }

  function syncSize() {
    if (!els.root || !api || typeof api.resizePanel !== 'function') return;
    // 先临时设为 inline-flex 测量真实内容宽高
    els.root.style.width = 'max-content';
    const rect = els.root.getBoundingClientRect();
    const w = Math.max(56, Math.ceil((rect && rect.width) || els.root.scrollWidth || 110) + 4);
    const h = Math.max(32, Math.ceil((rect && rect.height) || els.root.offsetHeight || 32));
    els.root.style.width = '100%';
    if (Math.abs(w - lastReportedWidth) >= 2 || Math.abs(h - lastReportedHeight) >= 2) {
      lastReportedWidth = w;
      lastReportedHeight = h;
      api.resizePanel({
        target: 'minibar',
        action: 'resize',
        width: w,
        height: h,
      });
    }
  }

  function render(state) {
    if (!state || typeof state !== 'object') return;
    const settings = state.settings || {};
    const line = state.statusLine || {};

    const mainText = typeof line.main === 'string' ? line.main : '';
    const showIcon = Boolean(settings.showIcon || line.forceIcon || !mainText);

    setVisible(els.icon, showIcon);
    setVisible(els.badge, Boolean(line.badge));
    if (line.badge && els.badge) {
      els.badge.textContent = line.badge;
    }

    setVisible(els.prefix, Boolean(line.prefix));
    if (line.prefix && els.prefix) {
      els.prefix.textContent = line.prefix;
    }

    setVisible(els.main, Boolean(mainText));
    if (mainText && els.main) {
      els.main.textContent = mainText;
    }

    setVisible(els.check, Boolean(line.check));

    syncSize();
  }

  // 鼠标按住拖拽移动 vs 左键单击切换主面板
  let dragging = false;
  let moved = false;
  let lastScreenX = 0;
  let lastScreenY = 0;

  if (els.root) {
    els.root.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      moved = false;
      lastScreenX = ev.screenX;
      lastScreenY = ev.screenY;
    });

    window.addEventListener('mousemove', (ev) => {
      if (!dragging) return;
      const dx = Math.round(ev.screenX - lastScreenX);
      const dy = Math.round(ev.screenY - lastScreenY);
      if (!moved && Math.hypot(dx, dy) < 4) {
        return;
      }
      moved = true;
      lastScreenX = ev.screenX;
      lastScreenY = ev.screenY;
      if ((dx !== 0 || dy !== 0) && api && typeof api.resizePanel === 'function') {
        api.resizePanel({
          target: 'minibar',
          action: 'moveBy',
          dx,
          dy,
        });
      }
    });

    window.addEventListener('mouseup', (ev) => {
      if (!dragging || ev.button !== 0) return;
      dragging = false;
      if (!moved && api && typeof api.resizePanel === 'function') {
        api.resizePanel({
          target: 'minibar',
          action: 'togglePanel',
        });
      }
    });

    els.root.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (api && typeof api.openSettings === 'function') {
        api.openSettings('display');
      }
    });
  }

  if (api) {
    if (typeof api.onStateUpdate === 'function') {
      api.onStateUpdate((nextState) => {
        render(nextState);
      });
    }
    if (typeof api.getState === 'function') {
      api.getState().then((initialState) => {
        if (initialState) render(initialState);
      });
    }
  }
})();
