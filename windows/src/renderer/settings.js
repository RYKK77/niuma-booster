'use strict';

/**
 * 牛马加油器 Windows 4 页设置窗口渲染脚本。
 * 复刻 macOS SettingsViews.swift（薪资、作息、节假日、显示），严格通过 window.niumaAPI 与主进程通信。
 */

(function initSettings() {
  const api = window.niumaAPI;
  const VALID_TABS = ['salary', 'schedule', 'holidays', 'display'];

  const DEFAULT_MILESTONES = [
    { name: '一杯奶茶', amount: 15 },
    { name: '一份外卖', amount: 30 },
    { name: '一张电影票', amount: 60 },
    { name: '一顿火锅', amount: 150 },
    { name: '一顿日料', amount: 800 },
    { name: '一双球鞋', amount: 1200 },
  ];

  const MANUAL_KIND_LABELS = {
    work: '工作日',
    rest: '休息（不计薪）',
    paidLeave: '带薪假（按全天计）',
  };

  function normalizeTab(tab) {
    if (typeof tab === 'number' && Number.isInteger(tab)) {
      return VALID_TABS[tab] || 'salary';
    }
    if (typeof tab === 'string') {
      const t = tab.trim();
      if (VALID_TABS.includes(t)) return t;
      const idx = Number(t);
      if (Number.isInteger(idx) && VALID_TABS[idx]) return VALID_TABS[idx];
    }
    return 'salary';
  }

  function initialTabFromUrl() {
    try {
      const params = new URLSearchParams(window.location && window.location.search ? window.location.search : '');
      const raw = params.get('tab');
      if (raw) return normalizeTab(raw);
    } catch {
      // 忽略 URL 解析错误
    }
    return 'salary';
  }

  let activeTab = initialTabFromUrl();
  let lastTabNonce = null;
  let currentState = null;
  let calYear = null;
  let calMonth = null; // 1..12
  let selectedDateKey = null;
  let importMessage = '';
  let milestonesDirty = false;

  const els = {
    tabBtns: Array.from(document.querySelectorAll('.tab-btn')),
    panes: {
      salary: document.getElementById('pane-salary'),
      schedule: document.getElementById('pane-schedule'),
      holidays: document.getElementById('pane-holidays'),
      display: document.getElementById('pane-display'),
    },

    // Tab 1: 薪资
    incomeBtns: {
      monthly: document.getElementById('income-monthly'),
      yearly: document.getElementById('income-yearly'),
      hourly: document.getElementById('income-hourly'),
    },
    labelAmount: document.getElementById('label-amount'),
    inputAmount: document.getElementById('input-amount'),
    incomeHint: document.getElementById('income-hint'),
    basisSection: document.getElementById('basis-section'),
    basisActual: document.getElementById('basis-actual'),
    basisFixed: document.getElementById('basis-fixed'),
    previewMonthDaysLabel: document.getElementById('preview-month-days-label'),
    previewMonthDaysValue: document.getElementById('preview-month-days-value'),
    previewDailyWage: document.getElementById('preview-daily-wage'),
    previewHourlyLabel: document.getElementById('preview-hourly-label'),
    previewHourlyWage: document.getElementById('preview-hourly-wage'),
    previewPerSecond: document.getElementById('preview-per-second'),
    inputCurrency: document.getElementById('input-currency'),
    decBtns: {
      0: document.getElementById('dec-0'),
      2: document.getElementById('dec-2'),
      4: document.getElementById('dec-4'),
    },

    // Tab 2: 作息
    inputWorkStart: document.getElementById('input-work-start'),
    inputWorkEnd: document.getElementById('input-work-end'),
    inputLunchEnabled: document.getElementById('input-lunch-enabled'),
    lunchTimesGroup: document.getElementById('lunch-times-group'),
    inputLunchStart: document.getElementById('input-lunch-start'),
    inputLunchEnd: document.getElementById('input-lunch-end'),
    scheduleEffectiveHours: document.getElementById('schedule-effective-hours'),
    scheduleShiftBar: document.getElementById('schedule-shift-bar'),
    schedStartText: document.getElementById('sched-start-text'),
    schedLunchText: document.getElementById('sched-lunch-text'),
    schedEndText: document.getElementById('sched-end-text'),
    zeroHoursWarning: document.getElementById('zero-hours-warning'),
    weekdayButtons: Array.from(document.querySelectorAll('#weekday-buttons .wd-btn')),
    inputBigSmall: document.getElementById('input-big-small'),
    bigWeekGroup: document.getElementById('big-week-group'),
    btnBigWeek: document.getElementById('btn-big-week'),
    btnSmallWeek: document.getElementById('btn-small-week'),

    // Tab 3: 节假日
    builtinYearsTitle: document.getElementById('builtin-years-title'),
    holidayImportHint: document.getElementById('holiday-import-hint'),
    btnClearImport: document.getElementById('btn-clear-import'),
    btnImportJson: document.getElementById('btn-import-json'),
    btnPrevMonth: document.getElementById('btn-prev-month'),
    calMonthTitle: document.getElementById('cal-month-title'),
    btnNextMonth: document.getElementById('btn-next-month'),
    calGrid: document.getElementById('cal-grid'),
    calSummaryDays: document.getElementById('cal-summary-days'),
    calSummaryWage: document.getElementById('cal-summary-wage'),
    calEditorHint: document.getElementById('cal-editor-hint'),
    calEditorBox: document.getElementById('cal-editor-box'),
    calEditorTitle: document.getElementById('cal-editor-title'),
    markBtns: {
      default: document.getElementById('mark-default'),
      work: document.getElementById('mark-work'),
      rest: document.getElementById('mark-rest'),
      paidLeave: document.getElementById('mark-leave'),
    },
    markNoteRow: document.getElementById('mark-note-row'),
    inputMarkNote: document.getElementById('input-mark-note'),
    noticeListTitle: document.getElementById('notice-list-title'),
    noticeList: document.getElementById('notice-list'),
    manualList: document.getElementById('manual-list'),

    // Tab 4: 显示
    statusPreviewPill: document.getElementById('status-preview-pill'),
    previewPillIcon: document.getElementById('preview-pill-icon'),
    previewPillText: document.getElementById('preview-pill-text'),
    fmtBtns: {
      amountOnly: document.getElementById('fmt-amount-only'),
      amountProgress: document.getElementById('fmt-amount-progress'),
      amountCountdown: document.getElementById('fmt-amount-countdown'),
      iconOnly: document.getElementById('fmt-icon-only'),
    },
    sampleAmountOnly: document.getElementById('sample-amount-only'),
    sampleAmountProgress: document.getElementById('sample-amount-progress'),
    sampleAmountCountdown: document.getElementById('sample-amount-countdown'),
    sampleIconOnly: document.getElementById('sample-icon-only'),
    inputShowIcon: document.getElementById('input-show-icon'),
    offBtns: {
      text: document.getElementById('off-text'),
      iconOnly: document.getElementById('off-icon'),
    },
    hkBtns: {
      ctrlOptB: document.getElementById('hk-ctrl-alt-b'),
      ctrlOptCmdH: document.getElementById('hk-ctrl-alt-h'),
      off: document.getElementById('hk-off'),
    },
    inputBossNow: document.getElementById('input-boss-now'),
    hotkeyWarning: document.getElementById('hotkey-warning'),
    inputMilestonesEnabled: document.getElementById('input-milestones-enabled'),
    btnToggleMilestones: document.getElementById('btn-toggle-milestones'),
    milestoneEditorPanel: document.getElementById('milestone-editor-panel'),
    inputMilestonesText: document.getElementById('input-milestones-text'),
    btnMsReset: document.getElementById('btn-ms-reset'),
    btnMsSave: document.getElementById('btn-ms-save'),
    inputQuotesEnabled: document.getElementById('input-quotes-enabled'),
    inputOffworkNotif: document.getElementById('input-offwork-notif'),
    inputLoginItem: document.getElementById('input-login-item'),
    loginHint: document.getElementById('login-hint'),
    loginError: document.getElementById('login-error'),
  };

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

  function setActiveState(el, active, roleAttr = 'aria-checked') {
    if (!el) return;
    el.classList.toggle('is-active', Boolean(active));
    el.setAttribute(roleAttr, active ? 'true' : 'false');
  }

  function formatMoney(value, currency = '¥', decimals = 2) {
    const safeVal = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    const d = typeof decimals === 'number' && Number.isFinite(decimals)
      ? Math.max(0, Math.min(4, Math.trunc(decimals)))
      : 2;
    const normalized = Object.is(safeVal, -0) ? 0 : safeVal;
    const fmt = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
      useGrouping: true,
      roundingMode: 'halfExpand',
    });
    const str = fmt.format(normalized).replace(/^-(0(?:\.0+)?)$/, '$1');
    return `${currency || '¥'}${str}`;
  }

  function minutesToHHMM(minutes) {
    const safe = typeof minutes === 'number' && Number.isFinite(minutes) ? Math.max(0, Math.trunc(minutes)) : 0;
    const h = Math.floor(safe / 60) % 24;
    const m = safe % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function hhmmToMinutes(str) {
    if (typeof str !== 'string') return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      return null;
    }
    return hh * 60 + mm;
  }

  function makeDateKey(y, m, d) {
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function parseDateKey(key) {
    if (typeof key !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
    if (!m) return null;
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  }

  function mondayOf(dateObj) {
    const d = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
    const wd = d.getDay() + 1; // 1=周日..7=周六
    const offset = -((wd + 5) % 7);
    d.setDate(d.getDate() + offset);
    return d;
  }

  function isBigWeekForDate(dateObj, anchorKey) {
    const parsed = parseDateKey(anchorKey);
    if (!parsed) return false;
    const anchorMon = mondayOf(new Date(parsed.year, parsed.month - 1, parsed.day));
    const curMon = mondayOf(dateObj);
    const diffDays = Math.round(
      (Date.UTC(curMon.getFullYear(), curMon.getMonth(), curMon.getDate()) -
        Date.UTC(anchorMon.getFullYear(), anchorMon.getMonth(), anchorMon.getDate())) /
        86400000
    );
    const weeks = Math.round(diffDays / 7);
    return ((weeks % 2) + 2) % 2 === 0;
  }

  function kindLabel(info) {
    if (!info) return '工作日';
    switch (info.kind) {
      case 'workday':
        return info.name === '大周' ? '大周周六' : '工作日';
      case 'makeupWorkday':
        return '调休补班';
      case 'weekend':
        return '周末';
      case 'holiday':
        return info.name || '法定节假日';
      case 'paidLeave':
        return info.name ? `带薪假（${info.name}）` : '带薪假';
      case 'manualRest':
        return info.name ? `休息（${info.name}）` : '休息';
      case 'manualWork':
        return info.name ? `上班（${info.name}）` : '上班';
      default:
        return '工作日';
    }
  }

  function isPaidKind(kind) {
    return kind === 'workday' || kind === 'makeupWorkday' || kind === 'paidLeave' || kind === 'manualWork';
  }

  function resolveDayInfo(y, m, d, settings, builtinHolidays, ignoreManual = false) {
    const key = makeDateKey(y, m, d);
    if (!ignoreManual && Array.isArray(settings.manualMarks)) {
      const mark = settings.manualMarks.find((item) => item && item.date === key);
      if (mark) {
        const note = mark.note && mark.note.trim() ? mark.note.trim() : null;
        if (mark.kind === 'work') return { kind: 'manualWork', name: note, isPaid: true };
        if (mark.kind === 'rest') return { kind: 'manualRest', name: note, isPaid: false };
        if (mark.kind === 'paidLeave') return { kind: 'paidLeave', name: note, isPaid: true };
      }
    }

    const imported = Array.isArray(settings.importedHolidays)
      ? settings.importedHolidays.find((e) => e && e.date === key)
      : null;
    const builtin = Array.isArray(builtinHolidays)
      ? builtinHolidays.find((e) => e && e.date === key)
      : null;
    const entry = imported || builtin;
    if (entry) {
      const kind = entry.type === 'holiday' ? 'holiday' : 'makeupWorkday';
      return { kind, name: entry.name || null, isPaid: isPaidKind(kind) };
    }

    const dt = new Date(y, m - 1, d);
    const wd = dt.getDay() + 1;
    const weekdays = Array.isArray(settings.workWeekdays) ? settings.workWeekdays : [2, 3, 4, 5, 6];
    if (weekdays.includes(wd)) {
      return { kind: 'workday', name: null, isPaid: true };
    }
    if (settings.bigSmallWeek && wd === 7 && isBigWeekForDate(dt, settings.bigWeekAnchor)) {
      return { kind: 'workday', name: '大周', isPaid: true };
    }
    return { kind: 'weekend', name: null, isPaid: false };
  }

  function formatMilestones(list) {
    return (Array.isArray(list) ? list : [])
      .map((m) => {
        const v = Math.round(m.amount) === m.amount ? String(Math.trunc(m.amount)) : String(m.amount);
        return `${m.name},${v}`;
      })
      .join('\n');
  }

  function parseMilestones(text) {
    if (typeof text !== 'string') return [];
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split(/[,，]/).map((p) => p.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
      const amount = Number(parts[1]);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      out.push({ name: parts[0], amount });
    }
    return out;
  }

  function switchTab(nextTab) {
    activeTab = normalizeTab(nextTab);
    for (const btn of els.tabBtns) {
      const isMatch = btn.dataset.tab === activeTab;
      setActiveState(btn, isMatch, 'aria-selected');
    }
    for (const [key, pane] of Object.entries(els.panes)) {
      setVisible(pane, key === activeTab);
    }
  }

  function renderSalaryTab(settings, snapshot) {
    const typeLabels = { monthly: '月薪', yearly: '年薪', hourly: '时薪' };
    for (const [k, btn] of Object.entries(els.incomeBtns)) {
      setActiveState(btn, settings.incomeType === k);
    }
    if (els.labelAmount) {
      els.labelAmount.textContent = `${typeLabels[settings.incomeType] || '月薪'}金额（${settings.currency || '¥'}）`;
    }
    if (els.inputAmount && document.activeElement !== els.inputAmount) {
      els.inputAmount.value = String(Number.isFinite(settings.amount) ? settings.amount : 0);
    }
    if (els.incomeHint) {
      els.incomeHint.textContent =
        settings.incomeType === 'yearly'
          ? '年薪按 12 个月折算成月薪。税前、到手都可以，按你想看的口径填。'
          : '税前、到手都可以，按你想看的口径填。改完实时生效。';
    }

    const showBasis = settings.incomeType !== 'hourly';
    setVisible(els.basisSection, showBasis);
    if (showBasis) {
      setActiveState(els.basisActual, settings.basis === 'actualWorkdays');
      setActiveState(els.basisFixed, settings.basis === 'fixed2175');
    }

    const shiftDayObj = snapshot.shiftDay ? new Date(snapshot.shiftDay) : new Date();
    const monthNum = shiftDayObj.getMonth() + 1;
    const effSec = snapshot.shift && Number.isFinite(snapshot.shift.effectiveSeconds)
      ? snapshot.shift.effectiveSeconds
      : 0;
    const h = effSec / 3600;
    const hoursStr = Math.round(h) === h ? `${Math.trunc(h)} 小时` : `${h.toFixed(1)} 小时`;

    if (els.previewMonthDaysLabel) {
      els.previewMonthDaysLabel.textContent = `${monthNum} 月计薪日`;
    }
    if (els.previewMonthDaysValue) {
      els.previewMonthDaysValue.textContent = `${snapshot.paidDaysInMonth || 0} 天`;
    }
    if (els.previewDailyWage) {
      els.previewDailyWage.textContent = formatMoney(snapshot.dailyWage, settings.currency, settings.decimals);
    }
    if (els.previewHourlyLabel) {
      els.previewHourlyLabel.textContent = `时薪（${hoursStr}）`;
    }
    if (els.previewHourlyWage) {
      els.previewHourlyWage.textContent = formatMoney(snapshot.hourly, settings.currency, settings.decimals);
    }
    if (els.previewPerSecond) {
      els.previewPerSecond.textContent = formatMoney(snapshot.perSecond, settings.currency, 4);
    }

    if (els.inputCurrency && document.activeElement !== els.inputCurrency) {
      els.inputCurrency.value = settings.currency || '¥';
    }
    for (const [dec, btn] of Object.entries(els.decBtns)) {
      setActiveState(btn, Number(settings.decimals) === Number(dec));
    }
  }

  function renderScheduleTab(settings, snapshot, runtime) {
    if (els.inputWorkStart && document.activeElement !== els.inputWorkStart) {
      els.inputWorkStart.value = minutesToHHMM(settings.workStart);
    }
    if (els.inputWorkEnd && document.activeElement !== els.inputWorkEnd) {
      els.inputWorkEnd.value = minutesToHHMM(settings.workEnd);
    }
    if (els.inputLunchEnabled) {
      els.inputLunchEnabled.checked = Boolean(settings.lunchEnabled);
    }
    setVisible(els.lunchTimesGroup, Boolean(settings.lunchEnabled));
    if (els.inputLunchStart && document.activeElement !== els.inputLunchStart) {
      els.inputLunchStart.value = minutesToHHMM(settings.lunchStart);
    }
    if (els.inputLunchEnd && document.activeElement !== els.inputLunchEnd) {
      els.inputLunchEnd.value = minutesToHHMM(settings.lunchEnd);
    }

    const shift = snapshot.shift || {};
    const effSec = Number.isFinite(shift.effectiveSeconds) ? shift.effectiveSeconds : 0;
    if (els.scheduleEffectiveHours) {
      els.scheduleEffectiveHours.textContent = `有效工时 ${(effSec / 3600).toFixed(1)} 小时`;
    }

    // 渲染作息预览条
    if (els.scheduleShiftBar) {
      els.scheduleShiftBar.innerHTML = '';
      const startMs = Number(shift.start) || 0;
      const endMs = Number(shift.end) || 1;
      const total = Math.max(1, endMs - startMs);
      const segs = [];
      if (settings.lunchEnabled && shift.lunchStart != null && shift.lunchEnd != null) {
        const ls = Number(shift.lunchStart);
        const le = Number(shift.lunchEnd);
        if (ls > startMs) segs.push({ dur: ls - startMs, lunch: false });
        if (le > ls) segs.push({ dur: le - ls, lunch: true });
        if (endMs > le) segs.push({ dur: endMs - le, lunch: false });
      } else if (endMs > startMs) {
        segs.push({ dur: endMs - startMs, lunch: false });
      }
      if (segs.length === 0) segs.push({ dur: 1, lunch: false });
      for (const s of segs) {
        const d = document.createElement('div');
        d.className = s.lunch ? 'shift-seg is-lunch' : 'shift-seg';
        d.style.flex = `${(s.dur / total) * 100} 1 0%`;
        els.scheduleShiftBar.appendChild(d);
      }
    }

    if (els.schedStartText) {
      els.schedStartText.textContent = minutesToHHMM(settings.workStart);
    }
    const showLunchLabel = Boolean(settings.lunchEnabled && shift.lunchStart != null && shift.lunchEnd != null);
    setVisible(els.schedLunchText, showLunchLabel);
    if (showLunchLabel && els.schedLunchText) {
      els.schedLunchText.textContent = `午休 ${minutesToHHMM(settings.lunchStart)}–${minutesToHHMM(settings.lunchEnd)}`;
    }
    if (els.schedEndText) {
      const crossNight = settings.workEnd < settings.workStart ? '（次日）' : '';
      els.schedEndText.textContent = `${minutesToHHMM(settings.workEnd)}${crossNight}`;
    }

    setVisible(els.zeroHoursWarning, effSec <= 0);

    const wds = Array.isArray(settings.workWeekdays) ? settings.workWeekdays : [];
    for (const btn of els.weekdayButtons) {
      const wd = Number(btn.dataset.wd);
      const on = wds.includes(wd);
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    if (els.inputBigSmall) {
      els.inputBigSmall.checked = Boolean(settings.bigSmallWeek);
    }
    setVisible(els.bigWeekGroup, Boolean(settings.bigSmallWeek));
    if (settings.bigSmallWeek) {
      const isBig = Boolean(runtime && runtime.isBigWeek);
      setActiveState(els.btnBigWeek, isBig);
      setActiveState(els.btnSmallWeek, !isBig);
    }
  }

  function renderHolidaysTab(settings, snapshot, runtime) {
    const nowDate = snapshot && snapshot.now ? new Date(snapshot.now) : new Date();
    if (calYear === null || calMonth === null) {
      calYear = nowDate.getFullYear();
      calMonth = nowDate.getMonth() + 1;
    }

    const years = (runtime && Array.isArray(runtime.builtinYears) && runtime.builtinYears.length > 0)
      ? runtime.builtinYears
      : [2026, 2027];
    if (els.builtinYearsTitle) {
      els.builtinYearsTitle.textContent = `已内置 ${years.join('、')} 年国务院放假安排`;
    }

    const importedList = Array.isArray(settings.importedHolidays) ? settings.importedHolidays : [];
    setVisible(els.btnClearImport, importedList.length > 0);
    if (els.holidayImportHint) {
      if (importedList.length > 0) {
        const countMsg = `另外导入了 ${importedList.length} 天，导入的优先于内置。`;
        els.holidayImportHint.textContent = importMessage ? `${importMessage} ${countMsg}` : countMsg;
      } else {
        els.holidayImportHint.textContent =
          importMessage || '以后的年份公布后，导入 JSON 或在日历里手动标记即可。';
      }
    }

    if (els.calMonthTitle) {
      els.calMonthTitle.textContent = `${calYear} 年 ${calMonth} 月`;
    }

    const builtinHolidays = (runtime && Array.isArray(runtime.builtinHolidays)) ? runtime.builtinHolidays : [];
    const daysInMonth = new Date(calYear, calMonth, 0).getDate();
    const firstDate = new Date(calYear, calMonth - 1, 1);
    const leadEmpty = (firstDate.getDay() + 6) % 7; // 周一为 0

    let paidCount = 0;
    if (els.calGrid) {
      els.calGrid.innerHTML = '';
      for (let i = 0; i < leadEmpty; i++) {
        const pad = document.createElement('div');
        pad.className = 'cal-pad';
        els.calGrid.appendChild(pad);
      }

      const todayKey = makeDateKey(nowDate.getFullYear(), nowDate.getMonth() + 1, nowDate.getDate());
      const manualMarks = Array.isArray(settings.manualMarks) ? settings.manualMarks : [];

      for (let d = 1; d <= daysInMonth; d++) {
        const key = makeDateKey(calYear, calMonth, d);
        const info = resolveDayInfo(calYear, calMonth, d, settings, builtinHolidays, false);
        if (info.isPaid) paidCount++;

        const hasManual = manualMarks.some((m) => m && m.date === key);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.date = key;
        btn.className = [
          'cal-cell',
          info.isPaid ? 'is-paid' : '',
          key === todayKey ? 'is-today' : '',
          hasManual ? 'is-manual' : '',
          key === selectedDateKey ? 'is-selected' : '',
        ]
          .filter(Boolean)
          .join(' ');
        btn.setAttribute('aria-label', `${calMonth}月${d}日 ${kindLabel(info)}`);

        const numSpan = document.createElement('span');
        numSpan.className = 'cal-day-num';
        numSpan.textContent = String(d);
        btn.appendChild(numSpan);

        let tag = null;
        if (info.kind === 'holiday' || info.kind === 'manualRest') {
          tag = { text: '休', cls: 'is-rest' };
        } else if (info.kind === 'makeupWorkday' || info.kind === 'manualWork') {
          tag = { text: '班', cls: 'is-work' };
        } else if (info.kind === 'paidLeave') {
          tag = { text: '假', cls: 'is-leave' };
        }
        if (tag) {
          const pill = document.createElement('span');
          pill.className = `tag-pill ${tag.cls}`;
          pill.textContent = tag.text;
          btn.appendChild(pill);
        }

        btn.addEventListener('click', () => {
          selectedDateKey = key;
          if (currentState) renderHolidaysTab(currentState.settings, currentState.snapshot, currentState.runtime);
        });

        els.calGrid.appendChild(btn);
      }
    }

    // 计算当前浏览月份的日薪
    const effHours = snapshot.shift && Number.isFinite(snapshot.shift.effectiveSeconds)
      ? snapshot.shift.effectiveSeconds / 3600
      : 0;
    let monthDailyWage = 0;
    if (settings.incomeType === 'hourly') {
      monthDailyWage = settings.amount * effHours;
    } else {
      const monthly = settings.incomeType === 'yearly' ? settings.amount / 12 : settings.amount;
      const denom = settings.basis === 'fixed2175' ? 21.75 : paidCount;
      monthDailyWage = denom > 0 ? monthly / denom : 0;
    }

    if (els.calSummaryDays) {
      els.calSummaryDays.textContent = `${calMonth} 月计薪工作日 ${paidCount} 天`;
    }
    if (els.calSummaryWage) {
      els.calSummaryWage.textContent = `日薪 ${formatMoney(monthDailyWage, settings.currency, settings.decimals)}`;
    }

    // 渲染单日手动标记编辑器
    const parsedSel = parseDateKey(selectedDateKey);
    if (parsedSel) {
      setVisible(els.calEditorHint, false);
      setVisible(els.calEditorBox, true);
      const defaultInfo = resolveDayInfo(parsedSel.year, parsedSel.month, parsedSel.day, settings, builtinHolidays, true);
      if (els.calEditorTitle) {
        els.calEditorTitle.textContent = `${parsedSel.month}月${parsedSel.day}日 · 默认：${kindLabel(defaultInfo)}`;
      }
      const mark = (Array.isArray(settings.manualMarks) ? settings.manualMarks : []).find(
        (m) => m && m.date === selectedDateKey
      );
      const curKind = mark ? mark.kind : 'default';
      for (const [k, btn] of Object.entries(els.markBtns)) {
        setActiveState(btn, curKind === k);
      }
      setVisible(els.markNoteRow, Boolean(mark));
      if (mark && els.inputMarkNote && document.activeElement !== els.inputMarkNote) {
        els.inputMarkNote.value = mark.note || '';
      }
    } else {
      setVisible(els.calEditorHint, true);
      setVisible(els.calEditorBox, false);
    }

    // 右侧列表 1：当年法定节假日汇总
    if (els.noticeListTitle) {
      els.noticeListTitle.textContent = `${calYear} 法定节假日`;
    }
    if (els.noticeList) {
      els.noticeList.innerHTML = '';
      const mergedMap = new Map();
      for (const e of builtinHolidays) {
        if (e && e.date) mergedMap.set(e.date, e);
      }
      for (const e of importedList) {
        if (e && e.date) mergedMap.set(e.date, e);
      }
      const groups = new Map();
      const order = [];
      const prefix = `${calYear}-`;
      for (const e of mergedMap.values()) {
        if (!e.date.startsWith(prefix)) continue;
        if (!groups.has(e.name)) {
          order.push(e.name);
          groups.set(e.name, { holidays: [], work: [] });
        }
        if (e.type === 'holiday') groups.get(e.name).holidays.push(e.date);
        else groups.get(e.name).work.push(e.date);
      }
      const fmtMd = (k) => {
        const p = parseDateKey(k);
        return p ? `${p.month}/${p.day}` : k;
      };
      order.sort((a, b) => {
        const ga = groups.get(a);
        const gb = groups.get(b);
        const minA = ga.holidays.slice().sort()[0] || ga.work.slice().sort()[0] || '';
        const minB = gb.holidays.slice().sort()[0] || gb.work.slice().sort()[0] || '';
        return minA.localeCompare(minB);
      });

      if (order.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'form-hint';
        empty.textContent = `${calYear} 年还没有数据，导入 JSON 或在日历里手动标记。`;
        els.noticeList.appendChild(empty);
      } else {
        for (const name of order) {
          const g = groups.get(name);
          const h = g.holidays.slice().sort();
          const w = g.work.slice().sort();
          let detail = h.length === 0 ? '' : h.length === 1 ? fmtMd(h[0]) : `${fmtMd(h[0])}–${fmtMd(h[h.length - 1])}`;
          if (w.length > 0) {
            detail += `${detail ? ' · ' : ''}补班 ${w.map(fmtMd).join('、')}`;
          }
          const row = document.createElement('div');
          row.className = 'list-row tabular';
          const nSpan = document.createElement('span');
          nSpan.textContent = name;
          const dSpan = document.createElement('span');
          dSpan.className = 'form-hint';
          dSpan.textContent = detail;
          row.appendChild(nSpan);
          row.appendChild(dSpan);
          els.noticeList.appendChild(row);
        }
      }
    }

    // 右侧列表 2：我的手动标记
    if (els.manualList) {
      els.manualList.innerHTML = '';
      const marks = Array.isArray(settings.manualMarks) ? settings.manualMarks : [];
      if (marks.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'form-hint';
        empty.textContent = '还没有。点左边日历里的日期来标记。';
        els.manualList.appendChild(empty);
      } else {
        for (const m of marks) {
          const row = document.createElement('div');
          row.className = 'list-row tabular';
          const dateSpan = document.createElement('span');
          dateSpan.textContent = m.date;
          const descSpan = document.createElement('span');
          descSpan.className = 'form-hint';
          const kLabel = MANUAL_KIND_LABELS[m.kind] || m.kind;
          descSpan.textContent = m.note ? `${kLabel} · ${m.note}` : kLabel;
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'del-btn';
          delBtn.setAttribute('aria-label', `删除 ${m.date} 的标记`);
          delBtn.textContent = '×';
          delBtn.addEventListener('click', () => {
            updateManualMark(m.date, null);
          });
          row.appendChild(dateSpan);
          row.appendChild(descSpan);
          row.appendChild(delBtn);
          els.manualList.appendChild(row);
        }
      }
    }
  }

  function renderDisplayTab(settings, statusLine, boss, runtime, snapshot) {
    const phase = snapshot && snapshot.phase ? snapshot.phase : null;
    const isOffHours = phase === 'rest' || phase === 'beforeWork' || phase === 'afterWork';
    const forceIconNow =
      settings.menuBarFormat === 'iconOnly' ||
      Boolean(statusLine && statusLine.forceIcon) ||
      (isOffHours && settings.offHoursDisplay === 'iconOnly');

    const plain = !forceIconNow && statusLine && statusLine.plainText ? statusLine.plainText : '';
    const showIconInPill = Boolean(settings.showIcon || forceIconNow || !plain);

    setVisible(els.previewPillIcon, showIconInPill);
    setVisible(els.previewPillText, Boolean(plain));
    if (plain && els.previewPillText) {
      els.previewPillText.textContent = plain;
    }

    const samples = (runtime && runtime.statusSamples) || {};
    if (els.sampleAmountOnly) els.sampleAmountOnly.textContent = samples.amountOnly || '';
    if (els.sampleAmountProgress) els.sampleAmountProgress.textContent = samples.amountProgress || '';
    if (els.sampleAmountCountdown) els.sampleAmountCountdown.textContent = samples.amountCountdown || '';
    if (els.sampleIconOnly) els.sampleIconOnly.textContent = samples.iconOnly || '金额只在面板里看';

    for (const [fmt, btn] of Object.entries(els.fmtBtns)) {
      setActiveState(btn, settings.menuBarFormat === fmt);
    }

    if (els.inputShowIcon) {
      els.inputShowIcon.checked = Boolean(settings.showIcon);
    }

    for (const [off, btn] of Object.entries(els.offBtns)) {
      setActiveState(btn, settings.offHoursDisplay === off);
    }

    for (const [hk, btn] of Object.entries(els.hkBtns)) {
      setActiveState(btn, settings.bossHotkey === hk);
    }

    if (els.inputBossNow) {
      els.inputBossNow.checked = Boolean(boss);
    }

    const hkWarn = runtime && runtime.hotkeyWarning ? String(runtime.hotkeyWarning) : '';
    setVisible(els.hotkeyWarning, Boolean(hkWarn));
    if (hkWarn && els.hotkeyWarning) {
      els.hotkeyWarning.textContent = hkWarn;
    }

    if (els.inputMilestonesEnabled) {
      els.inputMilestonesEnabled.checked = Boolean(settings.milestonesEnabled);
    }

    if (els.inputMilestonesText && !milestonesDirty && document.activeElement !== els.inputMilestonesText) {
      els.inputMilestonesText.value = formatMilestones(settings.milestones);
    }

    if (els.inputQuotesEnabled) {
      els.inputQuotesEnabled.checked = Boolean(settings.quotesEnabled);
    }

    if (els.inputOffworkNotif) {
      els.inputOffworkNotif.checked = Boolean(settings.offWorkNotification);
    }

    if (els.inputLoginItem) {
      els.inputLoginItem.checked = Boolean(runtime && runtime.openAtLogin);
    }

    const lHint = runtime && runtime.loginHint ? String(runtime.loginHint) : '';
    setVisible(els.loginHint, Boolean(lHint));
    if (lHint && els.loginHint) {
      els.loginHint.textContent = lHint;
    }

    const lErr = runtime && (runtime.loginError || runtime.loginItemError)
      ? String(runtime.loginError || runtime.loginItemError)
      : '';
    setVisible(els.loginError, Boolean(lErr));
    if (lErr && els.loginError) {
      els.loginError.textContent = lErr;
    }
  }

  function render(state) {
    if (!state || typeof state !== 'object') return;
    currentState = state;
    const { settings = {}, snapshot = {}, statusLine = {}, boss = false, runtime = {} } = state;

    if (runtime.settingsTabNonce !== undefined && runtime.settingsTabNonce !== lastTabNonce) {
      lastTabNonce = runtime.settingsTabNonce;
      if (runtime.settingsTab) {
        switchTab(runtime.settingsTab);
      }
    }

    renderSalaryTab(settings, snapshot);
    renderScheduleTab(settings, snapshot, runtime);
    renderHolidaysTab(settings, snapshot, runtime);
    renderDisplayTab(settings, statusLine, boss, runtime, snapshot);
  }

  function applyPatch(patch) {
    if (!api || typeof api.updateSettings !== 'function') return;
    api.updateSettings(patch).then((nextState) => {
      if (nextState) render(nextState);
    });
  }

  function updateManualMark(dateKey, nextMark) {
    if (!currentState || !currentState.settings) return;
    const list = Array.isArray(currentState.settings.manualMarks)
      ? currentState.settings.manualMarks.filter((m) => m && m.date !== dateKey)
      : [];
    if (nextMark) {
      list.push(nextMark);
      list.sort((a, b) => a.date.localeCompare(b.date));
    }
    applyPatch({ manualMarks: list });
  }

  // --- 事件绑定 ---

  for (const btn of els.tabBtns) {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  }

  // Tab 1: 薪资事件
  for (const [inc, btn] of Object.entries(els.incomeBtns)) {
    if (!btn) continue;
    btn.addEventListener('click', () => applyPatch({ incomeType: inc }));
  }

  if (els.inputAmount) {
    const onAmountChange = () => {
      const raw = String(els.inputAmount.value || '').trim();
      if (!raw) return;
      const val = Number(raw);
      if (!Number.isFinite(val) || val < 0) return;
      applyPatch({ amount: val });
    };
    els.inputAmount.addEventListener('input', onAmountChange);
    els.inputAmount.addEventListener('change', onAmountChange);
  }

  if (els.basisActual) {
    els.basisActual.addEventListener('click', () => applyPatch({ basis: 'actualWorkdays' }));
  }
  if (els.basisFixed) {
    els.basisFixed.addEventListener('click', () => applyPatch({ basis: 'fixed2175' }));
  }

  if (els.inputCurrency) {
    const onCurrencyChange = () => {
      const val = String(els.inputCurrency.value || '').trim();
      if (val.length > 0) applyPatch({ currency: val });
    };
    els.inputCurrency.addEventListener('input', onCurrencyChange);
    els.inputCurrency.addEventListener('change', onCurrencyChange);
  }

  for (const [dec, btn] of Object.entries(els.decBtns)) {
    if (!btn) continue;
    btn.addEventListener('click', () => applyPatch({ decimals: Number(dec) }));
  }

  // Tab 2: 作息事件
  function bindTimeInput(el, field) {
    if (!el) return;
    const handler = () => {
      const mins = hhmmToMinutes(el.value);
      if (mins !== null) applyPatch({ [field]: mins });
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  }

  bindTimeInput(els.inputWorkStart, 'workStart');
  bindTimeInput(els.inputWorkEnd, 'workEnd');
  bindTimeInput(els.inputLunchStart, 'lunchStart');
  bindTimeInput(els.inputLunchEnd, 'lunchEnd');

  if (els.inputLunchEnabled) {
    els.inputLunchEnabled.addEventListener('change', () => {
      applyPatch({ lunchEnabled: Boolean(els.inputLunchEnabled.checked) });
    });
  }

  for (const btn of els.weekdayButtons) {
    btn.addEventListener('click', () => {
      if (!currentState || !currentState.settings) return;
      const wd = Number(btn.dataset.wd);
      const cur = new Set(currentState.settings.workWeekdays || []);
      if (cur.has(wd)) cur.delete(wd);
      else cur.add(wd);
      applyPatch({ workWeekdays: Array.from(cur).sort((a, b) => a - b) });
    });
  }

  if (els.inputBigSmall) {
    els.inputBigSmall.addEventListener('change', () => {
      if (api && typeof api.setBigSmallWeek === 'function') {
        api.setBigSmallWeek(Boolean(els.inputBigSmall.checked)).then((nextState) => {
          if (nextState) render(nextState);
        });
      }
    });
  }

  if (els.btnBigWeek) {
    els.btnBigWeek.addEventListener('click', () => {
      const nowDate = currentState && currentState.snapshot && currentState.snapshot.now
        ? new Date(currentState.snapshot.now)
        : new Date();
      const mon = mondayOf(nowDate);
      applyPatch({ bigWeekAnchor: makeDateKey(mon.getFullYear(), mon.getMonth() + 1, mon.getDate()) });
    });
  }

  if (els.btnSmallWeek) {
    els.btnSmallWeek.addEventListener('click', () => {
      const nowDate = currentState && currentState.snapshot && currentState.snapshot.now
        ? new Date(currentState.snapshot.now)
        : new Date();
      const mon = mondayOf(nowDate);
      mon.setDate(mon.getDate() + 7);
      applyPatch({ bigWeekAnchor: makeDateKey(mon.getFullYear(), mon.getMonth() + 1, mon.getDate()) });
    });
  }

  // Tab 3: 节假日事件
  if (els.btnPrevMonth) {
    els.btnPrevMonth.addEventListener('click', () => {
      if (calYear === null || calMonth === null) return;
      calMonth -= 1;
      if (calMonth < 1) {
        calMonth = 12;
        calYear -= 1;
      }
      selectedDateKey = null;
      if (currentState) renderHolidaysTab(currentState.settings, currentState.snapshot, currentState.runtime);
    });
  }

  if (els.btnNextMonth) {
    els.btnNextMonth.addEventListener('click', () => {
      if (calYear === null || calMonth === null) return;
      calMonth += 1;
      if (calMonth > 12) {
        calMonth = 1;
        calYear += 1;
      }
      selectedDateKey = null;
      if (currentState) renderHolidaysTab(currentState.settings, currentState.snapshot, currentState.runtime);
    });
  }

  if (els.btnImportJson) {
    els.btnImportJson.addEventListener('click', () => {
      if (!api || typeof api.importHolidaysDialog !== 'function') return;
      api.importHolidaysDialog().then((res) => {
        if (res && !res.canceled) {
          importMessage = res.message || '';
          if (res.state) {
            render(res.state);
          } else if (currentState) {
            renderHolidaysTab(currentState.settings, currentState.snapshot, currentState.runtime);
          }
        }
      });
    });
  }

  if (els.btnClearImport) {
    els.btnClearImport.addEventListener('click', () => {
      importMessage = '';
      if (api && typeof api.clearImportedHolidays === 'function') {
        api.clearImportedHolidays().then((nextState) => {
          if (nextState) render(nextState);
        });
      }
    });
  }

  for (const [kindKey, btn] of Object.entries(els.markBtns)) {
    if (!btn) continue;
    btn.addEventListener('click', () => {
      if (!selectedDateKey || !currentState || !currentState.settings) return;
      if (kindKey === 'default') {
        updateManualMark(selectedDateKey, null);
      } else {
        const existing = (currentState.settings.manualMarks || []).find((m) => m && m.date === selectedDateKey);
        updateManualMark(selectedDateKey, {
          date: selectedDateKey,
          kind: kindKey,
          note: existing && existing.note ? existing.note : '',
        });
      }
    });
  }

  if (els.inputMarkNote) {
    const onNoteChange = () => {
      if (!selectedDateKey || !currentState || !currentState.settings) return;
      const existing = (currentState.settings.manualMarks || []).find((m) => m && m.date === selectedDateKey);
      if (!existing) return;
      updateManualMark(selectedDateKey, {
        date: selectedDateKey,
        kind: existing.kind,
        note: String(els.inputMarkNote.value || ''),
      });
    };
    els.inputMarkNote.addEventListener('input', onNoteChange);
    els.inputMarkNote.addEventListener('change', onNoteChange);
  }

  // Tab 4: 显示事件
  for (const [fmt, btn] of Object.entries(els.fmtBtns)) {
    if (!btn) continue;
    btn.addEventListener('click', () => applyPatch({ menuBarFormat: fmt }));
  }

  if (els.inputShowIcon) {
    els.inputShowIcon.addEventListener('change', () => {
      applyPatch({ showIcon: Boolean(els.inputShowIcon.checked) });
    });
  }

  for (const [off, btn] of Object.entries(els.offBtns)) {
    if (!btn) continue;
    btn.addEventListener('click', () => applyPatch({ offHoursDisplay: off }));
  }

  for (const [hk, btn] of Object.entries(els.hkBtns)) {
    if (!btn) continue;
    btn.addEventListener('click', () => applyPatch({ bossHotkey: hk }));
  }

  if (els.inputBossNow) {
    els.inputBossNow.addEventListener('change', () => {
      if (api && typeof api.setBoss === 'function') {
        api.setBoss(Boolean(els.inputBossNow.checked)).then((nextState) => {
          if (nextState) render(nextState);
        });
      }
    });
  }

  if (els.inputMilestonesEnabled) {
    els.inputMilestonesEnabled.addEventListener('change', () => {
      applyPatch({ milestonesEnabled: Boolean(els.inputMilestonesEnabled.checked) });
    });
  }

  if (els.btnToggleMilestones) {
    els.btnToggleMilestones.addEventListener('click', () => {
      setVisible(els.milestoneEditorPanel, true);
    });
  }

  if (els.inputMilestonesText) {
    const markDirty = () => {
      milestonesDirty = true;
    };
    els.inputMilestonesText.addEventListener('input', markDirty);
    els.inputMilestonesText.addEventListener('change', markDirty);
  }

  if (els.btnMsReset) {
    els.btnMsReset.addEventListener('click', () => {
      if (!els.inputMilestonesText) return;
      els.inputMilestonesText.value = formatMilestones(DEFAULT_MILESTONES);
      milestonesDirty = true;
    });
  }

  if (els.btnMsSave) {
    els.btnMsSave.addEventListener('click', () => {
      if (!els.inputMilestonesText) return;
      const parsed = parseMilestones(els.inputMilestonesText.value);
      milestonesDirty = false;
      if (parsed.length > 0) {
        els.inputMilestonesText.value = formatMilestones(parsed);
        applyPatch({ milestones: parsed });
      } else if (currentState && currentState.settings) {
        els.inputMilestonesText.value = formatMilestones(currentState.settings.milestones);
      }
    });
  }

  if (els.inputQuotesEnabled) {
    els.inputQuotesEnabled.addEventListener('change', () => {
      applyPatch({ quotesEnabled: Boolean(els.inputQuotesEnabled.checked) });
    });
  }

  if (els.inputOffworkNotif) {
    els.inputOffworkNotif.addEventListener('change', () => {
      applyPatch({ offWorkNotification: Boolean(els.inputOffworkNotif.checked) });
    });
  }

  if (els.inputLoginItem) {
    els.inputLoginItem.addEventListener('change', () => {
      if (api && typeof api.setLoginItem === 'function') {
        api.setLoginItem(Boolean(els.inputLoginItem.checked)).then((res) => {
          if (res && res.state) {
            render(res.state);
          }
        });
      }
    });
  }

  // 初始化当前页签显隐
  switchTab(activeTab);

  // 订阅状态广播与拉取初始状态
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
