'use strict';

const path = require('node:path');

/**
 * 仓库路径与 Core 接口轻量兼容层
 * 严格遵循 PROJECT.md § Interface Contracts，不依赖任何内部私有实现细节。
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const WINDOWS_ROOT = path.join(REPO_ROOT, 'windows');

function requireRepoPaths() {
  return {
    repoRoot: REPO_ROOT,
    windowsRoot: WINDOWS_ROOT,
    coreIndex: path.join(WINDOWS_ROOT, 'src', 'core', 'index.js'),
    mainEntry: path.join(WINDOWS_ROOT, 'src', 'main', 'main.js'),
    preloadPath: path.join(WINDOWS_ROOT, 'src', 'main', 'preload.js'),
    rendererDir: path.join(WINDOWS_ROOT, 'src', 'renderer'),
    panelHtml: path.join(WINDOWS_ROOT, 'src', 'renderer', 'panel.html'),
    settingsHtml: path.join(WINDOWS_ROOT, 'src', 'renderer', 'settings.html'),
    assetsDir: path.join(WINDOWS_ROOT, 'assets'),
    packageJson: path.join(WINDOWS_ROOT, 'package.json'),
    readmeMd: path.join(REPO_ROOT, 'README.md'),
    gitignore: path.join(REPO_ROOT, '.gitignore'),
    appIconSvg: path.join(REPO_ROOT, 'Assets', 'AppIcon.svg'),
  };
}

/**
 * 加载 windows/src/core/index.js（文件缺失时直接抛出 MODULE_NOT_FOUND，严禁静默跳过）
 */
function requireCore() {
  const { coreIndex } = requireRepoPaths();
  return require(coreIndex);
}

/**
 * 统一将 Date / epoch ms / ISO 字符串转换为 epoch 毫秒
 * @param {Date|number|string|null|undefined} value
 * @returns {number}
 */
function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return new Date(value).getTime();
  return Number.NaN;
}

/**
 * 兼容获取某月计薪日列表（支持 paidDays(date) 与 paidDaysInMonth(date)）
 * @param {object} workCalendar
 * @param {Date} date
 * @returns {Array<Date|string|number>}
 */
function getPaidDays(workCalendar, date) {
  if (typeof workCalendar.paidDays === 'function') {
    return workCalendar.paidDays(date);
  }
  if (typeof workCalendar.paidDaysInMonth === 'function') {
    return workCalendar.paidDaysInMonth(date);
  }
  throw new TypeError('WorkCalendar 缺少 paidDays / paidDaysInMonth 方法');
}

/**
 * 兼容调用 setBigSmallWeek（同时支持返回新对象或原地修改两种风格）
 * @param {object} settingsMod core.settings 命名空间
 * @param {object} settings AppSettings 对象
 * @param {boolean} on 是否开启大小周
 * @param {Date} today 参考日期
 * @returns {object}
 */
function applyBigSmallWeek(settingsMod, settings, on, today) {
  const result = settingsMod.setBigSmallWeek(settings, on, today);
  return result !== undefined ? result : settings;
}

/**
 * 按本地时区构造 Date（month 为 1-12）
 */
function localDate(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  return new Date(y, m - 1, d, hh, mm, ss, ms);
}

module.exports = {
  requireRepoPaths,
  requireCore,
  toMs,
  getPaidDays,
  applyBigSmallWeek,
  localDate,
};
