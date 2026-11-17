'use strict';

/**
 * 设置模型、枚举定义、容错编解码与节假日导入工具。
 * 1:1 对齐 Sources/NiumaCore/Settings.swift，并为 Windows 平台扩展快捷键映射元数据。
 */

const { DayKey } = require('./holidayData');

/** 收入口径枚举 */
const IncomeType = Object.freeze({
  monthly: 'monthly',
  yearly: 'yearly',
  hourly: 'hourly',
});

/** 月薪/年薪日薪计算基准枚举 */
const WageBasis = Object.freeze({
  actualWorkdays: 'actualWorkdays',
  fixed2175: 'fixed2175',
});

/** 状态栏/托盘展示格式枚举 */
const MenuBarFormat = Object.freeze({
  amountOnly: 'amountOnly',
  amountProgress: 'amountProgress',
  amountCountdown: 'amountCountdown',
  iconOnly: 'iconOnly',
});

/** 非工作时段展示方式枚举 */
const OffHoursDisplay = Object.freeze({
  text: 'text',
  iconOnly: 'iconOnly',
});

/** 老板模式全局快捷键预设（存储值与 macOS Swift 版保持 1:1 兼容） */
const BossHotkey = Object.freeze({
  ctrlOptB: 'ctrlOptB',
  ctrlOptCmdH: 'ctrlOptCmdH',
  off: 'off',
});

/** 手动日历标记类型枚举 */
const ManualKind = Object.freeze({
  work: 'work',
  rest: 'rest',
  paidLeave: 'paidLeave',
});

/** 节假日条目类型枚举 */
const HolidayEntryType = Object.freeze({
  holiday: 'holiday',
  workday: 'workday',
});

/** 收入口径中文标签 */
const INCOME_TYPE_LABELS = Object.freeze({
  monthly: '月薪',
  yearly: '年薪',
  hourly: '时薪',
});

/** 计薪基准中文标签 */
const WAGE_BASIS_LABELS = Object.freeze({
  actualWorkdays: '按当月实际计薪工作日',
  fixed2175: '固定 21.75 天',
});

/** 显示格式中文标签 */
const MENU_BAR_FORMAT_LABELS = Object.freeze({
  amountOnly: '仅金额',
  amountProgress: '金额 + 进度',
  amountCountdown: '金额 + 下班倒计时',
  iconOnly: '仅图标',
});

/** 非工作时段显示方式中文标签 */
const OFF_HOURS_DISPLAY_LABELS = Object.freeze({
  text: '显示状态文字',
  iconOnly: '只显示图标',
});

/** 老板模式快捷键 Windows 展示标签 */
const BOSS_HOTKEY_LABELS = Object.freeze({
  ctrlOptB: 'Ctrl+Alt+B',
  ctrlOptCmdH: 'Ctrl+Alt+H',
  off: '不使用',
});

/** 老板模式快捷键对应的 Electron Accelerator 字符串 */
const BOSS_HOTKEY_ACCELERATORS = Object.freeze({
  ctrlOptB: 'CommandOrControl+Alt+B',
  ctrlOptCmdH: 'CommandOrControl+Alt+H',
  off: null,
});

/** 老板模式快捷键完整元数据映射 */
const BossHotkeyMeta = Object.freeze({
  ctrlOptB: Object.freeze({
    value: 'ctrlOptB',
    label: 'Ctrl+Alt+B',
    macLabel: '⌃⌥B',
    accelerator: 'CommandOrControl+Alt+B',
  }),
  ctrlOptCmdH: Object.freeze({
    value: 'ctrlOptCmdH',
    label: 'Ctrl+Alt+H',
    macLabel: '⌃⌥⌘H',
    accelerator: 'CommandOrControl+Alt+H',
  }),
  off: Object.freeze({
    value: 'off',
    label: '不使用',
    macLabel: '不使用',
    accelerator: null,
  }),
});

/** 手动标记类型中文标签 */
const MANUAL_KIND_LABELS = Object.freeze({
  work: '工作日',
  rest: '休息（不计薪）',
  paidLeave: '带薪假（按全天计）',
});

/** 默认里程碑列表（只读冻结） */
const DEFAULT_MILESTONES = Object.freeze([
  Object.freeze({ name: '一杯奶茶', amount: 15 }),
  Object.freeze({ name: '一份外卖', amount: 30 }),
  Object.freeze({ name: '一张电影票', amount: 60 }),
  Object.freeze({ name: '一顿火锅', amount: 150 }),
  Object.freeze({ name: '一顿日料', amount: 800 }),
  Object.freeze({ name: '一双球鞋', amount: 1200 }),
]);

const INCOME_TYPE_SET = new Set(Object.values(IncomeType));
const WAGE_BASIS_SET = new Set(Object.values(WageBasis));
const MENU_BAR_FORMAT_SET = new Set(Object.values(MenuBarFormat));
const OFF_HOURS_DISPLAY_SET = new Set(Object.values(OffHoursDisplay));
const BOSS_HOTKEY_SET = new Set(Object.values(BossHotkey));
const MANUAL_KIND_SET = new Set(Object.values(ManualKind));
const HOLIDAY_ENTRY_TYPE_SET = new Set(Object.values(HolidayEntryType));

const DEFAULT_WORK_WEEKDAYS = [2, 3, 4, 5, 6]; // 1=周日 … 7=周六

/**
 * ASCII 字符串字典序比较函数，用于日期键升序排列（避免 localeCompare 受区域设置影响）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function asciiCompare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 克隆默认里程碑数组，防止调用方误改共享对象。
 * @returns {Array<{ name: string, amount: number }>}
 */
function cloneDefaultMilestones() {
  return DEFAULT_MILESTONES.map((m) => ({ name: m.name, amount: m.amount }));
}

/**
 * 返回全新深拷贝的默认应用设置对象（全部 22 个字段与 Swift AppSettings 1:1 一致）。
 * @returns {object} 默认设置对象
 */
function defaultSettings() {
  return {
    // 薪资
    incomeType: IncomeType.monthly,
    amount: 20000,
    basis: WageBasis.actualWorkdays,
    currency: '¥',
    decimals: 2,

    // 作息（分钟数，0...1439）
    workStart: 9 * 60,
    workEnd: 18 * 60,
    lunchEnabled: true,
    lunchStart: 12 * 60,
    lunchEnd: 12 * 60 + 30 + 60,
    workWeekdays: [...DEFAULT_WORK_WEEKDAYS],
    bigSmallWeek: false,
    bigWeekAnchor: null,

    // 节假日
    manualMarks: [],
    importedHolidays: [],

    // 显示
    menuBarFormat: MenuBarFormat.amountOnly,
    showIcon: true,
    offHoursDisplay: OffHoursDisplay.text,
    bossHotkey: BossHotkey.ctrlOptB,

    // 加油
    milestonesEnabled: true,
    milestones: cloneDefaultMilestones(),
    quotesEnabled: true,
    offWorkNotification: true,
  };
}

/**
 * 归一化 bossHotkey 字段，兼容 macOS 原始值及常见 Windows 别名输入。
 * @param {*} rawValue - 原始字段值
 * @param {string} fallback - 回落默认值
 * @returns {string} 规范化的 BossHotkey 枚举值
 */
function normalizeBossHotkey(rawValue, fallback) {
  if (typeof rawValue !== 'string') return fallback;
  const trimmed = rawValue.trim();
  if (BOSS_HOTKEY_SET.has(trimmed)) return trimmed;

  const compact = trimmed.toLowerCase().replace(/\s+/g, '');
  if (
    compact === 'ctrloptb' ||
    compact === 'ctrlaltb' ||
    compact === 'ctrl+alt+b' ||
    compact === 'commandorcontrol+alt+b' ||
    compact === '⌃⌥b'
  ) {
    return BossHotkey.ctrlOptB;
  }
  if (
    compact === 'ctrloptcmdh' ||
    compact === 'ctrlalth' ||
    compact === 'ctrl+alt+h' ||
    compact === 'commandorcontrol+alt+h' ||
    compact === '⌃⌥⌘h'
  ) {
    return BossHotkey.ctrlOptCmdH;
  }
  if (compact === 'off' || compact === 'none' || compact === '不使用') {
    return BossHotkey.off;
  }
  return fallback;
}

/**
 * 校验并归一化每周工作日数组；保留合法空数组 []，非数组或含非法元素时整体回落默认值。
 * @param {*} rawValue
 * @returns {number[]}
 */
function decodeWorkWeekdays(rawValue) {
  if (!Array.isArray(rawValue)) return [...DEFAULT_WORK_WEEKDAYS];
  const unique = new Set();
  for (const item of rawValue) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 7) {
      return [...DEFAULT_WORK_WEEKDAYS];
    }
    unique.add(item);
  }
  return Array.from(unique).sort((a, b) => a - b);
}

/**
 * 校验并过滤手动标记数组。
 * @param {*} rawValue
 * @returns {Array<{ date: string, kind: string, note: string }>}
 */
function decodeManualMarks(rawValue) {
  if (!Array.isArray(rawValue)) return [];
  const out = [];
  for (const item of rawValue) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof item.date !== 'string') continue;
    if (typeof item.kind !== 'string' || !MANUAL_KIND_SET.has(item.kind)) continue;
    const note = typeof item.note === 'string' ? item.note : '';
    out.push({ date: item.date, kind: item.kind, note });
  }
  return out;
}

/**
 * 校验并过滤导入的节假日数组。
 * @param {*} rawValue
 * @returns {Array<{ date: string, type: string, name: string }>}
 */
function decodeImportedHolidays(rawValue) {
  if (!Array.isArray(rawValue)) return [];
  const out = [];
  for (const item of rawValue) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof item.date !== 'string') continue;
    if (typeof item.type !== 'string' || !HOLIDAY_ENTRY_TYPE_SET.has(item.type)) continue;
    if (typeof item.name !== 'string') continue;
    out.push({ date: item.date, type: item.type, name: item.name });
  }
  return out;
}

/**
 * 校验并过滤里程碑数组；非数组时回落默认里程碑，数组内支持保留合法空数组 []。
 * @param {*} rawValue
 * @returns {Array<{ name: string, amount: number }>}
 */
function decodeMilestones(rawValue) {
  if (!Array.isArray(rawValue)) return cloneDefaultMilestones();
  const out = [];
  for (const item of rawValue) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof item.name !== 'string') continue;
    if (typeof item.amount !== 'number' || !Number.isFinite(item.amount)) continue;
    out.push({ name: item.name, amount: item.amount });
  }
  return out;
}

/**
 * 逐字段容错解码设置对象：缺字段、类型不匹配或非法枚举值均只回落对应字段的默认值。
 * @param {*} raw - 任意解析后的原始对象
 * @returns {object} 合法完整的 AppSettings 对象
 */
function decodeSettings(raw) {
  const def = defaultSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return def;
  }

  return {
    incomeType:
      typeof raw.incomeType === 'string' && INCOME_TYPE_SET.has(raw.incomeType)
        ? raw.incomeType
        : def.incomeType,
    amount:
      typeof raw.amount === 'number' && Number.isFinite(raw.amount)
        ? raw.amount
        : def.amount,
    basis:
      typeof raw.basis === 'string' && WAGE_BASIS_SET.has(raw.basis)
        ? raw.basis
        : def.basis,
    currency: typeof raw.currency === 'string' ? raw.currency : def.currency,
    decimals:
      typeof raw.decimals === 'number' && Number.isInteger(raw.decimals)
        ? raw.decimals
        : def.decimals,

    workStart:
      typeof raw.workStart === 'number' && Number.isInteger(raw.workStart)
        ? raw.workStart
        : def.workStart,
    workEnd:
      typeof raw.workEnd === 'number' && Number.isInteger(raw.workEnd)
        ? raw.workEnd
        : def.workEnd,
    lunchEnabled:
      typeof raw.lunchEnabled === 'boolean' ? raw.lunchEnabled : def.lunchEnabled,
    lunchStart:
      typeof raw.lunchStart === 'number' && Number.isInteger(raw.lunchStart)
        ? raw.lunchStart
        : def.lunchStart,
    lunchEnd:
      typeof raw.lunchEnd === 'number' && Number.isInteger(raw.lunchEnd)
        ? raw.lunchEnd
        : def.lunchEnd,
    workWeekdays: decodeWorkWeekdays(raw.workWeekdays),
    bigSmallWeek:
      typeof raw.bigSmallWeek === 'boolean' ? raw.bigSmallWeek : def.bigSmallWeek,
    bigWeekAnchor: typeof raw.bigWeekAnchor === 'string' ? raw.bigWeekAnchor : null,

    manualMarks: decodeManualMarks(raw.manualMarks),
    importedHolidays: decodeImportedHolidays(raw.importedHolidays),

    menuBarFormat:
      typeof raw.menuBarFormat === 'string' && MENU_BAR_FORMAT_SET.has(raw.menuBarFormat)
        ? raw.menuBarFormat
        : def.menuBarFormat,
    showIcon: typeof raw.showIcon === 'boolean' ? raw.showIcon : def.showIcon,
    offHoursDisplay:
      typeof raw.offHoursDisplay === 'string' && OFF_HOURS_DISPLAY_SET.has(raw.offHoursDisplay)
        ? raw.offHoursDisplay
        : def.offHoursDisplay,
    bossHotkey: normalizeBossHotkey(raw.bossHotkey, def.bossHotkey),

    milestonesEnabled:
      typeof raw.milestonesEnabled === 'boolean'
        ? raw.milestonesEnabled
        : def.milestonesEnabled,
    milestones: decodeMilestones(raw.milestones),
    quotesEnabled:
      typeof raw.quotesEnabled === 'boolean' ? raw.quotesEnabled : def.quotesEnabled,
    offWorkNotification:
      typeof raw.offWorkNotification === 'boolean'
        ? raw.offWorkNotification
        : def.offWorkNotification,
  };
}

/**
 * 从 JSON 字符串或 Buffer 容错解析设置对象；JSON 语法损坏时返回默认设置。
 * @param {string|Buffer} jsonText - 设置 JSON 文本或 Buffer
 * @returns {object} 合法完整的 AppSettings 对象
 */
function parseSettingsJson(jsonText) {
  let text = jsonText;
  if (Buffer.isBuffer(jsonText)) {
    text = jsonText.toString('utf8');
  }
  if (typeof text !== 'string') return defaultSettings();
  try {
    const parsed = JSON.parse(text);
    return decodeSettings(parsed);
  } catch {
    return defaultSettings();
  }
}

/**
 * 计算月薪口径下的月收入（monthly -> amount, yearly -> amount / 12, hourly -> 0）。
 * @param {object} settings - AppSettings 对象
 * @returns {number} 月收入金额
 */
function monthlyAmount(settings) {
  switch (settings.incomeType) {
    case IncomeType.monthly:
      return settings.amount;
    case IncomeType.yearly:
      return settings.amount / 12;
    case IncomeType.hourly:
    default:
      return 0;
  }
}

/**
 * 纯函数：切换大小周开关；首次打开且尚未设置锚点时，自动将本周设为大周（返回新对象，不修改入参）。
 * @param {object} settings - 原设置对象
 * @param {boolean} on - 是否开启大小周
 * @param {Date|number} [today=new Date()] - 当前日期
 * @returns {object} 更新后的新设置对象
 */
function setBigSmallWeek(settings, on, today = new Date()) {
  const enabled = Boolean(on);
  let anchor = settings.bigWeekAnchor ?? null;
  if (enabled && anchor == null) {
    anchor = DayKey.key(DayKey.mondayOf(today));
  }
  return {
    ...settings,
    bigSmallWeek: enabled,
    bigWeekAnchor: anchor,
  };
}

/**
 * 纯函数：增、改或删除指定日期键的手动标记，并按 date 升序返回新设置对象。
 * @param {object} settings - 原设置对象
 * @param {{ date?: string, kind: string, note?: string } | null} mark - 标记对象；传 null/undefined 表示清除
 * @param {string} key - 目标日期键 "yyyy-MM-dd"
 * @returns {object} 更新后的新设置对象
 */
function setMark(settings, mark, key) {
  const nextMarks = (Array.isArray(settings.manualMarks) ? settings.manualMarks : [])
    .filter((m) => m.date !== key)
    .map((m) => ({ ...m }));

  if (mark) {
    nextMarks.push({
      date: typeof mark.date === 'string' && mark.date.length > 0 ? mark.date : key,
      kind: mark.kind,
      note: typeof mark.note === 'string' ? mark.note : '',
    });
    nextMarks.sort((a, b) => asciiCompare(a.date, b.date));
  }

  return {
    ...settings,
    manualMarks: nextMarks,
  };
}

/**
 * 解析导入的节假日 JSON 数据。
 * 顶层非数组、JSON 语法错误或任一条目字段类型/枚举非法时抛出 Error；
 * 结构合法但日期本身无效（如 "2028-02-30"）的条目会被静默过滤。
 * @param {string|Buffer} input - JSON 字符串或 Buffer
 * @returns {Array<{ date: string, type: string, name: string }>} 有效节假日条目数组
 */
function parseHolidayImport(input) {
  let text = input;
  if (Buffer.isBuffer(input)) {
    text = input.toString('utf8');
  }
  if (typeof text !== 'string') {
    throw new TypeError('节假日导入数据必须是 JSON 字符串或 Buffer');
  }

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('节假日导入 JSON 顶层必须是数组');
  }

  const validEntries = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const item = parsed[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`第 ${i} 条节假日记录必须是对象`);
    }
    if (typeof item.date !== 'string') {
      throw new Error(`第 ${i} 条节假日记录缺少有效的 date 字符串`);
    }
    if (typeof item.type !== 'string' || !HOLIDAY_ENTRY_TYPE_SET.has(item.type)) {
      throw new Error(`第 ${i} 条节假日记录的 type 非法: ${String(item.type)}`);
    }
    if (typeof item.name !== 'string') {
      throw new Error(`第 ${i} 条节假日记录缺少有效的 name 字符串`);
    }
    if (DayKey.isValid(item.date)) {
      validEntries.push({
        date: item.date,
        type: item.type,
        name: item.name,
      });
    }
  }
  return validEntries;
}

/**
 * 合并旧的与新导入的节假日条目：同一天以新导入条目为准，结果按日期 ASCII 升序排列。
 * @param {Array<{ date: string, type: string, name: string }>} oldList - 旧条目数组
 * @param {Array<{ date: string, type: string, name: string }>} newList - 新条目数组
 * @returns {Array<{ date: string, type: string, name: string }>} 合并排序后的新数组
 */
function mergeHolidayImport(oldList, newList) {
  const map = new Map();
  for (const entry of Array.isArray(oldList) ? oldList : []) {
    if (entry && typeof entry.date === 'string') {
      map.set(entry.date, { date: entry.date, type: entry.type, name: entry.name });
    }
  }
  for (const entry of Array.isArray(newList) ? newList : []) {
    if (entry && typeof entry.date === 'string') {
      map.set(entry.date, { date: entry.date, type: entry.type, name: entry.name });
    }
  }
  return Array.from(map.values()).sort((a, b) => asciiCompare(a.date, b.date));
}

module.exports = {
  IncomeType,
  WageBasis,
  MenuBarFormat,
  OffHoursDisplay,
  BossHotkey,
  ManualKind,
  HolidayEntryType,
  INCOME_TYPE_LABELS,
  WAGE_BASIS_LABELS,
  MENU_BAR_FORMAT_LABELS,
  OFF_HOURS_DISPLAY_LABELS,
  BOSS_HOTKEY_LABELS,
  BOSS_HOTKEY_ACCELERATORS,
  BossHotkeyMeta,
  MANUAL_KIND_LABELS,
  DEFAULT_MILESTONES,
  defaultSettings,
  decodeSettings,
  parseSettingsJson,
  monthlyAmount,
  setBigSmallWeek,
  setMark,
  parseHolidayImport,
  mergeHolidayImport,
};
