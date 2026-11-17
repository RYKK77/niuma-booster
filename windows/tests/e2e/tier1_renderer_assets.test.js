'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createElectronHarness } = require('./helpers/electronMock');
const { mountRendererWindow } = require('./helpers/domHarness');
const { parseIco, decodePngRgba } = require('./helpers/pngIcoDecoder');
const { requireRepoPaths, localDate } = require('./helpers/coreCompat');

// --- 黑盒语义 DOM 查询辅助（绝不耦合未契约化的内部 DOM ID 或 CSS 类名） ---

function isVisible(el) {
  let cur = el;
  while (cur && cur.nodeType === 1) {
    if (
      cur.hidden ||
      cur.style.display === 'none' ||
      cur.style.visibility === 'hidden' ||
      cur.classList.contains('hidden') ||
      cur.classList.contains('is-hidden')
    ) {
      return false;
    }
    cur = cur.parentElement;
  }
  return true;
}

function visibleText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.data;
  if (node.nodeType !== 1) return '';
  if (node.localName === 'script' || node.localName === 'style') return '';
  if (
    node.hidden ||
    node.style.display === 'none' ||
    node.style.visibility === 'hidden' ||
    node.classList.contains('hidden') ||
    node.classList.contains('is-hidden')
  ) {
    return '';
  }
  return node.childNodes.map(visibleText).join(' ');
}

function findButtonByText(doc, substr) {
  const candidates = doc
    .querySelectorAll('button, summary, [role="button"], [role="tab"]')
    .filter((el) => isVisible(el) && el.textContent.replace(/\s+/g, ' ').includes(substr));
  assert.ok(candidates.length > 0, `未找到包含文本 "${substr}" 的可见按钮/页签`);
  candidates.sort((a, b) => a.textContent.length - b.textContent.length);
  return candidates[0];
}

function findInteractiveChoice(doc, substr) {
  const candidates = doc
    .querySelectorAll('button, input[type="radio"], input[type="checkbox"], option, [role="radio"], [role="tab"], label')
    .filter((el) => {
      if (!isVisible(el)) return false;
      if (el.localName === 'label') {
        const hasCtrl = Boolean(el.querySelector('input, select') || (el.getAttribute('for') && doc.getElementById(el.getAttribute('for'))));
        return hasCtrl && el.textContent.includes(substr);
      }
      if (el.localName === 'input') {
        const lbl = el.closest('label');
        const aria = el.getAttribute('aria-label') || el.title || '';
        return aria.includes(substr) || (lbl && lbl.textContent.includes(substr));
      }
      return el.textContent.includes(substr);
    });
  assert.ok(candidates.length > 0, `未找到包含 "${substr}" 的可交互选项`);
  return candidates[0];
}

function findControlByLabel(doc, labelSubstr) {
  for (const el of doc.querySelectorAll('input, select, textarea')) {
    if (!isVisible(el)) continue;
    const aria = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';
    const ph = el.getAttribute('placeholder') || '';
    if (aria.includes(labelSubstr) || title.includes(labelSubstr) || ph.includes(labelSubstr)) {
      return el;
    }
  }
  for (const lbl of doc.querySelectorAll('label')) {
    if (!isVisible(lbl) || !lbl.textContent.includes(labelSubstr)) continue;
    const forId = lbl.getAttribute('for');
    if (forId) {
      const target = doc.getElementById(forId);
      if (target) return target;
    }
    const nested = lbl.querySelector('input, select, textarea');
    if (nested) return nested;
    if (lbl.parentElement) {
      const sibling = lbl.parentElement.querySelector('input, select, textarea');
      if (sibling) return sibling;
    }
  }
  // 兜底：在包含该文本的容器行内寻找表单控件
  const blocks = doc
    .querySelectorAll('div, section, li, tr, p, span')
    .filter((el) => isVisible(el) && el.textContent.includes(labelSubstr) && el.querySelector('input, select, textarea'));
  blocks.sort((a, b) => a.textContent.length - b.textContent.length);
  if (blocks.length > 0) {
    return blocks[0].querySelector('input, select, textarea');
  }
  throw new Error(`未找到关联标签 "${labelSubstr}" 的表单控件`);
}

// --- 像素质量校验辅助（防 fitz 纯黑渐变退化与空白图） ---

function inspectBrandPixels(png) {
  const { width, height } = png;
  const cxStart = Math.floor(width * 0.25);
  const cxEnd = Math.ceil(width * 0.75);
  const cyStart = Math.floor(height * 0.25);
  const cyEnd = Math.ceil(height * 0.75);

  let centerTotal = 0;
  let centerNonTransparent = 0;
  let opaqueTotal = 0;
  let pureBlackOpaque = 0;
  let warmOrangeCount = 0;
  let creamCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = png.getPixel(x, y);
      if (x >= cxStart && x < cxEnd && y >= cyStart && y < cyEnd) {
        centerTotal++;
        if (a > 128) centerNonTransparent++;
      }
      if (a > 200) {
        opaqueTotal++;
        if (r < 15 && g < 15 && b < 15) pureBlackOpaque++;
      }
      if (r >= 150 && r > g && g >= 35 && r - b >= 50 && a >= 150) {
        warmOrangeCount++;
      }
      if (r >= 220 && g >= 210 && b >= 180 && a > 200) {
        creamCount++;
      }
    }
  }
  return {
    centerRatio: centerTotal > 0 ? centerNonTransparent / centerTotal : 0,
    blackRatio: opaqueTotal > 0 ? pureBlackOpaque / opaqueTotal : 1,
    opaqueTotal,
    warmOrangeCount,
    creamCount,
  };
}

describe('Tier 1 — Assets F7: Windows 多分辨率图标资产校验', () => {
  test('T1-F7-01 4 个指定图标文件均存在且非空', () => {
    const { assetsDir } = requireRepoPaths();
    for (const name of ['icon.ico', 'icon.png', 'tray.png', 'tray@2x.png']) {
      const p = path.join(assetsDir, name);
      assert.equal(fs.existsSync(p), true, `缺少图标文件: ${p}`);
      assert.ok(fs.statSync(p).size > 0, `图标文件为空: ${p}`);
    }
  });

  test('T1-F7-02 icon.ico 包含 7 种规范尺寸且 256x256 帧像素色域正常', () => {
    const { assetsDir } = requireRepoPaths();
    const ico = parseIco(fs.readFileSync(path.join(assetsDir, 'icon.ico')));
    assert.equal(ico.reserved, 0);
    assert.equal(ico.type, 1);
    assert.ok(ico.count >= 7, `ICO 帧数应 >= 7，实际 ${ico.count}`);

    for (const sz of [16, 24, 32, 48, 64, 128, 256]) {
      assert.ok(ico.getFrame(sz, sz), `icon.ico 缺少 ${sz}x${sz} 尺寸帧`);
    }

    const frame256 = ico.getFrame(256, 256);
    assert.equal(frame256.isPng, true, '256x256 ICO 帧必须为内嵌 PNG');
    const png = decodePngRgba(frame256.data);
    assert.equal(png.width, 256);
    assert.equal(png.height, 256);
    assert.equal(png.colorType, 6);

    for (const [x, y] of [[0, 0], [255, 0], [0, 255], [255, 255]]) {
      assert.equal(png.getPixel(x, y)[3], 0, `256x256 四角 (${x},${y}) 应透明`);
    }
    const stats = inspectBrandPixels(png);
    assert.ok(stats.centerRatio >= 0.5, `中心非透明比例过低: ${stats.centerRatio}`);
    assert.ok(stats.blackRatio < 0.05, `纯黑不透明像素比例异常(疑似 fitz 退化): ${stats.blackRatio}`);
    assert.ok(stats.warmOrangeCount > 0, '缺少品牌暖橙/金渐变像素');
    assert.ok(stats.creamCount > 0, '缺少牛脸奶白像素');
  });

  test('T1-F7-03 icon.png 为 256x256 RGBA PNG 且透明边距与色彩正常', () => {
    const { assetsDir } = requireRepoPaths();
    const png = decodePngRgba(fs.readFileSync(path.join(assetsDir, 'icon.png')));
    assert.ok(png.width >= 256 && png.width === png.height, `icon.png 尺寸异常: ${png.width}x${png.height}`);
    assert.equal(png.colorType, 6);
    assert.equal(png.bitDepth, 8);
    for (const [x, y] of [[0, 0], [png.width - 1, 0], [0, png.height - 1], [png.width - 1, png.height - 1]]) {
      assert.equal(png.getPixel(x, y)[3], 0, `四角 (${x},${y}) 应全透明`);
    }
    const stats = inspectBrandPixels(png);
    assert.ok(stats.centerRatio >= 0.5);
    assert.ok(stats.blackRatio < 0.05);
    assert.ok(stats.warmOrangeCount > 0 && stats.creamCount > 0);
  });

  test('T1-F7-04 tray.png 为 16x16 RGBA PNG 且顶角透明、前景清晰', () => {
    const { assetsDir } = requireRepoPaths();
    const png = decodePngRgba(fs.readFileSync(path.join(assetsDir, 'tray.png')));
    assert.equal(png.width, 16);
    assert.equal(png.height, 16);
    assert.equal(png.colorType, 6);
    assert.equal(png.getPixel(0, 0)[3], 0);
    assert.equal(png.getPixel(15, 0)[3], 0);
    assert.ok(png.getPixel(0, 15)[3] <= 16);
    assert.ok(png.getPixel(15, 15)[3] <= 16);

    let centerSolid = 0;
    for (let y = 3; y <= 12; y++) {
      for (let x = 3; x <= 12; x++) {
        if (png.getPixel(x, y)[3] >= 180) centerSolid++;
      }
    }
    const stats = inspectBrandPixels(png);
    assert.ok(centerSolid >= 40, `tray.png 中心实心像素应 >= 40，实际 ${centerSolid}`);
    assert.ok(stats.blackRatio < 0.05);
    assert.ok(stats.warmOrangeCount > 0);
  });

  test('T1-F7-05 tray@2x.png 为 32x32 RGBA PNG 且高分像素密度正常', () => {
    const { assetsDir } = requireRepoPaths();
    const png = decodePngRgba(fs.readFileSync(path.join(assetsDir, 'tray@2x.png')));
    assert.equal(png.width, 32);
    assert.equal(png.height, 32);
    assert.equal(png.colorType, 6);
    assert.equal(png.getPixel(0, 0)[3], 0);
    assert.equal(png.getPixel(31, 0)[3], 0);
    assert.ok(png.getPixel(0, 31)[3] <= 16);
    assert.ok(png.getPixel(31, 31)[3] <= 16);

    let centerSolid = 0;
    for (let y = 6; y <= 25; y++) {
      for (let x = 6; x <= 25; x++) {
        if (png.getPixel(x, y)[3] >= 180) centerSolid++;
      }
    }
    const stats = inspectBrandPixels(png);
    assert.ok(centerSolid >= 160, `tray@2x.png 中心实心像素应 >= 160，实际 ${centerSolid}`);
    assert.ok(stats.blackRatio < 0.05);
    assert.ok(stats.warmOrangeCount > 0);
  });
});

describe('Tier 1 — Config F8: windows/package.json 与 .gitignore 配置校验', () => {
  test('T1-F8-01 windows/package.json 为合法 CommonJS 工程且指向真实 main 入口', () => {
    const { packageJson, mainEntry } = requireRepoPaths();
    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    assert.notEqual(pkg.type, 'module');
    assert.equal(pkg.main, 'src/main/main.js');
    assert.equal(fs.existsSync(mainEntry), true, 'src/main/main.js 必须存在');
  });

  test('T1-F8-02 windows/package.json 元数据与 5 项标准 scripts 完整', () => {
    const { packageJson } = requireRepoPaths();
    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    assert.equal(pkg.name, 'niuma-booster');
    assert.equal(pkg.productName, '牛马加油器');
    assert.equal(typeof pkg.version, 'string');
    assert.ok(pkg.version.length > 0);

    assert.ok(pkg.scripts.start && pkg.scripts.start.includes('electron'));
    assert.ok(pkg.scripts.test && pkg.scripts.test.includes('node --test'));
    assert.ok(pkg.scripts.check && pkg.scripts.check.includes('node') && pkg.scripts.check.includes('--check'));
    assert.ok(pkg.scripts.pack && pkg.scripts.pack.includes('electron-builder --dir'));
    assert.ok(pkg.scripts.dist && pkg.scripts.dist.includes('electron-builder --win'));
  });

  test('T1-F8-03 windows/package.json electron-builder Windows 打包配置完整', () => {
    const { packageJson, windowsRoot } = requireRepoPaths();
    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    assert.ok(pkg.devDependencies && pkg.devDependencies.electron);
    assert.ok(pkg.devDependencies['electron-builder']);
    assert.equal(pkg.build.appId, 'local.niuma.booster');
    assert.equal(pkg.build.productName, '牛马加油器');
    assert.equal(pkg.build.win.icon, 'assets/icon.ico');
    assert.equal(fs.existsSync(path.join(windowsRoot, pkg.build.win.icon)), true);
    assert.ok(Array.isArray(pkg.build.win.target));
    const targets = pkg.build.win.target.map((t) => (typeof t === 'string' ? t : t.target));
    assert.ok(targets.includes('nsis') && targets.includes('portable'));
    assert.equal(pkg.build.directories.output, 'dist');
  });

  test('T1-F8-04 零外部依赖约束：无需安装 windows/node_modules 即可运行测试', () => {
    const { windowsRoot } = requireRepoPaths();
    const nm = path.join(windowsRoot, 'node_modules');
    assert.equal(fs.existsSync(nm), false, '测试期严禁执行 npm install 生成 node_modules');
  });

  test('T1-F8-05 根 .gitignore 保留 macOS Swift 规则并追加 Windows 构建忽略规则', () => {
    const { gitignore } = requireRepoPaths();
    const content = fs.readFileSync(gitignore, 'utf8');
    for (const rule of ['.build/', '.swiftpm/', 'Package.resolved', 'build/', '.DS_Store', 'xcuserdata/', 'DerivedData/']) {
      assert.ok(content.includes(rule), `.gitignore 应保留原规则: ${rule}`);
    }
    assert.ok(content.includes('windows/node_modules/') || content.includes('node_modules/'));
    assert.ok(content.includes('windows/dist/'));
  });
});

describe('Tier 1 — Renderer F13: Preload 契约与主面板 UI 黑盒验证', () => {
  test('T1-F13-01 preload.js 严格暴露 window.niumaAPI 13 项接口且无原生泄漏', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    try {
      await harness.bootMain();
      const panel = harness.getPanelWindow();
      const { api, exposed } = harness.loadPreloadWithMeta(panel);

      assert.deepEqual(Object.keys(exposed), ['niumaAPI']);
      const requiredFns = [
        'onStateUpdate',
        'getState',
        'updateSettings',
        'toggleBoss',
        'setBoss',
        'setBigSmallWeek',
        'importHolidaysDialog',
        'clearImportedHolidays',
        'setLoginItem',
        'resizePanel',
        'openSettings',
        'hidePanel',
        'quitApp',
      ];
      for (const fn of requiredFns) {
        assert.equal(typeof api[fn], 'function', `window.niumaAPI.${fn} 必须为函数`);
      }
      assert.equal(api.ipcRenderer, undefined, '不得向渲染进程泄漏原生 ipcRenderer');
      assert.equal(api.require, undefined);
    } finally {
      harness.dispose();
    }
  });

  test('T1-F13-02 主面板正确渲染全部 6 个 Phase 标题、日期行、金额与副行文案', async () => {
    const checkPhase = async (nowDate, setupSettings, expectedSnippets) => {
      const harness = createElectronHarness({
        initialNow: nowDate.getTime(),
        initialSettings: setupSettings || null,
      });
      let view;
      try {
        await harness.bootMain();
        view = await mountRendererWindow(harness, 'panel');
        const txt = visibleText(view.document.body);
        for (const snippet of expectedSnippets) {
          assert.ok(txt.includes(snippet), `阶段文本应包含 "${snippet}"，实际文本: ${txt}`);
        }
      } finally {
        if (view) view.dispose();
        harness.dispose();
      }
    };

    await checkPhase(localDate(2026, 11, 17, 8, 30, 0), null, ['今日已到账', '11月17日 周二', '工作日', '还没上班', '30 分钟']);
    await checkPhase(localDate(2026, 11, 17, 15, 18, 42), null, ['今日已到账', '¥611.01', '每秒 +¥0.0353']);
    await checkPhase(localDate(2026, 11, 17, 12, 40, 0), null, ['¥380.95', '干饭中', '13:30']);
    await checkPhase(localDate(2026, 11, 17, 18, 30, 0), null, ['¥952.38', '今天的钱已全部到账，下班快乐']);
    await checkPhase(
      localDate(2026, 11, 18, 10, 0, 0),
      { manualMarks: [{ date: '2026-11-18', kind: 'paidLeave', note: '年假' }] },
      ['带薪假（年假）', '带薪假，全天照算']
    );
    await checkPhase(localDate(2026, 10, 2, 10, 0, 0), null, ['今天休息', '国庆', '国庆假期，好好休息']);
  });

  test('T1-F13-03 三段式 ShiftBar 与工时进度仅在 accrues 日显示，休息/带薪假隐藏', async () => {
    // 工作日显示
    const hWork = createElectronHarness({ initialNow: localDate(2026, 11, 17, 15, 18, 42).getTime() });
    let vWork;
    try {
      await hWork.bootMain();
      vWork = await mountRendererWindow(hWork, 'panel');
      const txt = visibleText(vWork.document.body);
      assert.ok(txt.includes('有效工时') && txt.includes('64%'));
      assert.ok(txt.includes('午休 12:00') && txt.includes('2:41:18'));
    } finally {
      if (vWork) vWork.dispose();
      hWork.dispose();
    }

    // 带薪假 & 国庆休息隐藏
    for (const [dt, st] of [
      [localDate(2026, 11, 18, 10, 0, 0), { manualMarks: [{ date: '2026-11-18', kind: 'paidLeave', note: '年假' }] }],
      [localDate(2026, 10, 2, 10, 0, 0), null],
    ]) {
      const h = createElectronHarness({ initialNow: dt.getTime(), initialSettings: st });
      let v;
      try {
        await h.bootMain();
        v = await mountRendererWindow(h, 'panel');
        const txt = visibleText(v.document.body);
        assert.equal(txt.includes('有效工时'), false, '非 accrues 日不应显示 ShiftBar 有效工时');
      } finally {
        if (v) v.dispose();
        h.dispose();
      }
    }
  });

  test('T1-F13-04 2x2 核心指标网格在计薪日与休息日正确切换标签与数值', async () => {
    const hWork = createElectronHarness({ initialNow: localDate(2026, 11, 17, 15, 18, 42).getTime() });
    let vWork;
    try {
      await hWork.bootMain();
      vWork = await mountRendererWindow(hWork, 'panel');
      const txt = visibleText(vWork.document.body);
      assert.ok(txt.includes('今日日薪') && txt.includes('¥952.38'));
      assert.ok(txt.includes('时薪') && txt.includes('¥126.98'));
      assert.ok(txt.includes('本月累计') && txt.includes('¥11,087.20'));
      assert.ok(txt.includes('第 12 / 21 天'));
    } finally {
      if (vWork) vWork.dispose();
      hWork.dispose();
    }

    const hRest = createElectronHarness({ initialNow: localDate(2026, 11, 21, 10, 0, 0).getTime() });
    let vRest;
    try {
      await hRest.bootMain();
      vRest = await mountRendererWindow(hRest, 'panel');
      const txt = visibleText(vRest.document.body);
      assert.ok(txt.includes('本月日薪'));
      assert.ok(txt.includes('已过 15 / 21 天'));
    } finally {
      if (vRest) vRest.dispose();
      hRest.dispose();
    }
  });

  test('T1-F13-05 里程碑卡片、语录按配置与 isPaid 显隐，老板模式全量遮罩且保留里程碑名称', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 15, 18, 42).getTime(),
    });
    let view;
    try {
      await harness.bootMain();
      view = await mountRendererWindow(harness, 'panel');

      let txt = visibleText(view.document.body);
      assert.ok(txt.includes('刚挣够一顿火锅') && txt.includes('一顿日料'));
      assert.ok(txt.includes('搬砖不易，且搬且珍惜。'));

      // 开启老板模式
      await harness.invokeIpc('boss:set', true);
      await view.flush();
      txt = visibleText(view.document.body);
      assert.ok(txt.includes('¥***.**'), '老板模式大数字应打码');
      assert.ok(txt.includes('刚挣够一顿火锅') && txt.includes('一顿日料'), '老板模式面板仍保留里程碑名称');
      assert.equal(txt.includes('611.01'), false, '老板模式不得泄露今日金额');
      assert.equal(txt.includes('952.38'), false, '老板模式不得泄露日薪');

      // 关闭里程碑与语录开关
      await harness.invokeIpc('settings:update', { milestonesEnabled: false, quotesEnabled: false });
      await view.flush();
      txt = visibleText(view.document.body);
      assert.equal(txt.includes('一顿火锅'), false);
      assert.equal(txt.includes('搬砖不易'), false);
    } finally {
      if (view) view.dispose();
      harness.dispose();
    }
  });

  test('T1-F13-06 主面板底部操作按钮与键盘快捷键触发真实 IPC', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    let view;
    try {
      await harness.bootMain();
      harness.clickTray();
      view = await mountRendererWindow(harness, 'panel');

      // 点击老板模式（就地切换不关面板）
      await view.click(findButtonByText(view.document, '老板模式'));
      assert.equal((await harness.invokeIpc('state:get')).boss, true);
      assert.equal(harness.getPanelWindow().isVisible(), true);

      // Escape 隐藏主面板
      await view.dispatchKey({ key: 'Escape', code: 'Escape' });
      assert.equal(harness.getPanelWindow().isVisible(), false);

      // Ctrl+, 打开设置窗口
      await view.dispatchKey({ key: ',', code: 'Comma', ctrlKey: true });
      assert.ok(harness.getSettingsWindow());

      // 点击退出牛马加油器
      await view.click(findButtonByText(view.document, '退出'));
      assert.equal(harness.state.quitCalled, true);
    } finally {
      if (view) view.dispose();
      harness.dispose();
    }
  });
});

describe('Tier 1 — Renderer F14: 4 页设置窗口 UI 黑盒验证', () => {
  test('T1-F14-01 设置窗口支持 4 标签页切换与 openSettings(tab) 直达指定页', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    let view;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'holidays');
      view = await mountRendererWindow(harness, 'settings');

      const txt = visibleText(view.document.body);
      assert.ok(txt.includes('国务院放假安排') || txt.includes('导入 JSON'), 'openSettings(holidays) 应直达节假日页');

      for (const [tab, marker] of [
        ['薪资', '日薪计算方式'],
        ['作息', '上下班时间'],
        ['显示', '老板模式'],
      ]) {
        await view.click(findButtonByText(view.document, tab));
        assert.ok(visibleText(view.document.body).includes(marker), `切到 ${tab} 页后应显示 "${marker}"`);
      }
    } finally {
      if (view) view.dispose();
      harness.dispose();
    }
  });

  test('T1-F14-02 薪资 Tab 切换时薪隐藏 21.75、更新 4 列预览与小数位持久化', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    let view;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'salary');
      view = await mountRendererWindow(harness, 'settings');

      assert.ok(visibleText(view.document.body).includes('21.75'));

      // 切到时薪 -> 隐藏日薪计算方式
      const hourlyBtn = findInteractiveChoice(view.document, '时薪');
      if (hourlyBtn.localName === 'option') {
        const sel = hourlyBtn.parentElement;
        await view.setValue(sel, hourlyBtn.value);
      } else {
        await view.click(hourlyBtn);
      }
      assert.equal(visibleText(view.document.body).includes('固定 21.75 天'), false, '时薪模式下应隐藏 21.75 选项');

      // 切回月薪并修改金额
      const monthlyBtn = findInteractiveChoice(view.document, '月薪');
      if (monthlyBtn.localName === 'option') {
        await view.setValue(monthlyBtn.parentElement, monthlyBtn.value);
      } else {
        await view.click(monthlyBtn);
      }

      const amountInput = findControlByLabel(view.document, '金额');
      await view.setValue(amountInput, '42000');

      const st = await harness.invokeIpc('state:get');
      assert.equal(st.settings.amount, 42000);
      assert.ok(visibleText(view.document.body).includes('¥2,000.00'), '预览日薪应实时更新为 ¥2,000.00');
    } finally {
      if (view) view.dispose();
      harness.dispose();
    }
  });

  test('T1-F14-03 作息 Tab 午休显隐、跨夜标识、星期切换与零有效工时红字警告', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    let view;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'schedule');
      view = await mountRendererWindow(harness, 'settings');
      await view.click(findButtonByText(view.document, '作息'));

      // 取消午休开关后午休时间应隐藏
      const lunchToggle = findControlByLabel(view.document, '午休');
      await view.click(lunchToggle);
      assert.equal((await harness.invokeIpc('state:get')).settings.lunchEnabled, false);
      assert.equal(visibleText(view.document.body).includes('9.0 小时'), true);

      // 设跨夜班 22:00 - 06:00 -> 应显示（次日）
      const startInput = findControlByLabel(view.document, '上班');
      const endInput = findControlByLabel(view.document, '下班');
      await view.setValue(startInput, '22:00');
      await view.setValue(endInput, '06:00');
      assert.ok(visibleText(view.document.body).includes('次日'));

      // 设 09:00 - 09:00 零有效工时 -> 显示警告文案
      await view.setValue(startInput, '09:00');
      await view.setValue(endInput, '09:00');
      assert.ok(visibleText(view.document.body).includes('有效工时是 0'));
    } finally {
      if (view) view.dispose();
      harness.dispose();
    }
  });

  test('T1-F14-04 作息 Tab 开启大小周并切换本周为小周更新 bigWeekAnchor', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
    });
    let view;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'schedule');
      view = await mountRendererWindow(harness, 'settings');
      await view.click(findButtonByText(view.document, '作息'));

      const toggle = findControlByLabel(view.document, '大小周');
      await view.click(toggle);

      const st1 = await harness.invokeIpc('state:get');
      assert.equal(st1.settings.bigSmallWeek, true);
      assert.equal(st1.settings.bigWeekAnchor, '2026-11-16');

      const smallWeekChoice = findInteractiveChoice(view.document, '小周（本周六休息）');
      await view.click(smallWeekChoice);
      const st2 = await harness.invokeIpc('state:get');
      assert.equal(st2.settings.bigWeekAnchor, '2026-11-23');
    } finally {
      if (view) view.dispose();
      harness.dispose();
    }
  });

  test('T1-F14-05 节假日 Tab 月历点选设置带薪假与备注、删除标记与 JSON 导入清除', async () => {
    const tmpJson = path.join(os.tmpdir(), `niuma-hol-${Date.now()}.json`);
    fs.writeFileSync(
      tmpJson,
      JSON.stringify([{ date: '2028-01-01', type: 'holiday', name: '2028元旦' }]),
      'utf8'
    );
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 10, 0, 0).getTime(),
      openDialogResult: { canceled: false, filePaths: [tmpJson] },
    });
    let view;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'holidays');
      view = await mountRendererWindow(harness, 'settings');
      await view.click(findButtonByText(view.document, '节假日'));

      // 选中日历中 18 号单元格
      const dayButtons = view.document
        .querySelectorAll('button')
        .filter((b) => {
          if (!isVisible(b)) return false;
          const aria = b.getAttribute('aria-label') || '';
          const txt = b.textContent.trim();
          return aria.includes('11月18日') || /^18(\D|$)/.test(txt);
        });
      assert.ok(dayButtons.length > 0, '日历中应渲染 18 号按钮');
      await view.click(dayButtons[0]);

      // 设置为带薪假并填写备注
      await view.click(findInteractiveChoice(view.document, '带薪假'));
      const noteInput = findControlByLabel(view.document, '备注');
      await view.setValue(noteInput, '婚假');

      let st = await harness.invokeIpc('state:get');
      assert.deepEqual(st.settings.manualMarks, [{ date: '2026-11-18', kind: 'paidLeave', note: '婚假' }]);

      // 导入 JSON 并验证清除导入按钮出现与清除
      await view.click(findButtonByText(view.document, '导入 JSON'));
      st = await harness.invokeIpc('state:get');
      assert.equal(st.settings.importedHolidays.length, 1);
      assert.ok(visibleText(view.document.body).includes('另外导入了 1 天') || visibleText(view.document.body).includes('已导入 1 天'));

      await view.click(findButtonByText(view.document, '清除导入'));
      st = await harness.invokeIpc('state:get');
      assert.equal(st.settings.importedHolidays.length, 0);
    } finally {
      if (view) view.dispose();
      harness.dispose();
      fs.rmSync(tmpJson, { force: true });
    }
  });

  test('T1-F14-06 显示 Tab 实时格式预览、里程碑恢复默认/保存、老板开关与开机自启同步', async () => {
    const harness = createElectronHarness({
      initialNow: localDate(2026, 11, 17, 15, 18, 42).getTime(),
    });
    let view;
    try {
      await harness.bootMain();
      await harness.invokeIpc('window:openSettings', 'display');
      view = await mountRendererWindow(harness, 'settings');
      await view.click(findButtonByText(view.document, '显示'));

      const txt = visibleText(view.document.body);
      assert.ok(txt.includes('¥611.01') && txt.includes('¥611 · 64%') && txt.includes('2:41:18'));

      // 切换老板开关
      const bossToggle = findControlByLabel(view.document, '现在开启');
      await view.click(bossToggle);
      assert.equal((await harness.invokeIpc('state:get')).boss, true);
      assert.ok(visibleText(view.document.body).includes('¥***.**'));

      // 展开或编辑里程碑并保存
      const editToggle = view.document
        .querySelectorAll('summary, button')
        .find((el) => isVisible(el) && el.textContent.includes('编辑里程碑'));
      if (editToggle) await view.click(editToggle);

      const textarea = view.document.querySelector('textarea');
      assert.ok(textarea, '显示页应包含里程碑编辑文本框');
      await view.setValue(textarea, '可乐,5\n汉堡,35');
      await view.click(findButtonByText(view.document, '保存'));

      const st = await harness.invokeIpc('state:get');
      assert.deepEqual(st.settings.milestones, [
        { name: '可乐', amount: 5 },
        { name: '汉堡', amount: 35 },
      ]);

      // 开机自启开关
      const loginToggle = findControlByLabel(view.document, '开机自动启动');
      await view.click(loginToggle);
      assert.equal(harness.state.loginItem.openAtLogin, true);
    } finally {
      if (view) view.dispose();
      harness.dispose();
    }
  });
});

describe('Tier 1 — Docs & Integrity F15: README 中文指南与 16 个 macOS Swift 文件完整性保护', () => {
  const BASELINE_FILES = [
    { rel: 'Package.swift', bytes: 483, sha16: '5094FB2279BFFAF9' },
    { rel: 'build.sh', bytes: 3363, sha16: '3390E9B541E1C5C7' },
    { rel: 'Scripts/make-icon.swift', bytes: 1628, sha16: '9FEEBA2A13E32817' },
    { rel: 'Assets/AppIcon.svg', bytes: 3144, sha16: '01E95E4317E4DA21' },
    { rel: 'Sources/NiumaCore/Display.swift', bytes: 6978, sha16: '0309CE6654A018E6' },
    { rel: 'Sources/NiumaCore/HolidayData.swift', bytes: 3802, sha16: '8CB46376F0685037' },
    { rel: 'Sources/NiumaCore/Settings.swift', bytes: 8344, sha16: 'ECCDEF23A27A475C' },
    { rel: 'Sources/NiumaCore/WageEngine.swift', bytes: 11579, sha16: '840850D40E35B4D9' },
    { rel: 'Sources/NiumaBooster/AppDelegate.swift', bytes: 10604, sha16: '5C9664EC57E70743' },
    { rel: 'Sources/NiumaBooster/AppState.swift', bytes: 2536, sha16: '576F0E982142C3C7' },
    { rel: 'Sources/NiumaBooster/Debug.swift', bytes: 9487, sha16: '10C927290B343FFD' },
    { rel: 'Sources/NiumaBooster/main.swift', bytes: 677, sha16: '849AB1F0D1DF163F' },
    { rel: 'Sources/NiumaBooster/PanelView.swift', bytes: 12472, sha16: 'BD9A9E2E8F66256E' },
    { rel: 'Sources/NiumaBooster/SettingsViews.swift', bytes: 28975, sha16: 'F9D9B1FDA5E0CDA6' },
    { rel: 'Sources/NiumaBooster/System.swift', bytes: 6233, sha16: '0B77D56E168B332D' },
    { rel: 'Tests/NiumaCoreTests/WageEngineTests.swift', bytes: 13250, sha16: '4D7DC1C73C7BC844' },
  ];

  test('T1-F15-01 README.md 完整保留原 macOS Swift 构建与测试说明', () => {
    const { readmeMd } = requireRepoPaths();
    const content = fs.readFileSync(readmeMd, 'utf8');
    for (const anchor of ['macOS 13+', './build.sh', 'swift test', 'Sources/NiumaCore', 'Sources/NiumaBooster', 'Tests/NiumaCoreTests', 'MIT']) {
      assert.ok(content.includes(anchor), `README.md 应保留 macOS 锚点: ${anchor}`);
    }
  });

  test('T1-F15-02 README.md 包含完整 Windows（Electron）中文安装、运行与手动测试指南', () => {
    const { readmeMd } = requireRepoPaths();
    const content = fs.readFileSync(readmeMd, 'utf8');
    for (const anchor of ['Windows', 'Electron', 'npm install', 'npm start', 'npm test', 'npm run dist', '托盘', '老板键']) {
      assert.ok(content.includes(anchor), `README.md 缺少 Windows 指引锚点: ${anchor}`);
    }
  });

  test('T1-F15-03 全部 16 个 macOS Swift 基线文件均存在且非空', () => {
    const { repoRoot } = requireRepoPaths();
    for (const item of BASELINE_FILES) {
      const full = path.join(repoRoot, item.rel);
      assert.equal(fs.existsSync(full), true, `基线文件缺失: ${item.rel}`);
      assert.ok(fs.statSync(full).size > 0, `基线文件为空: ${item.rel}`);
    }
  });

  test('T1-F15-04 Package.swift、build.sh 与 Assets/AppIcon.svg 内容锚点完好', () => {
    const { repoRoot } = requireRepoPaths();
    const pkgSwift = fs.readFileSync(path.join(repoRoot, 'Package.swift'), 'utf8');
    assert.ok(pkgSwift.includes('name: "NiumaBooster"'));
    assert.ok(pkgSwift.includes('.target(name: "NiumaCore")'));
    assert.ok(pkgSwift.includes('.executableTarget(name: "NiumaBooster"'));
    assert.ok(pkgSwift.includes('.testTarget(name: "NiumaCoreTests"'));

    const buildSh = fs.readFileSync(path.join(repoRoot, 'build.sh'), 'utf8');
    assert.ok(buildSh.includes('BUNDLE_ID="local.niuma.booster"'));

    const svg = fs.readFileSync(path.join(repoRoot, 'Assets/AppIcon.svg'), 'utf8');
    assert.ok(svg.includes('<svg') && svg.includes('牛马加油器'));
  });

  test('T1-F15-05 全部 16 个 macOS Swift 基线文件 SHA-256 哈希与字节数零篡改', () => {
    const { repoRoot } = requireRepoPaths();
    for (const item of BASELINE_FILES) {
      const full = path.join(repoRoot, item.rel);
      const buf = fs.readFileSync(full);
      assert.equal(buf.length, item.bytes, `${item.rel} 字节数被篡改`);
      const sha16 = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16).toUpperCase();
      assert.equal(sha16, item.sha16, `${item.rel} SHA-256 校验失败`);
    }
  });

  test('T1-F15-06 git status 确认 macOS 受保护目录与文件工作区干净', () => {
    const { repoRoot } = requireRepoPaths();
    const out = execFileSync(
      'git',
      ['-C', repoRoot, 'status', '--porcelain', '--', 'Package.swift', 'Sources', 'Tests', 'build.sh', 'Scripts', 'Assets'],
      { encoding: 'utf8' }
    );
    assert.equal(out.trim(), '', `macOS 基线路径不得有任何修改，实际:\n${out}`);
  });
});
