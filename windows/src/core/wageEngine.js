'use strict';

/**
 * 工作日历与计薪核心引擎模块。
 * 1:1 移植 Sources/NiumaCore/WageEngine.swift，包含 4 级优先级判定、大小周、跨夜班、午休钳位与 Snapshot 序列化。
 */

const { DayKey, BuiltinHolidays } = require('./holidayData');
const { IncomeType, WageBasis, ManualKind, HolidayEntryType, monthlyAmount } = require('./settings');

/** 日期类型枚举 */
const DayKind = Object.freeze({
  workday: 'workday',
  makeupWorkday: 'makeupWorkday',
  weekend: 'weekend',
  holiday: 'holiday',
  paidLeave: 'paidLeave',
  manualRest: 'manualRest',
  manualWork: 'manualWork',
});

/** 当前班次阶段枚举 */
const Phase = Object.freeze({
  beforeWork: 'beforeWork',
  working: 'working',
  lunch: 'lunch',
  afterWork: 'afterWork',
  rest: 'rest',
  paidLeave: 'paidLeave',
});

/**
 * 将 Date 或毫秒时间戳转换为 Date 实例。
 * @param {Date|number} dateOrMs
 * @returns {Date}
 */
function toDateObject(dateOrMs) {
  return dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
}

/**
 * 取给定日期在本地时区的当日零点。
 * @param {Date|number} dateOrMs
 * @returns {Date}
 */
function startOfDay(dateOrMs) {
  const d = toDateObject(dateOrMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/**
 * 在本地零点日期上叠加分钟偏移（按本地日历挂钟构造）。
 * @param {Date} day0 - 本地零点日期
 * @param {number} minutes - 当日起始分钟数
 * @returns {Date}
 */
function atMinutes(day0, minutes) {
  return new Date(day0.getFullYear(), day0.getMonth(), day0.getDate(), 0, minutes, 0, 0);
}

/**
 * 本地日历加一天（保持时分秒毫秒不变，免疫夏令时）。
 * @param {Date} d
 * @returns {Date}
 */
function plusDay(d) {
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + 1,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds()
  );
}

/**
 * 构造普通可枚举的 DayInfo 对象，保证 IPC 序列化后不丢失 isPaid/accrues 字段。
 * @param {string} kind - DayKind 枚举值
 * @param {string | null} [name=null] - 节日名称、手动备注或 "大周"
 * @returns {{ kind: string, name: string | null, isPaid: boolean, accrues: boolean }}
 */
function makeDayInfo(kind, name = null) {
  const isPaid =
    kind === DayKind.workday ||
    kind === DayKind.makeupWorkday ||
    kind === DayKind.paidLeave ||
    kind === DayKind.manualWork;
  const accrues =
    kind === DayKind.workday ||
    kind === DayKind.makeupWorkday ||
    kind === DayKind.manualWork;
  return {
    kind,
    name: name ?? null,
    isPaid,
    accrues,
  };
}

/**
 * 工作日历：负责按 4 级优先级（手动标记 > 导入 JSON > 内置国务院安排 > 每周作息含大小周）判定任意日期。
 */
class WorkCalendar {
  /**
   * @param {object} settings - AppSettings 对象
   * @param {Array<{ date: string, type: string, name: string }>} [builtin=BuiltinHolidays.entries] - 内置节假日列表
   */
  constructor(settings, builtin = BuiltinHolidays.entries) {
    this.settings = settings;

    this.builtinMap = new Map();
    for (const item of Array.isArray(builtin) ? builtin : []) {
      if (item && typeof item.date === 'string') {
        this.builtinMap.set(item.date, item);
      }
    }

    this.importedMap = new Map();
    for (const item of Array.isArray(settings.importedHolidays) ? settings.importedHolidays : []) {
      if (item && typeof item.date === 'string') {
        this.importedMap.set(item.date, item);
      }
    }

    this.manualMap = new Map();
    for (const item of Array.isArray(settings.manualMarks) ? settings.manualMarks : []) {
      if (item && typeof item.date === 'string') {
        this.manualMap.set(item.date, item);
      }
    }

    this.weekdays = new Set(Array.isArray(settings.workWeekdays) ? settings.workWeekdays : []);
    this.bigSmall = Boolean(settings.bigSmallWeek);

    const anchorDate =
      typeof settings.bigWeekAnchor === 'string'
        ? DayKey.toLocalDate(settings.bigWeekAnchor)
        : null;
    this.bigAnchor = anchorDate ? WorkCalendar.monday(anchorDate) : null;
  }

  /**
   * 获取指定日期所在周的周一本地零点。
   * @param {Date|number} date
   * @returns {Date}
   */
  static monday(date) {
    return DayKey.mondayOf(date);
  }

  /**
   * 获取日期对应的本地 "yyyy-MM-dd" 键。
   * @param {Date|number} date
   * @returns {string}
   */
  key(date) {
    return DayKey.key(date);
  }

  /**
   * 查询指定日期的工作日信息（4 级优先级）。
   * @param {Date|number} date
   * @returns {{ kind: string, name: string | null, isPaid: boolean, accrues: boolean }}
   */
  info(date) {
    const d = toDateObject(date);
    const k = this.key(d);

    const manual = this.manualMap.get(k);
    if (manual) {
      const note = typeof manual.note === 'string' && manual.note.length > 0 ? manual.note : null;
      switch (manual.kind) {
        case ManualKind.work:
          return makeDayInfo(DayKind.manualWork, note);
        case ManualKind.rest:
          return makeDayInfo(DayKind.manualRest, note);
        case ManualKind.paidLeave:
          return makeDayInfo(DayKind.paidLeave, note);
        default:
          break;
      }
    }

    const entry = this.importedMap.get(k) ?? this.builtinMap.get(k);
    if (entry) {
      return makeDayInfo(
        entry.type === HolidayEntryType.holiday ? DayKind.holiday : DayKind.makeupWorkday,
        entry.name
      );
    }

    const wd = d.getDay() + 1; // 1=周日 … 7=周六
    if (this.weekdays.has(wd)) {
      return makeDayInfo(DayKind.workday, null);
    }
    if (this.bigSmall && wd === 7 && this.isBigWeek(d)) {
      return makeDayInfo(DayKind.workday, '大周');
    }
    return makeDayInfo(DayKind.weekend, null);
  }

  /**
   * 查询内置或导入中的节假日条目（不含手动标记），供设置页月历与编辑器使用。
   * @param {string} k - "yyyy-MM-dd"
   * @returns {{ date: string, type: string, name: string } | null}
   */
  noticeEntry(k) {
    return this.importedMap.get(k) ?? this.builtinMap.get(k) ?? null;
  }

  /**
   * 查询指定日期键的手动标记。
   * @param {string} k - "yyyy-MM-dd"
   * @returns {{ date: string, kind: string, note: string } | null}
   */
  manualMark(k) {
    return this.manualMap.get(k) ?? null;
  }

  /**
   * 判断指定日期所在周是否为「大周」（使用 UTC 日戳差计算周数差，免疫夏令时）。
   * @param {Date|number} date
   * @returns {boolean}
   */
  isBigWeek(date) {
    if (!this.bigAnchor) return false;
    const mon = WorkCalendar.monday(date);
    const utcAnchor = Date.UTC(
      this.bigAnchor.getFullYear(),
      this.bigAnchor.getMonth(),
      this.bigAnchor.getDate()
    );
    const utcMon = Date.UTC(mon.getFullYear(), mon.getMonth(), mon.getDate());
    const days = Math.round((utcMon - utcAnchor) / 86400000);
    const weeks = Math.round(days / 7);
    return ((weeks % 2) + 2) % 2 === 0;
  }

  /**
   * 返回指定日期所在月份全部日期的本地零点数组。
   * @param {Date|number} date
   * @returns {Date[]}
   */
  daysInMonth(date) {
    const d = toDateObject(date);
    const year = d.getFullYear();
    const month = d.getMonth();
    const count = new Date(year, month + 1, 0).getDate();
    const out = [];
    for (let day = 1; day <= count; day += 1) {
      out.push(new Date(year, month, day, 0, 0, 0, 0));
    }
    return out;
  }

  /**
   * 返回指定日期所在月份的所有计薪日（每天本地零点）。
   * @param {Date|number} date
   * @returns {Date[]}
   */
  paidDays(date) {
    return this.daysInMonth(date).filter((d) => this.info(d).isPaid);
  }

  /**
   * paidDays 的别名（对齐 Swift 方法名 paidDays(inMonthOf:)）。
   * @param {Date|number} date
   * @returns {Date[]}
   */
  paidDaysInMonthOf(date) {
    return this.paidDays(date);
  }
}

/**
 * 实时计薪引擎：计算班次窗口、有效工时、跨夜归属日与当前时刻完整计薪快照。
 */
class WageEngine {
  /**
   * @param {object} settings - AppSettings 对象
   * @param {WorkCalendar} [workCalendar] - 可选外部传入 WorkCalendar 实例
   */
  constructor(settings, workCalendar) {
    this.settings = settings;
    this.workCalendar =
      workCalendar instanceof WorkCalendar ? workCalendar : new WorkCalendar(settings);
  }

  /**
   * 是否为跨夜班（下班分钟数严格小于上班分钟数）。
   * @returns {boolean}
   */
  get isOvernight() {
    return this.settings.workEnd < this.settings.workStart;
  }

  /**
   * 计算指定班次日（本地零点）的上下班与午休窗口。跨夜班归属开始日。
   * @param {Date|number} day
   * @returns {{ start: Date, end: Date, lunchStart: Date | null, lunchEnd: Date | null, effectiveSeconds: number }}
   */
  shift(day) {
    const day0 = startOfDay(day);
    const start = atMinutes(day0, this.settings.workStart);
    let end = atMinutes(day0, this.settings.workEnd);
    if (this.settings.workEnd < this.settings.workStart) {
      end = plusDay(end);
    }

    let ls = null;
    let le = null;
    if (
      this.settings.lunchEnabled &&
      this.settings.lunchStart !== this.settings.lunchEnd &&
      end.getTime() > start.getTime()
    ) {
      const s0 = atMinutes(day0, this.settings.lunchStart);
      let e0 = atMinutes(day0, this.settings.lunchEnd);
      while (e0.getTime() <= s0.getTime()) {
        e0 = plusDay(e0);
      }

      const candidates = [
        [s0, e0],
        [plusDay(s0), plusDay(e0)],
      ];
      let best = null;
      let bestLen = 0;
      for (const [s, e] of candidates) {
        const csMs = Math.max(s.getTime(), start.getTime());
        const ceMs = Math.min(e.getTime(), end.getTime());
        const len = (ceMs - csMs) / 1000;
        if (len > bestLen) {
          bestLen = len;
          best = [new Date(csMs), new Date(ceMs)];
        }
      }
      if (best) {
        ls = best[0];
        le = best[1];
      }
    }

    let eff = (end.getTime() - start.getTime()) / 1000;
    if (ls && le) {
      eff -= (le.getTime() - ls.getTime()) / 1000;
    }

    return {
      start,
      end,
      lunchStart: ls,
      lunchEnd: le,
      effectiveSeconds: Math.max(0, eff),
    };
  }

  /**
   * 计算给定时刻所属的班次日（跨夜班未到次日下班时间时仍归属昨日）。
   * @param {Date|number} now
   * @returns {Date} 班次日零点 Date
   */
  shiftDay(now) {
    const nowDate = toDateObject(now);
    const today = startOfDay(nowDate);
    if (this.isOvernight) {
      const yesterday = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate() - 1,
        0,
        0,
        0,
        0
      );
      if (nowDate.getTime() < this.shift(yesterday).end.getTime()) {
        return yesterday;
      }
    }
    return today;
  }

  /**
   * 计算某班次在指定时刻前已累计的有效工作秒数（剔除午休已过部分）。
   * @param {{ start: Date, end: Date, lunchStart: Date | null, lunchEnd: Date | null }} sh
   * @param {Date|number} now
   * @returns {number}
   */
  workedSeconds(sh, now) {
    const nowMs = toDateObject(now).getTime();
    const startMs = sh.start.getTime();
    const endMs = sh.end.getTime();
    const clampedMs = Math.min(Math.max(nowMs, startMs), endMs);

    let worked = (clampedMs - startMs) / 1000;
    if (sh.lunchStart && sh.lunchEnd) {
      const lsMs = sh.lunchStart.getTime();
      const leMs = sh.lunchEnd.getTime();
      worked -= Math.max(0, (Math.min(clampedMs, leMs) - lsMs) / 1000);
    }
    return Math.max(0, worked);
  }

  /**
   * 计算指定日期所在月份每个计薪日的日薪（时薪口径按当日班次有效工时折算）。
   * @param {Date|number} day
   * @returns {number}
   */
  dailyWage(day) {
    switch (this.settings.incomeType) {
      case IncomeType.hourly:
        return (this.settings.amount * this.shift(day).effectiveSeconds) / 3600;
      case IncomeType.monthly:
      case IncomeType.yearly: {
        const mAmount = monthlyAmount(this.settings);
        if (this.settings.basis === WageBasis.fixed2175) {
          return mAmount / 21.75;
        }
        const n = this.workCalendar.paidDays(day).length;
        return n > 0 ? mAmount / n : 0;
      }
      default:
        return 0;
    }
  }

  /**
   * 生成给定时刻的完整实时计薪快照。
   * @param {Date|number} [now=new Date()]
   * @returns {object} Snapshot 对象（内部日期字段保持为原生 Date 实例）
   */
  snapshot(now = new Date()) {
    const nowDate = toDateObject(now);
    const day = this.shiftDay(nowDate);
    const info = this.workCalendar.info(day);
    const sh = this.shift(day);
    const paid = this.workCalendar.paidDays(day);

    let rate = 0;
    if (this.settings.incomeType === IncomeType.hourly) {
      rate = (this.settings.amount * sh.effectiveSeconds) / 3600;
    } else {
      const mAmount = monthlyAmount(this.settings);
      rate =
        this.settings.basis === WageBasis.fixed2175
          ? mAmount / 21.75
          : paid.length === 0
            ? 0
            : mAmount / paid.length;
    }

    const eff = sh.effectiveSeconds;
    const perSecond = eff > 0 ? rate / eff : 0;
    const hourly = eff > 0 ? rate / (eff / 3600) : 0;

    let phase;
    let earned = 0;
    let progress = 0;
    let toStart = null;
    let toEnd = null;

    const nowMs = nowDate.getTime();
    const startMs = sh.start.getTime();
    const endMs = sh.end.getTime();

    if (info.accrues) {
      const worked = this.workedSeconds(sh, nowDate);
      if (nowMs < startMs) {
        phase = Phase.beforeWork;
        toStart = (startMs - nowMs) / 1000;
        toEnd = (endMs - nowMs) / 1000;
      } else if (nowMs >= endMs) {
        phase = Phase.afterWork;
      } else if (
        sh.lunchStart &&
        sh.lunchEnd &&
        nowMs >= sh.lunchStart.getTime() &&
        nowMs < sh.lunchEnd.getTime()
      ) {
        phase = Phase.lunch;
        toEnd = (endMs - nowMs) / 1000;
      } else {
        phase = Phase.working;
        toEnd = (endMs - nowMs) / 1000;
      }

      if (eff > 0) {
        earned = Math.min(rate, perSecond * worked);
        progress = Math.min(1, worked / eff);
      } else {
        earned = nowMs >= endMs ? rate : 0;
        progress = nowMs >= endMs ? 1 : 0;
      }
    } else if (info.kind === DayKind.paidLeave) {
      phase = Phase.paidLeave;
      earned = rate;
      progress = 1;
    } else {
      phase = Phase.rest;
    }

    const dayMs = day.getTime();
    let prior = 0;
    for (const p of paid) {
      if (p.getTime() < dayMs) prior += 1;
    }

    return {
      now: nowDate,
      shiftDay: day,
      day: info,
      phase,
      shift: sh,
      earnedToday: earned,
      dailyWage: rate,
      perSecond,
      hourly,
      progress,
      secondsToStart: toStart,
      secondsToEnd: toEnd,
      monthTotal: prior * rate + earned,
      paidDayIndex: prior + (info.isPaid ? 1 : 0),
      paidDaysInMonth: paid.length,
    };
  }
}

/**
 * 将 Snapshot 内的原生 Date 字段转为 epoch 毫秒时间戳（null 保持 null），供 Electron IPC 广播与渲染层直接计算。
 * @param {object} snapshot - WageEngine.snapshot() 返回对象
 * @returns {object} 可序列化快照对象
 */
function serializeSnapshot(snapshot) {
  const toMs = (v) => {
    if (v == null) return null;
    return v instanceof Date ? v.getTime() : Number(v);
  };
  return {
    ...snapshot,
    now: toMs(snapshot.now),
    shiftDay: toMs(snapshot.shiftDay),
    shift: {
      start: toMs(snapshot.shift.start),
      end: toMs(snapshot.shift.end),
      lunchStart: toMs(snapshot.shift.lunchStart),
      lunchEnd: toMs(snapshot.shift.lunchEnd),
      effectiveSeconds: snapshot.shift.effectiveSeconds,
    },
  };
}

module.exports = {
  DayKind,
  Phase,
  WorkCalendar,
  WageEngine,
  makeDayInfo,
  serializeSnapshot,
};
