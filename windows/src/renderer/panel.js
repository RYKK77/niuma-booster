'use strict';

/**
 * 牛马加油器 Windows 主面板渲染脚本。
 * 复刻 macOS PanelView.swift 布局与状态绑定，严格通过 window.niumaAPI 与主进程通信。
 */

(function initPanel() {
  const api = window.niumaAPI;

  const els = {
    root: document.getElementById('panel-root'),
    headerTitle: document.getElementById('header-title'),
    dayLine: document.getElementById('day-line'),
    earnedAmount: document.getElementById('earned-amount'),
    phaseSubline: document.getElementById('phase-subline'),
    progressSection: document.getElementById('progress-section'),
    shiftBar: document.getElementById('shift-bar'),
    workStartLabel: document.getElementById('work-start-label'),
    lunchRangeLabel: document.getElementById('lunch-range-label'),
    workEndLabel: document.getElementById('work-end-label'),
    progressText: document.getElementById('progress-text'),
    countdownWrapper: document.getElementById('countdown-wrapper'),
    dailyWageLabel: document.getElementById('daily-wage-label'),
    dailyWageValue: document.getElementById('daily-wage-value'),
    hourlyWageValue: document.getElementById('hourly-wage-value'),
    monthTotalValue: document.getElementById('month-total-value'),
    paidDaysValue: document.getElementById('paid-days-value'),
    milestoneSection: document.getElementById('milestone-section'),
    milestoneTitle: document.getElementById('milestone-title'),
    milestoneDetail: document.getElementById('milestone-detail'),
    quoteSection: document.getElementById('quote-section'),
    btnBoss: document.getElementById('btn-boss'),
    bossRowTitle: document.getElementById('boss-row-title'),
    bossCheck: document.getElementById('boss-check'),
    bossShortcut: document.getElementById('boss-shortcut'),
    btnSettings: document.getElementById('btn-settings'),
    btnQuit: document.getElementById('btn-quit'),
  };

  /**
   * 同步设置元素的显隐状态（同时设置 hidden 属性与 style.display，确保黑盒 DOM 检查与真实渲染一致）。
   * @param {HTMLElement | null} el - 目标元素
   * @param {boolean} visible - 是否可见
   */
  function setVisible(el, visible) {
    if (!el) return;
    if (visible) {
      el.hidden = false;
      el.removeAttribute('hidden');
      el.style.display = '';
      el.classList.remove('hidden', 'is-hidden');
    } else {
      el.hidden = true;
      el.style.display = 'none';
      el.classList.add('hidden');
    }
  }

  /**
   * 构建三段式（或单段）ShiftBar 进度条 DOM。
   * @param {HTMLElement} container - ShiftBar 容器
   * @param {object} shift - 序列化后的 shift 对象
   * @param {number} nowMs - 当前毫秒时间戳
   */
  function renderShiftBar(container, shift, nowMs) {
    if (!container || !shift) return;
    const startMs = Number(shift.start);
    const endMs = Number(shift.end);
    const totalMs = Math.max(1, endMs - startMs);

    const segments = [];
    if (shift.lunchStart != null && shift.lunchEnd != null) {
      const ls = Number(shift.lunchStart);
      const le = Number(shift.lunchEnd);
      if (ls > startMs) segments.push({ start: startMs, end: ls, lunch: false });
      if (le > ls) segments.push({ start: ls, end: le, lunch: true });
      if (endMs > le) segments.push({ start: le, end: endMs, lunch: false });
    } else if (endMs > startMs) {
      segments.push({ start: startMs, end: endMs, lunch: false });
    }

    if (segments.length === 0) {
      segments.push({ start: 0, end: 1, lunch: false });
    }

    container.innerHTML = '';
    for (const seg of segments) {
      const dur = Math.max(0, seg.end - seg.start);
      const weightRatio = (dur / totalMs) * 100;
      const segEl = document.createElement('div');
      segEl.className = seg.lunch ? 'shift-seg is-lunch' : 'shift-seg';
      segEl.style.flex = `${weightRatio} 1 0%`;

      if (!seg.lunch) {
        let frac = 0;
        if (typeof nowMs === 'number' && Number.isFinite(nowMs) && dur > 0) {
          frac = Math.min(1, Math.max(0, (nowMs - seg.start) / dur));
        }
        const fillEl = document.createElement('div');
        fillEl.className = 'shift-seg-fill';
        fillEl.style.width = `${(frac * 100).toFixed(2)}%`;
        segEl.appendChild(fillEl);
      }
      container.appendChild(segEl);
    }
  }

  /**
   * 根据主进程状态载荷刷新主面板视图。
   * @param {object} state - StatePayload
   */
  function render(state) {
    if (!state || typeof state !== 'object') return;
    const { settings = {}, boss = false, snapshot = {}, panelText = {}, milestoneStatus = {}, quote = '' } = state;
    const day = snapshot.day || {};
    const shift = snapshot.shift || {};

    // 1. 顶部标题与金额
    if (els.headerTitle) {
      els.headerTitle.textContent = panelText.headerTitle || (snapshot.phase === 'rest' ? '今天休息' : '今日已到账');
    }
    if (els.dayLine) {
      els.dayLine.textContent = panelText.dayLine || '';
    }
    if (els.earnedAmount) {
      els.earnedAmount.textContent = panelText.earned || '¥0.00';
      els.earnedAmount.classList.toggle('is-rest', snapshot.phase === 'rest');
    }
    if (els.phaseSubline) {
      els.phaseSubline.textContent = panelText.subline || '';
      els.phaseSubline.classList.toggle('is-working', snapshot.phase === 'working');
    }

    // 2. 三段式 ShiftBar 与工时进度（仅在 accrues 日显示）
    const showProgress = Boolean(day.accrues);
    setVisible(els.progressSection, showProgress);
    if (showProgress) {
      const pct = Number.isFinite(panelText.progressPercent)
        ? panelText.progressPercent
        : Number.isFinite(snapshot.progress)
          ? Math.floor(snapshot.progress * 100)
          : 0;
      if (els.shiftBar) {
        els.shiftBar.setAttribute('aria-valuenow', String(pct));
        renderShiftBar(els.shiftBar, shift, Number(snapshot.now));
      }
      if (els.workStartLabel) {
        els.workStartLabel.textContent = panelText.workStartLabel || '09:00';
      }
      if (els.lunchRangeLabel) {
        const hasLunch = Boolean(panelText.lunchRangeLabel);
        setVisible(els.lunchRangeLabel, hasLunch);
        if (hasLunch) {
          els.lunchRangeLabel.textContent = panelText.lunchRangeLabel;
        }
      }
      if (els.workEndLabel) {
        els.workEndLabel.textContent = panelText.workEndLabel || '18:00';
      }
      if (els.progressText) {
        els.progressText.textContent = `已完成 ${pct}% 有效工时`;
      }
      if (els.countdownWrapper) {
        if (snapshot.secondsToEnd != null) {
          els.countdownWrapper.textContent = `距下班 ${panelText.countdownText || '0:00:00'}`;
          els.countdownWrapper.className = 'countdown-wrapper accent-text';
        } else {
          els.countdownWrapper.textContent = '已下班';
          els.countdownWrapper.className = 'countdown-wrapper done-text';
        }
      }
    }

    // 3. 2x2 指标网格
    if (els.dailyWageLabel) {
      els.dailyWageLabel.textContent = panelText.dailyWageLabel || (day.isPaid ? '今日日薪' : '本月日薪');
    }
    if (els.dailyWageValue) {
      els.dailyWageValue.textContent = panelText.dailyWage || '¥0.00';
    }
    if (els.hourlyWageValue) {
      els.hourlyWageValue.textContent = panelText.hourly || '¥0.00';
    }
    if (els.monthTotalValue) {
      els.monthTotalValue.textContent = panelText.monthTotal || '¥0.00';
    }
    if (els.paidDaysValue) {
      els.paidDaysValue.textContent = panelText.paidDaysValue || '第 0 / 0 天';
    }

    // 4. 里程碑卡片（仅当 milestonesEnabled 且当天计薪时显示）
    const showMilestone = Boolean(settings.milestonesEnabled && day.isPaid);
    setVisible(els.milestoneSection, showMilestone);
    if (showMilestone) {
      const ms = panelText.milestone || milestoneStatus || {};
      if (els.milestoneTitle) {
        els.milestoneTitle.textContent = ms.title || '第一个小目标马上到';
      }
      if (els.milestoneDetail) {
        els.milestoneDetail.textContent = ms.detail || '今天的里程碑全部解锁';
      }
    }

    // 5. 加油语录
    const showQuote = Boolean(settings.quotesEnabled && quote);
    setVisible(els.quoteSection, showQuote);
    if (showQuote && els.quoteSection) {
      els.quoteSection.textContent = quote;
    }

    // 6. 底部操作按钮状态
    if (els.bossRowTitle) {
      els.bossRowTitle.textContent = panelText.bossRowTitle || (boss ? '老板模式：已开启' : '老板模式');
    }
    setVisible(els.bossCheck, Boolean(boss));
    if (els.bossShortcut) {
      els.bossShortcut.textContent = panelText.bossShortcutHint || '';
    }
  }

  // 绑定底部菜单点击事件
  if (els.btnBoss) {
    els.btnBoss.addEventListener('click', () => {
      if (api && typeof api.toggleBoss === 'function') {
        api.toggleBoss().then((nextState) => {
          if (nextState) render(nextState);
        });
      }
    });
  }

  if (els.btnSettings) {
    els.btnSettings.addEventListener('click', () => {
      if (api && typeof api.openSettings === 'function') {
        api.openSettings('salary');
      }
    });
  }

  if (els.btnQuit) {
    els.btnQuit.addEventListener('click', () => {
      if (api && typeof api.quitApp === 'function') {
        api.quitApp();
      }
    });
  }

  // 键盘快捷键：Escape 隐藏主面板、Ctrl+, 打开设置、Ctrl+Q 退出
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' || ev.code === 'Escape') {
      ev.preventDefault();
      if (api && typeof api.hidePanel === 'function') {
        api.hidePanel();
      }
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === ',' || ev.code === 'Comma')) {
      ev.preventDefault();
      if (api && typeof api.openSettings === 'function') {
        api.openSettings('salary');
      }
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'q' || ev.key === 'Q' || ev.code === 'KeyQ')) {
      ev.preventDefault();
      if (api && typeof api.quitApp === 'function') {
        api.quitApp();
      }
    }
  });

  // 监听面板尺寸变化并通知主进程自适应重定位
  if (typeof ResizeObserver === 'function' && els.root) {
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // 真实 Chromium 下使用 borderBoxSize（含 padding 26px + border 2px），测试沙箱下回退 contentRect
        const box = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize;
        const rect = entry.contentRect;
        const width = box && box.inlineSize ? Math.max(330, Math.ceil(box.inlineSize)) : Math.round((rect && rect.width) || 330);
        const height = box && box.blockSize ? Math.ceil(box.blockSize) : Math.round((rect && rect.height) || 0);
        if (height > 0 && api && typeof api.resizePanel === 'function') {
          api.resizePanel(width, height);
        }
      }
    });
    ro.observe(els.root);
  }

  // 订阅状态推送并拉取首帧状态
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
