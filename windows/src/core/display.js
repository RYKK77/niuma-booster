'use strict';

/**
 * 金额格式化、时长格式化、状态栏文案、里程碑与加油语录模块。
 * 1:1 移植 Sources/NiumaCore/Display.swift 及 PanelView.swift 纯文案辅助逻辑。
 */

const { MenuBarFormat, OffHoursDisplay } = require('./settings');
const { DayKind, Phase } = require('./wageEngine');

/**
 * 模块级 Intl.NumberFormat 缓存（按 0..4 小数位缓存，en-US 千分位 + halfExpand 舍入）。
 * @type {Map<number, Intl.NumberFormat>}
 */
const NUMBER_FORMATTERS = new Map();

/**
 * 将小数位数钳位到 [0, 4] 整数区间。
 * @param {*} raw - 原始小数位数
 * @param {number} [fallback=2] - 无效输入回落值
 * @returns {number}
 */
function clampDecimals(raw, fallback = 2) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, Math.min(4, Math.trunc(raw)));
}

/**
 * 获取或创建指定小数位数的 NumberFormat 实例。
 * @param {number} decimals - 已钳位到 0..4 的整数
 * @returns {Intl.NumberFormat}
 */
function getFormatter(decimals) {
  let fmt = NUMBER_FORMATTERS.get(decimals);
  if (!fmt) {
    fmt = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: true,
      roundingMode: 'halfExpand',
    });
    NUMBER_FORMATTERS.set(decimals, fmt);
  }
  return fmt;
}

/**
 * 将 Date 或 epoch 毫秒时间戳统一转换为 Date 实例。
 * @param {Date|number|string} value
 * @returns {Date}
 */
function toDateObject(value) {
  if (value instanceof Date) return value;
  return new Date(value);
}

/**
 * 金额格式化工具：使用 halfUp（halfExpand）舍入与千分位分隔符，并支持老板模式遮罩。
 */
class Money {
  /**
   * 支持 new Money(settings) 或 new Money(currency, decimals) 两种构造方式。
   * @param {object|string} currencyOrSettings - 设置对象或货币符号字符串
   * @param {number} [decimals=2] - 小数位数（钳位至 0..4）
   */
  constructor(currencyOrSettings, decimals = 2) {
    if (currencyOrSettings && typeof currencyOrSettings === 'object') {
      this.currency =
        typeof currencyOrSettings.currency === 'string' ? currencyOrSettings.currency : '¥';
      this.decimals = clampDecimals(currencyOrSettings.decimals, 2);
    } else {
      this.currency = typeof currencyOrSettings === 'string' ? currencyOrSettings : '¥';
      this.decimals = clampDecimals(decimals, 2);
    }
  }

  /**
   * 格式化金额为带货币前缀与千分位的字符串。
   * @param {number} value - 金额数值
   * @param {number} [decimals] - 可选临时小数位数（钳位至 0..4）
   * @returns {string}
   */
  string(value, decimals) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `${this.currency}0`;
    }
    const dd =
      decimals !== undefined && decimals !== null
        ? clampDecimals(decimals, this.decimals)
        : this.decimals;
    const normalized = Object.is(value, -0) ? 0 : value;
    let formatted = getFormatter(dd).format(normalized);
    // 防御 -0 与 -0.00 负零前缀
    formatted = formatted.replace(/^-(0(?:\.0+)?)$/, '$1');
    return `${this.currency}${formatted}`;
  }

  /**
   * 老板模式金额遮罩（保留小数位数结构而不泄露数字）。
   * @returns {string}
   */
  get masked() {
    return this.decimals > 0
      ? `${this.currency}***.${'*'.repeat(this.decimals)}`
      : `${this.currency}***`;
  }
}

/**
 * 时长格式化工具。
 */
const Duration = Object.freeze({
  /**
   * 格式化为 H:MM:SS 倒计时样式（如 "2:41:18"）。
   * @param {number} seconds - 秒数（向下取整，最小为 0）
   * @returns {string}
   */
  clock(seconds) {
    const safe = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0;
    const s = Math.max(0, Math.floor(safe));
    const hours = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  },

  /**
   * 格式化为中文可读时长（按分钟向上取整，如 "1 小时 30 分" / "30 分钟" / "1 小时"）。
   * @param {number} seconds - 秒数
   * @returns {string}
   */
  words(seconds) {
    const safe = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0;
    const m = Math.max(0, Math.ceil(safe / 60));
    if (m < 60) return `${m} 分钟`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem === 0 ? `${h} 小时` : `${h} 小时 ${rem} 分`;
  },
});

/**
 * 状态栏/托盘摘要文案生成器。
 */
const StatusText = Object.freeze({
  /**
   * 将 StatusLine 基础字段拼接为单行纯文本。
   * @param {{ badge: string|null, prefix: string|null, main: string, check: boolean }} line
   * @returns {string}
   */
  plainText(line) {
    const parts = [];
    if (line.badge) parts.push(line.badge);
    if (line.prefix) parts.push(line.prefix);
    if (line.main && line.main.length > 0) parts.push(line.main);
    if (line.check) parts.push('✓');
    return parts.join(' ');
  },

  /**
   * 根据计薪快照、设置与老板模式生成 StatusLine 普通可枚举对象（含 plainText 属性）。
   * @param {object} snapshot - WageEngine.snapshot() 返回对象
   * @param {object} settings - AppSettings 对象
   * @param {boolean} boss - 是否处于老板模式
   * @returns {{ prefix: string|null, badge: string|null, main: string, check: boolean, forceIcon: boolean, plainText: string }}
   */
  make(snapshot, settings, boss) {
    const money = new Money(settings);
    const amount = boss ? money.masked : money.string(snapshot.earnedToday);
    const amount0 = boss
      ? new Money(settings.currency, 0).masked
      : money.string(snapshot.earnedToday, 0);
    const pct = `${Math.floor(snapshot.progress * 100)}%`;
    const fmt = settings.menuBarFormat;

    const line = {
      prefix: null,
      badge: null,
      main: '',
      check: false,
      forceIcon: false,
      plainText: '',
    };

    const finalize = () => {
      line.plainText = StatusText.plainText(line);
      return line;
    };

    if (fmt === MenuBarFormat.iconOnly) {
      line.forceIcon = true;
      return finalize();
    }

    switch (snapshot.phase) {
      case Phase.rest:
        if (settings.offHoursDisplay === OffHoursDisplay.iconOnly) {
          line.forceIcon = true;
        } else if (snapshot.day.kind === DayKind.holiday && snapshot.day.name) {
          line.main = `${snapshot.day.name}休息`;
        } else {
          line.main = '休息';
        }
        return finalize();

      case Phase.paidLeave:
        line.prefix = '带薪假';
        line.main = amount;
        return finalize();

      case Phase.afterWork:
        line.main = amount;
        line.check = true;
        break;

      case Phase.beforeWork:
        line.main = fmt === MenuBarFormat.amountProgress ? `${amount0} · ${pct}` : amount;
        break;

      case Phase.working:
      case Phase.lunch:
        switch (fmt) {
          case MenuBarFormat.amountOnly:
          case MenuBarFormat.iconOnly:
            line.main = amount;
            break;
          case MenuBarFormat.amountProgress:
            line.main = `${amount0} · ${pct}`;
            break;
          case MenuBarFormat.amountCountdown:
            line.main = `${amount} · ${Duration.clock(snapshot.secondsToEnd ?? 0)}`;
            break;
          default:
            line.main = amount;
            break;
        }
        if (snapshot.phase === Phase.lunch) {
          line.prefix = '干饭中';
        }
        break;

      default:
        break;
    }

    if (snapshot.day.kind === DayKind.makeupWorkday) {
      line.badge = '班';
    }
    return finalize();
  },
});

/**
 * 里程碑进度计算与编辑文本解析/格式化工具。
 */
const Milestones = Object.freeze({
  /**
   * 计算当前已达成的最高里程碑、下一个目标、剩余金额及预计耗时。
   * @param {object} snapshot - Snapshot 对象
   * @param {Array<{ name: string, amount: number }>} list - 里程碑列表
   * @returns {{ reached: object|null, next: object|null, remaining: number, eta: number|null }}
   */
  status(snapshot, list) {
    const sorted = (Array.isArray(list) ? list : [])
      .filter((m) => m && typeof m.amount === 'number' && Number.isFinite(m.amount) && m.amount > 0)
      .slice()
      .sort((a, b) => a.amount - b.amount);

    const earned = snapshot.earnedToday;
    let reached = null;
    for (const m of sorted) {
      if (m.amount <= earned + 1e-9) {
        reached = { name: m.name, amount: m.amount };
      }
    }

    let next = null;
    for (const m of sorted) {
      if (m.amount > earned + 1e-9) {
        next = { name: m.name, amount: m.amount };
        break;
      }
    }

    const remaining = Math.max(0, (next ? next.amount : earned) - earned);
    let eta = null;
    if (
      next &&
      snapshot.perSecond > 0 &&
      (snapshot.phase === Phase.working ||
        snapshot.phase === Phase.lunch ||
        snapshot.phase === Phase.beforeWork) &&
      next.amount <= snapshot.dailyWage + 1e-9
    ) {
      eta = remaining / snapshot.perSecond;
    }

    return { reached, next, remaining, eta };
  },

  /**
   * 计算从 before 到 after 之间新跨过的里程碑（按金额升序）。
   * @param {number} before - 先前已赚金额
   * @param {number} after - 当前已赚金额
   * @param {Array<{ name: string, amount: number }>} list - 里程碑列表
   * @returns {Array<{ name: string, amount: number }>}
   */
  crossed(before, after, list) {
    return (Array.isArray(list) ? list : [])
      .filter(
        (m) =>
          m &&
          typeof m.amount === 'number' &&
          Number.isFinite(m.amount) &&
          m.amount > 0 &&
          m.amount > before + 1e-9 &&
          m.amount <= after + 1e-9
      )
      .map((m) => ({ name: m.name, amount: m.amount }))
      .sort((a, b) => a.amount - b.amount);
  },

  /**
   * 解析设置页多行里程碑文本（「名称,金额」，兼容中英文逗号，自动忽略无效行）。
   * @param {string} text
   * @returns {Array<{ name: string, amount: number }>}
   */
  parse(text) {
    if (typeof text !== 'string') return [];
    const lines = text.split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const parts = line.split(/[,，]/).map((p) => p.trim());
      if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) continue;
      const amount = Number(parts[1]);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      out.push({ name: parts[0], amount });
    }
    return out;
  },

  /**
   * 将里程碑数组格式化为设置页多行编辑文本。
   * @param {Array<{ name: string, amount: number }>} list
   * @returns {string}
   */
  format(list) {
    return (Array.isArray(list) ? list : [])
      .map((m) => {
        const v = Math.round(m.amount) === m.amount ? String(Math.trunc(m.amount)) : String(m.amount);
        return `${m.name},${v}`;
      })
      .join('\n');
  },
});

/**
 * 加油语录库（每小时轮换一句）。
 */
const Quotes = Object.freeze({
  all: Object.freeze([
    '再坚持一下，钱就到账了。',
    '今天的你也很值钱。',
    '每一秒都在进账，别慌。',
    '搬砖不易，且搬且珍惜。',
    '工资在涨，心态要稳。',
    '喝口水，钱还在跑。',
    '你不是在上班，你是在收钱。',
    '离下班又近了一点点。',
    '认真摸鱼，努力赚钱。',
    '今天也是被钱叫醒的一天。',
    '牛马也有春天。',
    '稳住，奶茶钱已经有了。',
  ]),

  /**
   * 按本地日历当年第几天与当前小时计算语录索引。兼容 Date 与 epoch ms。
   * @param {Date|number} date
   * @returns {string}
   */
  forDate(date) {
    const d = toDateObject(date);
    const y = d.getFullYear();
    const m = d.getMonth();
    const dayOfMonth = d.getDate();
    const hour = d.getHours();
    const dayOfYear = Math.round((Date.UTC(y, m, dayOfMonth) - Date.UTC(y, 0, 1)) / 86400000) + 1;
    const idx = (dayOfYear * 24 + hour) % Quotes.all.length;
    return Quotes.all[idx];
  },
});

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 将分钟数（0..1439）格式化为 "HH:MM" 时钟字符串。
 * @param {number} minutes
 * @returns {string}
 */
function formatMinutes(minutes) {
  const safe = typeof minutes === 'number' && Number.isFinite(minutes) ? Math.max(0, Math.trunc(minutes)) : 0;
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 根据老板模式开关格式化金额或返回对应位数的遮罩字符串。
 * @param {number} value - 金额数值
 * @param {object} settings - AppSettings 对象
 * @param {boolean} boss - 是否处于老板模式
 * @param {number} [decimals] - 可选覆盖小数位数
 * @returns {string}
 */
function formatAmount(value, settings, boss, decimals) {
  const d =
    decimals !== undefined && decimals !== null
      ? clampDecimals(decimals, clampDecimals(settings.decimals, 2))
      : clampDecimals(settings.decimals, 2);
  const money = new Money(settings.currency, d);
  return boss ? money.masked : money.string(value, d);
}

/**
 * 将 DayInfo 映射为中文日期类型标签（含大周周六特判）。
 * @param {{ kind: string, name?: string|null }} dayInfo
 * @returns {string}
 */
function kindLabel(dayInfo) {
  switch (dayInfo.kind) {
    case DayKind.workday:
      return dayInfo.name === '大周' ? '大周周六' : '工作日';
    case DayKind.makeupWorkday:
      return '调休补班';
    case DayKind.weekend:
      return '周末';
    case DayKind.holiday:
      return dayInfo.name ?? '法定节假日';
    case DayKind.paidLeave:
      return dayInfo.name ? `带薪假（${dayInfo.name}）` : '带薪假';
    case DayKind.manualRest:
      return dayInfo.name ? `休息（${dayInfo.name}）` : '休息';
    case DayKind.manualWork:
      return dayInfo.name ? `上班（${dayInfo.name}）` : '上班';
    default:
      return '未知';
  }
}

/**
 * 格式化主面板顶部的日期与类型行（如 "11月17日 周二 · 工作日"）。
 * 兼容传入完整 Snapshot（或已序列化 Snapshot）或 (dateOrMs, dayInfo)。
 * @param {object|Date|number} snapshotOrDate - Snapshot 对象或日期/时间戳
 * @param {object} [dayInfo] - 当首参为日期/时间戳时传入 DayInfo
 * @returns {string}
 */
function formatDayLine(snapshotOrDate, dayInfo) {
  let dateObj;
  let info;
  if (
    snapshotOrDate &&
    typeof snapshotOrDate === 'object' &&
    !(snapshotOrDate instanceof Date) &&
    'shiftDay' in snapshotOrDate
  ) {
    dateObj = toDateObject(snapshotOrDate.shiftDay);
    info = snapshotOrDate.day;
  } else {
    dateObj = toDateObject(snapshotOrDate);
    info = dayInfo;
  }
  const month = dateObj.getMonth() + 1;
  const day = dateObj.getDate();
  const wd = WEEKDAY_NAMES[dateObj.getDay()] ?? '';
  return `${month}月${day}日 ${wd} · ${kindLabel(info)}`;
}

/**
 * 生成主面板大字金额下方的阶段副标题文案。
 * @param {object} snapshot - Snapshot 对象
 * @param {object} settings - AppSettings 对象
 * @param {boolean} boss - 是否处于老板模式
 * @returns {string}
 */
function panelSubline(snapshot, settings, boss) {
  switch (snapshot.phase) {
    case Phase.working:
      return `每秒 +${formatAmount(snapshot.perSecond, settings, boss, 4)}，继续涨`;
    case Phase.lunch:
      return `干饭中，${formatMinutes(settings.lunchEnd)} 继续涨`;
    case Phase.beforeWork:
      return `还没上班，距上班 ${Duration.words(snapshot.secondsToStart ?? 0)}`;
    case Phase.afterWork:
      return '今天的钱已全部到账，下班快乐';
    case Phase.paidLeave:
      return '带薪假，全天照算';
    case Phase.rest:
      if (snapshot.day.kind === DayKind.holiday && snapshot.day.name) {
        return `${snapshot.day.name}假期，好好休息`;
      }
      return '不计薪，养精蓄锐';
    default:
      return '';
  }
}

/**
 * 生成主面板里程碑卡片标题与详情文案。
 * @param {object} snapshot - Snapshot 对象
 * @param {object} settings - AppSettings 对象
 * @param {boolean} boss - 是否处于老板模式
 * @returns {{ title: string, detail: string, status: object }}
 */
function milestoneSummary(snapshot, settings, boss) {
  const status = Milestones.status(snapshot, settings.milestones);
  const title = status.reached
    ? `刚挣够${status.reached.name}（${formatAmount(status.reached.amount, settings, boss, 0)}）`
    : '第一个小目标马上到';

  let detail = '今天的里程碑全部解锁';
  if (status.next) {
    detail = `下一个：${status.next.name} ${formatAmount(status.next.amount, settings, boss, 0)}，还差 ${formatAmount(status.remaining, settings, boss)}`;
    if (status.eta != null) {
      detail += `，大约 ${Duration.words(status.eta)}`;
    } else if (status.next.amount > snapshot.dailyWage) {
      detail += '，今天够不着了';
    }
  }
  return { title, detail, status };
}

module.exports = {
  Money,
  Duration,
  StatusText,
  Milestones,
  Quotes,
  formatDayLine,
  kindLabel,
  formatMinutes,
  formatAmount,
  panelSubline,
  milestoneSummary,
};
