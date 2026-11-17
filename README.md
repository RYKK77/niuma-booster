# 牛马加油器

Mac 菜单栏小工具：按秒显示今天已经挣到多少钱。自用，不联网，设置只存在本机。

## 构建与安装

需要 Xcode（或 Command Line Tools）。支持 macOS 13 及以上，Apple 芯片和 Intel 都能跑。

```bash
./build.sh            # 生成 build/牛马加油器.app，本地 ad-hoc 签名
./build.sh install    # 另外复制到 ~/Applications 并打开（开机自启需要装在这里）
swift test            # 跑计薪逻辑的单元测试
```

调试用：

```bash
swift run NiumaBooster --dump "2026-11-17 15:18:42"   # 打印该时刻的菜单栏文字和计算结果（默认设置）
swift run NiumaBooster --render ./render              # 把面板和设置页离屏渲染成 PNG
```

## 计算规则

- 日薪 = 月薪 ÷ 当月计薪工作日（也可选固定 21.75 天）；年薪按 12 个月折算；时薪 × 每天有效工时。
- 计薪工作日 = 每周工作日 − 法定节假日 + 调休补班日，带薪假照算。
- 判断某天是什么日子的优先级：手动标记 > 导入的 JSON > 内置国务院安排 > 每周作息（含大小周）。
- 每秒按当前时间重新计算，不累加，睡眠唤醒、改系统时间后也准。
- 跨夜班（下班早于上班）算在上班那天。
- 带薪假当天直接显示全天日薪。

## 节假日

内置 2026、2027 年国务院放假安排：

- 2026 年：[国办发明电〔2025〕7号](https://www.news.cn/politics/20251104/88bcffd88ae249e58c699b8772548e3d/c.html)
- 2027 年：[国办发明电〔2026〕10号](https://www.news.cn/politics/20261105/f90cd6ad4df94ab4833b141e52ccfc13/c.html)

以后的年份可以在「设置 › 节假日」导入 JSON，格式：

```json
[
  {"date": "2028-01-01", "type": "holiday", "name": "元旦"},
  {"date": "2028-01-02", "type": "workday", "name": "元旦"}
]
```

`type` 为 `holiday`（放假）或 `workday`（调休上班）。

## 代码结构

- `Sources/NiumaCore`：纯 Foundation 的计薪引擎、节假日数据、设置模型、菜单栏文案（有单测）
- `Sources/NiumaBooster`：AppKit 菜单栏（`NSStatusItem` + 等宽数字）、SwiftUI 面板和设置窗口、全局快捷键、通知、开机自启
- `Tests/NiumaCoreTests`：设计稿上的数字、各月计薪日、跨夜班、手动标记、大小周等
