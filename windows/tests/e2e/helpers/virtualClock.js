'use strict';

/**
 * 确定性虚拟时钟，用于替代存在实验警告且会补发休眠 interval 的 node:test mock.timers。
 * 严格区分 tick(ms)（按时间戳升序逐步执行定时器）与 sleepTo(targetEpochMs)（系统休眠跳变并顺延 interval）。
 */

/**
 * 创建虚拟时钟实例
 * @param {number} [initialEpochMs] 初始虚拟时间戳（毫秒），默认取系统当前时间
 */
function createVirtualClock(initialEpochMs = Date.now()) {
  const OrigDate = globalThis.Date;
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  const origPerf = globalThis.performance;
  const origPerfNow = origPerf && typeof origPerf.now === 'function'
    ? origPerf.now.bind(origPerf)
    : () => OrigDate.now() - baseEpochMs;

  let currentNow = Number(initialEpochMs);
  if (!Number.isFinite(currentNow)) {
    throw new TypeError(`无效的初始时间戳: ${initialEpochMs}`);
  }
  const baseEpochMs = currentNow;
  const basePerfNow = origPerfNow();

  let installed = false;
  let nextTimerId = 1;
  /** @type {Map<number, { id: number, type: 'timeout'|'interval', nextRun: number, delay: number, callback: Function, args: any[] }>} */
  const timers = new Map();

  function FakeDate(...args) {
    if (!new.target) {
      return new OrigDate(currentNow).toString();
    }
    if (args.length === 0) {
      return new OrigDate(currentNow);
    }
    return Reflect.construct(OrigDate, args);
  }
  FakeDate.prototype = OrigDate.prototype;
  Object.setPrototypeOf(FakeDate, OrigDate);
  FakeDate.now = () => currentNow;
  FakeDate.UTC = OrigDate.UTC;
  FakeDate.parse = OrigDate.parse;

  function fakeSetTimeout(callback, delay = 0, ...args) {
    if (typeof callback !== 'function') {
      throw new TypeError('setTimeout 回调必须为函数');
    }
    const ms = Math.max(0, Number(delay) || 0);
    const id = nextTimerId++;
    timers.set(id, {
      id,
      type: 'timeout',
      nextRun: currentNow + ms,
      delay: ms,
      callback,
      args,
    });
    return id;
  }

  function fakeClearTimeout(id) {
    if (id != null) {
      timers.delete(id);
    }
  }

  function fakeSetInterval(callback, delay = 0, ...args) {
    if (typeof callback !== 'function') {
      throw new TypeError('setInterval 回调必须为函数');
    }
    const ms = Math.max(1, Number(delay) || 0);
    const id = nextTimerId++;
    timers.set(id, {
      id,
      type: 'interval',
      nextRun: currentNow + ms,
      delay: ms,
      callback,
      args,
    });
    return id;
  }

  function fakeClearInterval(id) {
    if (id != null) {
      timers.delete(id);
    }
  }

  function fakePerfNow() {
    return basePerfNow + (currentNow - baseEpochMs);
  }

  let savedPerfDescriptor = null;

  function install() {
    if (installed) return;
    installed = true;
    globalThis.Date = FakeDate;
    globalThis.setTimeout = fakeSetTimeout;
    globalThis.clearTimeout = fakeClearTimeout;
    globalThis.setInterval = fakeSetInterval;
    globalThis.clearInterval = fakeClearInterval;

    if (origPerf) {
      savedPerfDescriptor = Object.getOwnPropertyDescriptor(origPerf, 'now');
      try {
        Object.defineProperty(origPerf, 'now', {
          configurable: true,
          writable: true,
          value: fakePerfNow,
        });
      } catch {
        // 若全局 performance.now 不可写，则替换 globalThis.performance 代理
        const proxyPerf = Object.create(origPerf);
        proxyPerf.now = fakePerfNow;
        Object.defineProperty(globalThis, 'performance', {
          configurable: true,
          writable: true,
          value: proxyPerf,
        });
      }
    }
  }

  function restore() {
    timers.clear();
    if (!installed) return;
    installed = false;
    globalThis.Date = OrigDate;
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;

    if (origPerf) {
      if (globalThis.performance !== origPerf) {
        Object.defineProperty(globalThis, 'performance', {
          configurable: true,
          writable: true,
          value: origPerf,
        });
      } else if (savedPerfDescriptor) {
        Object.defineProperty(origPerf, 'now', savedPerfDescriptor);
      } else {
        delete origPerf.now;
      }
    }
  }

  function now() {
    return currentNow;
  }

  /**
   * 直接调整当前虚拟时钟，并顺延所有未取消的 interval，绝不补发跳变期间遗漏的回调
   * @param {number} ms 目标 epoch 毫秒
   */
  function setNow(ms) {
    const target = Number(ms);
    if (!Number.isFinite(target)) {
      throw new TypeError(`无效的时间戳: ${ms}`);
    }
    currentNow = target;
    for (const timer of timers.values()) {
      if (timer.type === 'interval') {
        timer.nextRun = currentNow + timer.delay;
      }
    }
  }

  /**
   * 按本地时区设定虚拟时钟（month 为 1-12）
   * @param {number} y 年
   * @param {number} m 月（1-12）
   * @param {number} d 日
   * @param {number} [hh=0] 时
   * @param {number} [mm=0] 分
   * @param {number} [ss=0] 秒
   * @param {number} [ms=0] 毫秒
   */
  function setLocalDateTime(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
    const target = new OrigDate(y, m - 1, d, hh, mm, ss, ms).getTime();
    setNow(target);
    return currentNow;
  }

  /**
   * 推进 ms 毫秒，按触发时间戳升序精确执行所有到期定时器
   * @param {number} ms 推进毫秒数（>= 0）
   */
  function tick(ms) {
    const delta = Number(ms);
    if (!Number.isFinite(delta) || delta < 0) {
      throw new RangeError(`tick 参数必须为非负有限数字: ${ms}`);
    }
    const target = currentNow + delta;

    while (true) {
      let nextTimer = null;
      for (const t of timers.values()) {
        if (t.nextRun <= target) {
          if (
            !nextTimer ||
            t.nextRun < nextTimer.nextRun ||
            (t.nextRun === nextTimer.nextRun && t.id < nextTimer.id)
          ) {
            nextTimer = t;
          }
        }
      }
      if (!nextTimer) break;

      if (nextTimer.nextRun > currentNow) {
        currentNow = nextTimer.nextRun;
      }

      if (nextTimer.type === 'timeout') {
        timers.delete(nextTimer.id);
      } else {
        nextTimer.nextRun = currentNow + nextTimer.delay;
      }

      nextTimer.callback(...nextTimer.args);
    }

    currentNow = target;
    return currentNow;
  }

  /**
   * 模拟系统休眠直接跳变到目标时间，顺延未取消 interval，绝不补发休眠期间遗漏回调
   * @param {number} targetEpochMs 目标 epoch 毫秒（须 >= 当前时间）
   */
  function sleepTo(targetEpochMs) {
    const target = Number(targetEpochMs);
    if (!Number.isFinite(target) || target < currentNow) {
      throw new RangeError(`sleepTo 目标时间(${targetEpochMs})不能早于当前虚拟时间(${currentNow})`);
    }
    setNow(target);
    return currentNow;
  }

  function advanceMinutes(min) {
    return tick(min * 60 * 1000);
  }

  function sleepMinutes(min) {
    return sleepTo(currentNow + min * 60 * 1000);
  }

  function pendingTimers() {
    return timers.size;
  }

  return {
    OrigDate,
    FakeDate,
    install,
    restore,
    now,
    setNow,
    setLocalDateTime,
    tick,
    sleepTo,
    advanceMinutes,
    sleepMinutes,
    pendingTimers,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    perfNow: fakePerfNow,
  };
}

module.exports = {
  createVirtualClock,
};
