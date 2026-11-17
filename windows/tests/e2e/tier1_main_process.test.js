'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createElectronHarness } = require('./helpers/electronMock');
const { localDate } = require('./helpers/coreCompat');

describe('Tier 1 — Main F9: 单实例锁、本地持久化与休眠唤醒对齐', () => {
  test('T1-F9-01 首实例获取锁成功并初始化托盘、热键、IPC 与 1s 定时器', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      singleInstanceLock: true,
    });
    try {
      await harness.bootMain();
      assert.equal(harness.state.quitCalled, false);
      assert.ok(harness.tray, '应创建系统托盘实例');
      assert.ok(harness.ipcHandlers.has('state:get'), '应注册 state:get IPC');
      assert.ok(harness.ipcHandlers.has('settings:update'), '应注册 settings:update IPC');
      assert.ok(harness.clock.pendingTimers() >= 1, '应启动 1s 主循环定时器');
    } finally {
      harness.dispose();
    }
  });

  test('T1-F9-02 第二实例获取单实例锁失败立即退出且不触碰托盘或磁盘', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      singleInstanceLock: false,
    });
    try {
      await harness.bootMain();
      assert.equal(harness.state.quitCalled, true);
      assert.equal(harness.tray, null);
      assert.equal(harness.windows.length, 0);
      assert.equal(harness.registeredShortcuts.size, 0);
      assert.equal(harness.readPersistedSettingsRaw(), null);
    } finally {
      harness.dispose();
    }
  });

  test('T1-F9-03 主实例收到 second-instance 事件时唤醒隐藏的主面板', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      const panel = harness.getPanelWindow();
      if (panel) panel.hide();

      harness.emitSecondInstance(['--relaunch'], 'd:\\project');
      await harness.flushAsync();

      const afterPanel = harness.getPanelWindow();
      assert.ok(afterPanel, '主面板窗口应存在');
      assert.equal(afterPanel.isVisible(), true);
    } finally {
      harness.dispose();
    }
  });

  test('T1-F9-04 关闭全部窗口触发 window-all-closed 时常驻托盘进程不退出', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'salary');
      const settingsWin = harness.getSettingsWindow();
      assert.ok(settingsWin);
      settingsWin.close();
      harness.emitWindowAllClosed();
      await harness.flushAsync();

      assert.equal(harness.state.quitCalled, false);
      assert.equal(harness.tray.isDestroyed(), false);
      assert.ok(harness.clock.pendingTimers() >= 1);
    } finally {
      harness.dispose();
    }
  });

  test('T1-F9-05 settings.json 初始化、持久化、跨重启恢复与 boss 内存态隔离', async () => {
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niuma-persist-'));
    try {
      const h1 = createElectronHarness({
        userDataDir: sharedDir,
        initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      });
      try {
        await h1.bootMain();
        const st1 = await h1.invokeIpc('state:get');
        assert.equal(st1.settings.amount, 20000);
        assert.equal(st1.boss, false);

        await h1.invokeIpc('settings:update', { amount: 36000, currency: '$' });
        await h1.invokeIpc('boss:set', true);
        const st1After = await h1.invokeIpc('state:get');
        assert.equal(st1After.settings.amount, 36000);
        assert.equal(st1After.boss, true);

        const disk = h1.readPersistedSettings();
        assert.equal(disk.amount, 36000);
        assert.equal(disk.currency, '$');
        assert.notEqual(disk.boss, true, 'boss 状态绝不能持久化到磁盘');
      } finally {
        h1.dispose();
      }

      // 重启新实例读取同一 userData
      const h2 = createElectronHarness({
        userDataDir: sharedDir,
        initialNow: localDate(2026, 11, 17, 10, 5, 0).getTime(),
      });
      try {
        await h2.bootMain();
        const st2 = await h2.invokeIpc('state:get');
        assert.equal(st2.settings.amount, 36000);
        assert.equal(st2.settings.currency, '$');
        assert.equal(st2.boss, false, '重启后 boss 必须重置为 false');
      } finally {
        h2.dispose();
      }
    } finally {
      fs.rmSync(sharedDir, { recursive: true, force: true });
    }
  });

  test('T1-F9-06 powerMonitor resume 休眠唤醒立即重算并静默 prime 不补发历史通知', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 9, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      assert.equal(harness.notifications.length, 0);

      // 模拟合盖休眠从 09:00 跳到 16:00（越过 15/30/60/150 四个里程碑）
      harness.clock.sleepTo(localDate(2026, 11, 17, 16, 0, 0).getTime());
      harness.emitPowerResume();
      harness.clock.tick(1000);
      await harness.flushAsync();

      const st = await harness.invokeIpc('state:get');
      assert.ok(st.snapshot.earnedToday > 600, '唤醒后快照金额应立即对齐到 16:00');
      assert.equal(harness.notifications.length, 0, '休眠唤醒 prime 不应补发历史里程碑通知');
      assert.ok(harness.tray.toolTip.includes('¥'), 'Tooltip 应立即更新');
    } finally {
      harness.dispose();
    }
  });
});

describe('Tier 1 — Main F10: 托盘图标、动态 Tooltip 与右键菜单', () => {
  test('T1-F10-01 托盘初始化加载 windows/assets/tray.png', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      assert.ok(harness.tray, '应创建托盘');
      const imgPath = harness.tray.image && harness.tray.image._path ? harness.tray.image._path : '';
      assert.ok(imgPath.endsWith('tray.png'), `托盘图标路径应指向 tray.png，实际: ${imgPath}`);
    } finally {
      harness.dispose();
    }
  });

  test('T1-F10-02 4 种 menuBarFormat 下托盘 Tooltip 文案与 127 字符上限', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 15, 18, 42).getTime(),
    });
    try {
      await harness.bootMain();
      assert.ok(harness.tray.toolTip.includes('¥611.01'));
      assert.ok(harness.tray.toolTip.length <= 127);

      await harness.invokeIpc('settings:update', { menuBarFormat: 'amountProgress' });
      assert.ok(harness.tray.toolTip.includes('¥611') && harness.tray.toolTip.includes('64%'));

      await harness.invokeIpc('settings:update', { menuBarFormat: 'amountCountdown' });
      assert.ok(harness.tray.toolTip.includes('¥611.01') && harness.tray.toolTip.includes('2:41:18'));

      await harness.invokeIpc('settings:update', { menuBarFormat: 'iconOnly' });
      assert.equal(harness.tray.toolTip.includes('¥'), false);
      assert.equal(harness.tray.toolTip.includes('%'), false);
      assert.ok(harness.tray.toolTip.length <= 127);
    } finally {
      harness.dispose();
    }
  });

  test('T1-F10-03 非上班时间 offHoursDisplay 控制休息文案显示与隐藏', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 10, 2, 10, 0, 0).getTime(), // 国庆假期
    });
    try {
      await harness.bootMain();
      assert.ok(harness.tray.toolTip.includes('国庆休息'));

      await harness.invokeIpc('settings:update', { offHoursDisplay: 'iconOnly' });
      assert.equal(harness.tray.toolTip.includes('国庆休息'), false);
    } finally {
      harness.dispose();
    }
  });

  test('T1-F10-04 lunch/paidLeave/makeupWorkday/afterWork 各阶段 Tooltip 组合正确', async () => {
    // 1. 午休 + 下班
    const h1 = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 12, 40, 0).getTime(),
    });
    try {
      await h1.bootMain();
      assert.ok(h1.tray.toolTip.includes('干饭中'));
      assert.ok(h1.tray.toolTip.includes('¥380.95'));

      h1.clock.sleepTo(localDate(2026, 11, 17, 18, 30, 0).getTime());
      h1.emitPowerResume();
      assert.ok(h1.tray.toolTip.includes('¥952.38'));
      assert.ok(h1.tray.toolTip.includes('✓'));
    } finally {
      h1.dispose();
    }

    // 2. 调休补班 + 带薪假
    const h2 = createElectronHarness({
      initialNow: localDate(2026, 10, 10, 15, 18, 42).getTime(),
    });
    try {
      await h2.bootMain();
      assert.ok(h2.tray.toolTip.includes('班'));
      assert.ok(h2.tray.toolTip.includes('¥712.84'));

      await h2.invokeIpc('settings:update', {
        manualMarks: [{ date: '2026-10-10', kind: 'paidLeave', note: '年假' }],
      });
      assert.ok(h2.tray.toolTip.includes('带薪假'));
      assert.ok(h2.tray.toolTip.includes('¥1,111.11'));
    } finally {
      h2.dispose();
    }
  });

  test('T1-F10-05 开启老板模式后 Tooltip 金额立即打码且保留后缀', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 15, 18, 42).getTime(),
      initialSettings: { menuBarFormat: 'amountCountdown' },
    });
    try {
      await harness.bootMain();
      assert.ok(harness.tray.toolTip.includes('¥611.01'));

      await harness.invokeIpc('boss:set', true);
      assert.ok(harness.tray.toolTip.includes('¥***.**'));
      assert.ok(harness.tray.toolTip.includes('2:41:18'));
      assert.equal(harness.tray.toolTip.includes('611'), false);
    } finally {
      harness.dispose();
    }
  });

  test('T1-F10-06 托盘右键菜单包含 4 项核心动作并同步勾选状态与热键文本', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      harness.rightClickTray();
      const menu = harness.tray.contextMenu || harness.tray.lastPoppedMenu;
      assert.ok(menu, '应构建并设置托盘右键菜单');

      const bossItem = menu.findItem('老板模式');
      const panelItem = menu.findItem('面板');
      const settingsItem = menu.findItem('设置');
      const quitItem = menu.findItem('退出');
      assert.ok(bossItem && panelItem && settingsItem && quitItem, '右键菜单应含 4 个核心操作项');
      assert.equal(Boolean(bossItem.checked), false);

      // 点击老板模式菜单项
      menu.clickItem('老板模式');
      await harness.flushAsync();
      assert.equal((await harness.invokeIpc('state:get')).boss, true);

      const updatedMenu = harness.tray.contextMenu || harness.tray.lastPoppedMenu;
      assert.equal(updatedMenu.findItem('老板模式').checked, true);

      // 点击打开设置菜单项
      updatedMenu.clickItem('设置');
      await harness.flushAsync();
      assert.ok(harness.getSettingsWindow(), '点击设置应打开设置窗口');

      // 点击退出菜单项
      updatedMenu.clickItem('退出');
      assert.equal(harness.state.quitCalled, true);
    } finally {
      harness.dispose();
    }
  });
});

describe('Tier 1 — Main F11: 无边框 Popover 定位、防重开与设置单实例窗', () => {
  test('T1-F11-01 主面板 Popover 构造属性合规（330px/无边框/置顶/安全隔离）', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      harness.clickTray();
      const panel = harness.getPanelWindow();
      assert.ok(panel, '应创建主面板窗口');
      assert.equal(panel.options.width, 330);
      assert.equal(panel.options.frame, false);
      assert.equal(panel.options.skipTaskbar, true);
      assert.equal(panel.options.alwaysOnTop, true);
      assert.equal(panel.options.webPreferences.contextIsolation, true);
      assert.equal(panel.options.webPreferences.nodeIntegration, false);
    } finally {
      harness.dispose();
    }
  });

  test('T1-F11-02 Popover 在底/顶/左/右 4 方位任务栏下完整落入 workArea 内', async () => {
    const configs = [
      {
        name: '底部任务栏',
        workArea: { x: 0, y: 0, width: 1920, height: 1032 },
        trayBounds: { x: 1700, y: 1040, width: 24, height: 40 },
      },
      {
        name: '顶部任务栏',
        workArea: { x: 0, y: 48, width: 1920, height: 1032 },
        trayBounds: { x: 1700, y: 4, width: 24, height: 40 },
      },
      {
        name: '左侧任务栏',
        workArea: { x: 60, y: 0, width: 1860, height: 1080 },
        trayBounds: { x: 10, y: 980, width: 40, height: 24 },
      },
      {
        name: '右侧任务栏',
        workArea: { x: 0, y: 0, width: 1860, height: 1080 },
        trayBounds: { x: 1870, y: 980, width: 40, height: 24 },
      },
    ];

    for (const cfg of configs) {
      const harness = createElectronHarness({
        initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
        displays: [
          {
            id: 1,
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            workArea: cfg.workArea,
            scaleFactor: 1,
          },
        ],
        trayBounds: cfg.trayBounds,
      });
      try {
        await harness.bootMain();
        const panel = harness.getPanelWindow();
        if (panel && panel.isVisible()) panel.hide();
        harness.clickTray();
        const b = harness.getPanelWindow().getBounds();
        const wa = cfg.workArea;
        assert.ok(b.x >= wa.x, `${cfg.name}: x(${b.x}) >= wa.x(${wa.x})`);
        assert.ok(b.y >= wa.y, `${cfg.name}: y(${b.y}) >= wa.y(${wa.y})`);
        assert.ok(b.x + b.width <= wa.x + wa.width, `${cfg.name}: right <= wa.right`);
        assert.ok(b.y + b.height <= wa.y + wa.height, `${cfg.name}: bottom <= wa.bottom`);
      } finally {
        harness.dispose();
      }
    }
  });

  test('T1-F11-03 点击托盘图标切换主面板显示与隐藏', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      const panel = harness.getPanelWindow();
      const initiallyVisible = panel ? panel.isVisible() : false;
      if (initiallyVisible) {
        harness.clickTray();
        assert.equal(harness.getPanelWindow().isVisible(), false);
      }
      harness.clickTray();
      assert.equal(harness.getPanelWindow().isVisible(), true);
      harness.clickTray();
      assert.equal(harness.getPanelWindow().isVisible(), false);
    } finally {
      harness.dispose();
    }
  });

  test('T1-F11-04 blur 失焦隐藏、200ms 去抖后可重开以及 window:hidePanel 隐藏', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      const panel = harness.getPanelWindow();
      if (!panel.isVisible()) harness.clickTray();
      assert.equal(panel.isVisible(), true);

      panel.emitBlur();
      assert.equal(panel.isVisible(), false, '失焦应自动隐藏');

      harness.clock.tick(201);
      harness.clickTray();
      assert.equal(panel.isVisible(), true, '超过 200ms 后点击托盘应重开');

      await harness.invokeIpc('window:hidePanel');
      assert.equal(panel.isVisible(), false, 'hidePanel IPC 应隐藏主面板');
    } finally {
      harness.dispose();
    }
  });

  test('T1-F11-05 panel:resize 动态更新主面板高度并在底部任务栏下保持不越界', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      displays: [
        {
          id: 1,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1032 },
          scaleFactor: 1,
        },
      ],
      trayBounds: { x: 1700, y: 1040, width: 24, height: 40 },
    });
    try {
      await harness.bootMain();
      const panel = harness.getPanelWindow();
      if (!panel.isVisible()) harness.clickTray();

      await harness.invokeIpc('panel:resize', 330, 480);
      const b = panel.getBounds();
      assert.equal(b.width, 330);
      assert.equal(b.height, 480);
      assert.ok(b.y + b.height <= 1032, `调整高度后 bottom(${b.y + b.height}) 不应超过 workArea(1032)`);
    } finally {
      harness.dispose();
    }
  });

  test('T1-F11-06 openSettings 先隐藏 Popover 并复用单实例设置窗口', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      const panel = harness.getPanelWindow();
      if (!panel.isVisible()) harness.clickTray();

      await harness.invokeIpc('window:openSettings', 'holidays');
      const sWin1 = harness.getSettingsWindow();
      assert.ok(sWin1);
      assert.equal(sWin1.isVisible(), true);
      assert.equal(panel.isVisible(), false, '打开设置应先隐藏 Popover');

      await harness.invokeIpc('window:openSettings', 'display');
      const settingsWins = harness.windows.filter(
        (w) => !w.isDestroyed() && w.loadedFile && path.basename(w.loadedFile) === 'settings.html'
      );
      assert.equal(settingsWins.length, 1, '设置窗口必须保持单实例');
      assert.equal(settingsWins[0], sWin1);
    } finally {
      harness.dispose();
    }
  });
});

describe('Tier 1 — Main F12: 全局老板键、通知去重与开机自启', () => {
  test('T1-F12-01 默认 ctrlOptB 注册 CommandOrControl+Alt+B 并触发切换 boss 与广播', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 15, 18, 42).getTime(),
    });
    try {
      await harness.bootMain();
      assert.equal(harness.registeredShortcuts.has('CommandOrControl+Alt+B'), true);

      const panel = harness.getPanelWindow();
      const beforeCount = panel.webContents.sentMessages.length;

      assert.equal(harness.triggerShortcut('CommandOrControl+Alt+B'), true);
      await harness.flushAsync();

      assert.equal((await harness.invokeIpc('state:get')).boss, true);
      assert.ok(harness.tray.toolTip.includes('¥***.**'));
      assert.ok(panel.webContents.sentMessages.length > beforeCount, '应向渲染窗口广播 state:update');
    } finally {
      harness.dispose();
    }
  });

  test('T1-F12-02 切换 bossHotkey 时注销旧热键并按预设重注或停用', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      assert.equal(harness.registeredShortcuts.has('CommandOrControl+Alt+B'), true);

      await harness.invokeIpc('settings:update', { bossHotkey: 'ctrlOptCmdH' });
      assert.equal(harness.registeredShortcuts.has('CommandOrControl+Alt+B'), false);
      assert.equal(harness.registeredShortcuts.has('CommandOrControl+Alt+H'), true);

      await harness.invokeIpc('settings:update', { bossHotkey: 'off' });
      assert.equal(harness.registeredShortcuts.has('CommandOrControl+Alt+H'), false);
      assert.equal(harness.registeredShortcuts.size, 0);
    } finally {
      harness.dispose();
    }
  });

  test('T1-F12-03 工作期间逐秒跨过多个里程碑时按升序发送 Notification', async () => {
    // 2026-11-17 日薪 20000/21 ≈ 952.38, 每秒约 0.03527；15元约 426s (09:07:06), 30元约 851s (09:14:11)
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 9, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      assert.equal(harness.notifications.length, 0);

      harness.clock.advanceMinutes(15); // 推进到 09:15:00（跨过 15 元一杯奶茶与 30 元一份外卖）
      await harness.flushAsync();

      assert.equal(harness.notifications.length, 2);
      assert.ok(harness.notifications[0].title.includes('一杯奶茶'));
      assert.ok(harness.notifications[1].title.includes('一份外卖'));
    } finally {
      harness.dispose();
    }
  });

  test('T1-F12-04 到点下班发送唯一 1 条含金额的下班啦通知', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 17, 59, 55).getTime(),
    });
    try {
      await harness.bootMain();
      harness.clock.tick(10000); // 17:59:55 -> 18:00:05
      await harness.flushAsync();

      const offWorkNotifs = harness.notifications.filter((n) => n.title.includes('下班'));
      assert.equal(offWorkNotifs.length, 1);
      assert.ok(offWorkNotifs[0].body.includes('¥952.38'));
    } finally {
      harness.dispose();
    }
  });

  test('T1-F12-05 老板模式下静默里程碑通知并打码下班通知正文', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 17, 59, 55).getTime(),
      initialSettings: {
        milestonesEnabled: true,
        offWorkNotification: true,
      },
    });
    try {
      await harness.bootMain();
      await harness.invokeIpc('boss:set', true);
      harness.clock.tick(10000);
      await harness.flushAsync();

      assert.equal(harness.notifications.length, 1);
      assert.ok(harness.notifications[0].title.includes('下班'));
      assert.equal(harness.notifications[0].body.includes('952'), false, '老板模式绝不能暴露金额');
      assert.ok(harness.notifications[0].body.includes('全部到账'));
    } finally {
      harness.dispose();
    }
  });

  test('T1-F12-06 loginItem:set 切换开机自启并回读状态一致', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      const resOn = await harness.invokeIpc('loginItem:set', true);
      assert.equal(harness.state.loginItem.openAtLogin, true);
      const stOn = await harness.invokeIpc('state:get');
      const valOn =
        typeof resOn === 'boolean'
          ? resOn
          : resOn && typeof resOn.openAtLogin === 'boolean'
            ? resOn.openAtLogin
            : stOn.runtime && stOn.runtime.openAtLogin;
      assert.equal(valOn, true);

      const resOff = await harness.invokeIpc('loginItem:set', false);
      assert.equal(harness.state.loginItem.openAtLogin, false);
      const stOff = await harness.invokeIpc('state:get');
      const valOff =
        typeof resOff === 'boolean'
          ? resOff
          : resOff && typeof resOff.openAtLogin === 'boolean'
            ? resOff.openAtLogin
            : stOff.runtime && stOff.runtime.openAtLogin;
      assert.equal(valOff, false);
    } finally {
      harness.dispose();
    }
  });
});
