'use strict';

/**
 * 里程碑与下班加油通知状态机模块。
 * 1:1 移植 macOS `Cheerleader`（Sources/NiumaBooster/System.swift），支持跨夜班对齐、prime 防爆弹与老板模式遮罩。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DayKey, Phase, Money, Milestones } = require('../core');

/**
 * 解析资源文件路径（兼容开发环境与打包后 `app.asar.unpacked` 目录）。
 * @param {string} fileName - 资源文件名
 * @param {string} [assetDir] - 可选资源目录
 * @returns {string} 解析后的资源文件绝对路径
 */
function resolveAssetPath(fileName, assetDir) {
  const baseDir = assetDir ? String(assetDir) : path.resolve(__dirname, '../../assets');
  const candidate = path.join(baseDir, fileName);
  if (candidate.includes('app.asar')) {
    const unpacked = candidate.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
    try {
      if (fs.existsSync(unpacked)) {
        return unpacked;
      }
    } catch {
      // 忽略存在性探测异常，退回候选路径
    }
  }
  return candidate;
}

/**
 * 里程碑与下班通知状态机。
 */
class Cheerleader {
  /**
   * @param {object} [options={}] - 可选依赖注入项
   * @param {Function} [options.post] - 自定义通知发送回调 `(title, body) => void`
   * @param {Function} [options.Notification] - Electron Notification 构造函数
   * @param {object} [options.nativeImage] - Electron nativeImage 模块
   * @param {string} [options.iconPath] - 自定义通知图标路径
   * @param {string} [options.assetDir] - 自定义资产目录路径
   * @param {object} [options.logger=console] - 日志记录器
   */
  constructor(options = {}) {
    this.dayKey = null;
    this.lastEarned = 0;
    this.offWorkSent = false;
    this._customPost = typeof options.post === 'function' ? options.post : null;
    this._Notification = options.Notification || null;
    this._nativeImage = options.nativeImage || null;
    this._iconPath = options.iconPath ? String(options.iconPath) : null;
    this._assetDir = options.assetDir ? String(options.assetDir) : null;
    this._logger = options.logger || console;
    this._cachedIcon = undefined;
  }

  /**
   * 懒加载并缓存通知图标（失败或空图时返回 null 优雅降级）。
   * @returns {object | null} NativeImage 实例或 null
   */
  _getIcon() {
    if (this._cachedIcon !== undefined) {
      return this._cachedIcon;
    }
    if (!this._nativeImage || typeof this._nativeImage.createFromPath !== 'function') {
      this._cachedIcon = null;
      return null;
    }
    try {
      const iconPath = this._iconPath || resolveAssetPath('icon.png', this._assetDir);
      const image = this._nativeImage.createFromPath(iconPath);
      if (image && (typeof image.isEmpty !== 'function' || !image.isEmpty())) {
        this._cachedIcon = image;
        return image;
      }
    } catch (err) {
      if (this._logger && typeof this._logger.warn === 'function') {
        this._logger.warn('[cheerleader] 加载通知图标失败:', err);
      }
    }
    this._cachedIcon = null;
    return null;
  }

  /**
   * 发送单条桌面系统通知（不抛出异常，兼容无通知环境）。
   * @param {string} title - 通知标题
   * @param {string} body - 通知正文
   * @returns {boolean} 是否成功触发展示
   */
  post(title, body) {
    if (this._customPost) {
      this._customPost(title, body);
      return true;
    }

    const NotificationCtor = this._Notification;
    if (!NotificationCtor) {
      return false;
    }
    if (typeof NotificationCtor.isSupported === 'function' && !NotificationCtor.isSupported()) {
      return false;
    }

    try {
      const payload = { title, body };
      const icon = this._getIcon();
      if (icon) {
        payload.icon = icon;
      }
      const notification = new NotificationCtor(payload);
      if (notification && typeof notification.show === 'function') {
        notification.show();
      }
      return true;
    } catch (err) {
      if (this._logger && typeof this._logger.warn === 'function') {
        this._logger.warn('[cheerleader] 发送系统通知失败:', err);
      }
      return false;
    }
  }

  /**
   * 静默对齐状态基线：用于启动、改设置、切老板模式、休眠唤醒与时间跳变，不补发历史通知。
   * @param {object} snapshot - 计薪快照对象
   */
  prime(snapshot) {
    if (!snapshot || snapshot.shiftDay == null) {
      return;
    }
    this.dayKey = DayKey.key(snapshot.shiftDay);
    this.lastEarned = Number.isFinite(snapshot.earnedToday) ? snapshot.earnedToday : 0;
    this.offWorkSent = snapshot.phase === Phase.afterWork;
  }

  /**
   * 每秒推进状态机并在跨过里程碑或到达下班时刻时按规则发送通知。
   * @param {object} snapshot - 当前计薪快照对象
   * @param {object} settings - 当前 AppSettings 对象
   * @param {boolean} boss - 是否处于老板模式
   */
  update(snapshot, settings, boss) {
    if (!snapshot || !snapshot.day || !settings || snapshot.shiftDay == null) {
      return;
    }

    // 必须使用 shiftDay 判定跨班次日，确保跨夜班过零点后仍归属于昨日班次
    const key = DayKey.key(snapshot.shiftDay);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.lastEarned = 0;
      this.offWorkSent = false;
    }

    const currentEarned = Number.isFinite(snapshot.earnedToday) ? snapshot.earnedToday : 0;

    // 无论当日是否计薪累积，退出前均同步 lastEarned（1:1 对齐 Swift defer 语义）
    try {
      if (!snapshot.day.accrues) {
        return;
      }

      const money = new Money(settings);

      // 老板模式下静默里程碑通知，避免里程碑名称暴露收入档位
      if (settings.milestonesEnabled && !boss) {
        const crossedList = Milestones.crossed(
          this.lastEarned,
          currentEarned,
          settings.milestones
        );
        for (const item of crossedList) {
          this.post(
            `刚挣够${item.name}`,
            `今日已到账 ${money.string(item.amount, 0)}+，继续加油。`
          );
        }
      }

      // 下班通知：每个班次日最多发送一次；老板模式隐藏具体金额
      if (settings.offWorkNotification && snapshot.phase === Phase.afterWork && !this.offWorkSent) {
        this.offWorkSent = true;
        this.post(
          '下班啦',
          boss
            ? '今天的钱已全部到账，润！'
            : `今日 ${money.string(currentEarned)} 已全部到账，润！`
        );
      }
    } finally {
      this.lastEarned = currentEarned;
    }
  }
}

/**
 * 创建 `Cheerleader` 实例的工厂函数。
 * @param {object} [options={}] - 依赖注入配置项
 * @returns {Cheerleader} 状态机实例
 */
function createCheerleader(options = {}) {
  return new Cheerleader(options);
}

module.exports = {
  Cheerleader,
  createCheerleader,
  resolveAssetPath,
};
