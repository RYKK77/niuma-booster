'use strict';

/**
 * 本地设置持久化存储模块。
 * 负责 `userData/settings.json` 的 UTF-8 BOM 剥离、损坏备份恢复、逐字段容错解码及同目录原子写入。
 */

const fs = require('node:fs');
const path = require('node:path');
const { defaultSettings, decodeSettings } = require('../core');

/**
 * 根据 Electron `app` 实例解析默认设置文件路径。
 * @param {object} app - Electron App 实例
 * @returns {string} `settings.json` 绝对路径
 */
function resolveSettingsPath(app) {
  if (!app || typeof app.getPath !== 'function') {
    throw new Error('缺少有效的 app.getPath 接口，无法解析 settings.json 路径');
  }
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * 剥离文本开头可能存在的 UTF-8 BOM 字节序标记。
 * @param {string} text - 原始文本
 * @returns {string} 去除 BOM 后的文本
 */
function stripUtf8Bom(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 判断值是否为非数组普通对象。
 * @param {*} value - 待检测值
 * @returns {boolean} 是否为普通对象
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 将内容通过同目录临时文件 + fsync + rename 原子写入目标路径（含 Windows 短时占用重试与兜底）。
 * @param {string} targetPath - 目标文件路径
 * @param {string} content - 待写入的 UTF-8 文本
 */
function writeFileAtomic(targetPath, content) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
  const tmpPath = path.join(dir, `${path.basename(targetPath)}.${suffix}.tmp`);

  try {
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, content, 'utf8');
      if (typeof fs.fsyncSync === 'function') {
        fs.fsyncSync(fd);
      }
    } finally {
      fs.closeSync(fd);
    }

    let renamed = false;
    let lastRenameError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.renameSync(tmpPath, targetPath);
        renamed = true;
        break;
      } catch (err) {
        lastRenameError = err;
        if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
          continue;
        }
        break;
      }
    }

    if (!renamed) {
      try {
        fs.writeFileSync(targetPath, content, 'utf8');
      } catch {
        throw lastRenameError;
      }
    }
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // 忽略临时文件清理异常
    }
  }
}

/**
 * 创建设置存储实例（支持路径、目录及日志依赖注入）。
 * @param {object} [options={}] - 配置项
 * @param {string} [options.filePath] - 直接指定 `settings.json` 文件路径
 * @param {string} [options.userDataDir] - 指定 `userData` 目录路径
 * @param {object} [options.app] - Electron App 实例
 * @param {object} [options.logger=console] - 日志记录器
 * @returns {object} 设置存储操作对象
 */
function createSettingsStore(options = {}) {
  const logger = options.logger || console;
  const filePath = options.filePath
    ? String(options.filePath)
    : options.userDataDir
      ? path.join(String(options.userDataDir), 'settings.json')
      : resolveSettingsPath(options.app);

  /**
   * 备份损坏的设置文件，并在原文件未被移走时以干净默认设置覆写以防重复备份。
   * @param {object} fallbackSettings - 回落默认设置对象
   * @returns {string | null} 成功创建的备份文件路径，失败时返回 null
   */
  function backupCorruptFile(fallbackSettings) {
    const backupPath = `${filePath}.corrupt.${Date.now()}.bak`;
    let savedBackup = null;
    let movedOriginal = false;

    try {
      fs.renameSync(filePath, backupPath);
      savedBackup = backupPath;
      movedOriginal = true;
    } catch {
      try {
        fs.copyFileSync(filePath, backupPath);
        savedBackup = backupPath;
      } catch {
        savedBackup = null;
      }
    }

    if (!movedOriginal) {
      try {
        const cleanJson = `${JSON.stringify(fallbackSettings, null, 2)}\n`;
        writeFileAtomic(filePath, cleanJson);
      } catch {
        // 忽略覆写失败，确保主进程继续启动
      }
    }

    return savedBackup;
  }

  /**
   * 保存设置对象：先经 `decodeSettings` 净化字段，再原子写入磁盘。
   * @param {object} rawSettings - 待保存的设置对象
   * @returns {{ ok: boolean, filePath: string, settings: object, error: Error | null }} 保存结果
   */
  function save(rawSettings) {
    const normalized = decodeSettings(rawSettings);
    const json = `${JSON.stringify(normalized, null, 2)}\n`;

    try {
      writeFileAtomic(filePath, json);
      return {
        ok: true,
        filePath,
        settings: normalized,
        error: null,
      };
    } catch (err) {
      if (logger && typeof logger.error === 'function') {
        logger.error('[settingsStore] 保存设置失败:', err);
      }
      return {
        ok: false,
        filePath,
        settings: normalized,
        error: err,
      };
    }
  }

  /**
   * 读取设置并返回完整状态元数据（区分首次缺失、合法解码、损坏备份与 I/O 异常）。
   * @returns {{ settings: object, status: 'ok' | 'missing' | 'corrupt' | 'error', backupPath: string | null, error: Error | null }} 读取结果
   */
  function loadWithMeta() {
    let rawText;
    try {
      rawText = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return {
          settings: defaultSettings(),
          status: 'missing',
          backupPath: null,
          error: null,
        };
      }
      if (logger && typeof logger.error === 'function') {
        logger.error('[settingsStore] 读取设置文件失败，已回落默认设置:', err);
      }
      return {
        settings: defaultSettings(),
        status: 'error',
        backupPath: null,
        error: err,
      };
    }

    const cleanText = stripUtf8Bom(rawText);
    let parsed;
    try {
      parsed = JSON.parse(cleanText);
      if (!isPlainObject(parsed)) {
        throw new Error('设置文件顶层必须是 JSON 对象');
      }
    } catch (err) {
      const fallback = defaultSettings();
      const backupPath = backupCorruptFile(fallback);
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[settingsStore] 检测到损坏的设置文件，已备份并回落默认设置:', backupPath, err.message);
      }
      return {
        settings: fallback,
        status: 'corrupt',
        backupPath,
        error: err,
      };
    }

    return {
      settings: decodeSettings(parsed),
      status: 'ok',
      backupPath: null,
      error: null,
    };
  }

  /**
   * 容错读取设置对象（首次缺失时静默返回默认设置且不提前落盘）。
   * @returns {object} 合法完整的 AppSettings 对象
   */
  function load() {
    return loadWithMeta().settings;
  }

  /**
   * 将本地设置重置为默认值并落盘。
   * @returns {{ ok: boolean, filePath: string, settings: object, error: Error | null }} 重置结果
   */
  function reset() {
    return save(defaultSettings());
  }

  return {
    filePath,
    load,
    loadWithMeta,
    save,
    reset,
  };
}

module.exports = {
  resolveSettingsPath,
  stripUtf8Bom,
  writeFileAtomic,
  createSettingsStore,
};
