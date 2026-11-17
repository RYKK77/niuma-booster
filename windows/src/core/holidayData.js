'use strict';

/**
 * 日期键与内置节假日模块。
 * 所有日期键均以本地日历 "yyyy-MM-dd" 表示，严禁使用 toISOString() 避免跨零点时区偏移。
 */

/**
 * 将输入参数规范化为 Date 实例。
 * @param {Date|number} date - Date 实例或 epoch 毫秒时间戳
 * @returns {Date} 规范化后的 Date 实例
 */
function toDateObject(date) {
  return date instanceof Date ? date : new Date(date);
}

/**
 * "yyyy-MM-dd" 日期键工具集合。只做纯日期运算，不经过时区转换。
 */
const DayKey = Object.freeze({
  /**
   * 构造 "yyyy-MM-dd" 格式字符串。
   * @param {number} year - 年份（四位整数）
   * @param {number} month - 月份（1..12）
   * @param {number} day - 日期（1..31）
   * @returns {string} 格式化后的日期键
   */
  make(year, month, day) {
    const y = String(year).padStart(4, '0');
    const m = String(month).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    return `${y}-${m}-${d}`;
  },

  /**
   * 使用本地日历的年月日分量生成日期键（东八区早上 8 点前不能使用 UTC/ISO）。
   * @param {Date|number} date - Date 实例或毫秒时间戳
   * @returns {string} "yyyy-MM-dd" 日期键
   */
  key(date) {
    const d = toDateObject(date);
    return DayKey.make(d.getFullYear(), d.getMonth() + 1, d.getDate());
  },

  /**
   * 严格解析 "yyyy-MM-dd" 日期键；拒绝两位年份或非数字后缀。
   * @param {string} key - 日期键字符串
   * @returns {{ year: number, month: number, day: number } | null} 年月日对象，格式非法时返回 null
   */
  parse(key) {
    if (typeof key !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
  },

  /**
   * 校验日期键是否为公历真实存在的有效日期（含平闰年及大小月校验）。
   * 使用 setUTCFullYear 避免 JS 对 0..99 年份的 1900+y 隐式映射。
   * @param {string} key - 日期键字符串
   * @returns {boolean} 是否为有效日期
   */
  isValid(key) {
    const c = DayKey.parse(key);
    if (!c) return false;
    const d = new Date(0);
    d.setUTCFullYear(c.year, c.month - 1, c.day);
    d.setUTCHours(0, 0, 0, 0);
    return (
      d.getUTCFullYear() === c.year &&
      d.getUTCMonth() + 1 === c.month &&
      d.getUTCDate() === c.day
    );
  },

  /**
   * 将有效日期键转换为本地时区当日零点 Date 实例。
   * @param {string} key - 日期键字符串
   * @returns {Date | null} 本地零点 Date 实例，无效日期键返回 null
   */
  toLocalDate(key) {
    const c = DayKey.parse(key);
    if (!c || !DayKey.isValid(key)) return null;
    const d = new Date(0);
    d.setFullYear(c.year, c.month - 1, c.day);
    d.setHours(0, 0, 0, 0);
    return d;
  },

  /**
   * 获取指定日期所在周的周一本地零点（按 1=周日 … 7=周六 规则，使用本地日历分量加减免疫夏令时）。
   * @param {Date|number} date - 任意日期或毫秒时间戳
   * @returns {Date} 所在周周一的本地零点 Date
   */
  mondayOf(date) {
    const src = toDateObject(date);
    const day = new Date(src.getFullYear(), src.getMonth(), src.getDate(), 0, 0, 0, 0);
    const wd = day.getDay() + 1; // 1=周日 ... 7=周六
    const offset = -((wd + 5) % 7);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset, 0, 0, 0, 0);
  },

  /**
   * 在 UTC 纯日历上展开闭区间 [from, to] 的所有日期键。
   * @param {string} from - 起始日期键
   * @param {string} to - 结束日期键
   * @returns {string[]} 闭区间日期键数组；起止无效或 from > to 返回空数组
   */
  range(from, to) {
    const sc = DayKey.parse(from);
    const ec = DayKey.parse(to);
    if (!sc || !ec || !DayKey.isValid(from) || !DayKey.isValid(to)) return [];

    const s = new Date(0);
    s.setUTCFullYear(sc.year, sc.month - 1, sc.day);
    s.setUTCHours(0, 0, 0, 0);

    const e = new Date(0);
    e.setUTCFullYear(ec.year, ec.month - 1, ec.day);
    e.setUTCHours(0, 0, 0, 0);

    if (s.getTime() > e.getTime()) return [];

    const out = [];
    const d = new Date(s.getTime());
    while (d.getTime() <= e.getTime()) {
      out.push(DayKey.make(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  },
});

/**
 * 内置的国务院放假安排通知原始列表：[名称, 放假开始, 放假结束, 调休上班日数组]
 * 2026：国办发明电〔2025〕7号
 * 2027：国办发明电〔2026〕10号
 */
const NOTICES = [
  // 2026 年
  ['元旦', '2026-01-01', '2026-01-03', ['2026-01-04']],
  ['春节', '2026-02-15', '2026-02-23', ['2026-02-14', '2026-02-28']],
  ['清明', '2026-04-04', '2026-04-06', []],
  ['劳动节', '2026-05-01', '2026-05-05', ['2026-05-09']],
  ['端午', '2026-06-19', '2026-06-21', []],
  ['中秋', '2026-09-25', '2026-09-27', []],
  ['国庆', '2026-10-01', '2026-10-07', ['2026-09-20', '2026-10-10']],
  // 2027 年
  ['元旦', '2027-01-01', '2027-01-03', []],
  ['春节', '2027-02-05', '2027-02-13', ['2027-01-31', '2027-02-14']],
  ['清明', '2027-04-03', '2027-04-05', []],
  ['劳动节', '2027-05-01', '2027-05-05', ['2027-05-08']],
  ['端午', '2027-06-09', '2027-06-09', []],
  ['中秋', '2027-09-15', '2027-09-15', []],
  ['国庆', '2027-10-01', '2027-10-07', ['2027-09-26', '2027-10-09']],
];

/**
 * 展开通知列表为只读的节假日条目数组。
 * @returns {ReadonlyArray<Readonly<{ date: string, type: 'holiday'|'workday', name: string }>>}
 */
function buildBuiltinEntries() {
  const out = [];
  for (const [name, start, end, makeups] of NOTICES) {
    for (const key of DayKey.range(start, end)) {
      out.push(Object.freeze({ date: key, type: 'holiday', name }));
    }
    for (const key of makeups) {
      out.push(Object.freeze({ date: key, type: 'workday', name }));
    }
  }
  return Object.freeze(out);
}

/**
 * 内置的 2026–2027 国务院放假与调休安排（只读冻结）。
 */
const BuiltinHolidays = Object.freeze({
  years: Object.freeze([2026, 2027]),
  entries: buildBuiltinEntries(),
});

module.exports = {
  DayKey,
  BuiltinHolidays,
};
