'use strict';

/**
 * 牛马加油器 Windows 版核心引擎统一入口。
 * 同时导出四大子模块命名空间及所有平铺符号，满足 M3/M4/E2E 的任意解构与命名空间消费方式。
 */

const holidayData = require('./holidayData');
const settings = require('./settings');
const wageEngine = require('./wageEngine');
const display = require('./display');

module.exports = {
  settings,
  holidayData,
  wageEngine,
  display,
  ...settings,
  ...holidayData,
  ...wageEngine,
  ...display,
};
