import AppKit
import SwiftUI
import NiumaCore

final class AppDelegate: NSObject, NSApplicationDelegate {
    let state = AppState()
    private var status: StatusController!
    private let settingsWindow = SettingsWindowController()
    private let cheer = Cheerleader()
    private var timer: Timer?
    private var hotKey: HotKey?
    private var observers: [NSObjectProtocol] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMainMenu()
        status = StatusController(state: state, openSettings: { [weak self] in self?.openSettings() })

        state.onChange = { [weak self] old in
            guard let self else { return }
            if old.bossHotkey != self.state.settings.bossHotkey { self.applyHotkey() }
            if !old.offWorkNotification && self.state.settings.offWorkNotification
                || !old.milestonesEnabled && self.state.settings.milestonesEnabled {
                Notifier.requestPermission()
            }
            // 改了薪资/作息后金额会跳变，重新对齐，免得把中间的里程碑全当成刚跨过
            self.cheer.prime(self.state.snapshot, calendar: self.state.calendar)
            self.status.render()
        }
        applyHotkey()
        if state.settings.offWorkNotification || state.settings.milestonesEnabled {
            Notifier.requestPermission()
        }

        tick(prime: true)
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.tick(prime: false) }
        t.tolerance = 0.1
        RunLoop.main.add(t, forMode: .common)
        timer = t

        // 睡眠唤醒、改系统时间、换时区、跨天：重新对齐，不补发通知
        let ws = NSWorkspace.shared.notificationCenter
        observers.append(ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.tick(prime: true)
        })
        let nc = NotificationCenter.default
        for name in [Notification.Name.NSSystemClockDidChange, .NSSystemTimeZoneDidChange, .NSCalendarDayChanged] {
            observers.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.state.rebuild()
                self?.tick(prime: true)
            })
        }
        debugOpenIfRequested()
    }

    private func tick(prime: Bool) {
        state.tick()
        status.render()
        if prime {
            cheer.prime(state.snapshot, calendar: state.calendar)
        } else {
            cheer.update(state.snapshot, settings: state.settings, calendar: state.calendar, money: state.money, boss: state.boss)
        }
    }

    /// 调试：--debug-open panel | settings:0…3，打开后打印窗口在屏幕上的位置（左上角原点），方便截图检查
    private func debugOpenIfRequested() {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--debug-open"), i + 1 < args.count else { return }
        let what = args[i + 1]
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [self] in
            var window: NSWindow?
            if what == "panel" {
                window = status.debugShowPopover()
            } else if what.hasPrefix("settings:"), let n = Int(what.dropFirst("settings:".count)) {
                openSettings()
                window = settingsWindow.select(tab: n)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                guard let f = window?.frame, let h = NSScreen.screens.first?.frame.height else { return }
                print("FRAME \(Int(f.minX)) \(Int(h - f.maxY)) \(Int(f.width)) \(Int(f.height))")
                fflush(stdout)
            }
        }
    }

    private func applyHotkey() {
        hotKey = nil
        hotKey = HotKey(state.settings.bossHotkey) { [weak self] in self?.state.boss.toggle() }
    }

    func openSettings() {
        status.closePopover()
        settingsWindow.show(state: state)
    }

    /// 菜单栏应用没有主菜单时，设置页文本框里 ⌘C/⌘V/⌘A 不起作用，补一个最小主菜单
    private func setupMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "设置…", action: #selector(openSettingsAction), keyEquivalent: ",").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        appMenu.addItem(withTitle: "退出牛马加油器", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        NSApp.mainMenu = main
    }

    @objc private func openSettingsAction() { openSettings() }
}

// MARK: - 菜单栏

final class StatusController: NSObject {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
    private let state: AppState
    private var lastTitle: NSAttributedString?

    init(state: AppState, openSettings: @escaping () -> Void) {
        self.state = state
        super.init()
        popover.behavior = .transient
        popover.animates = false
        let host = NSHostingController(rootView: PanelView(state: state, openSettings: openSettings))
        host.sizingOptions = [.preferredContentSize]
        popover.contentViewController = host
        if let b = item.button {
            b.target = self
            b.action = #selector(toggle)
            b.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        render()
    }

    func render() {
        guard let b = item.button else { return }
        let line = StatusText.make(state.snapshot, settings: state.settings, boss: state.boss)
        let title = StatusController.attributed(line)
        let showIcon = state.settings.showIcon || line.forceIcon || title.length == 0
        b.image = showIcon ? OxIcon.template : nil
        b.imagePosition = title.length == 0 ? .imageOnly : .imageLeading
        if title != lastTitle {
            b.attributedTitle = title
            lastTitle = title
        }
        b.setAccessibilityLabel("牛马加油器 " + line.plainText)
    }

    /// 等宽数字，每秒刷新时宽度不抖
    static func attributed(_ line: StatusLine) -> NSAttributedString {
        let size = NSFont.menuBarFont(ofSize: 0).pointSize
        let mono = NSFont.monospacedDigitSystemFont(ofSize: size, weight: .regular)
        let out = NSMutableAttributedString()
        func add(_ s: String, _ font: NSFont = mono, _ color: NSColor = .labelColor, baseline: CGFloat = 0) {
            if out.length > 0 { out.append(NSAttributedString(string: " ", attributes: [.font: mono])) }
            out.append(NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: color, .baselineOffset: baseline]))
        }
        if let badge = line.badge {
            add(badge, NSFont.systemFont(ofSize: size - 3, weight: .semibold), .secondaryLabelColor, baseline: 1)
        }
        if let p = line.prefix { add(p, mono, .secondaryLabelColor) }
        if !line.main.isEmpty { add(line.main) }
        if line.check { add("✓", NSFont.systemFont(ofSize: size, weight: .semibold), .systemGreen) }
        return out
    }

    @objc private func toggle() {
        if popover.isShown {
            popover.performClose(nil)
        } else if let b = item.button {
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: b.bounds, of: b, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    func closePopover() { if popover.isShown { popover.performClose(nil) } }

    func debugShowPopover() -> NSWindow? {
        if !popover.isShown { toggle() }
        return popover.contentViewController?.view.window
    }
}

// MARK: - 设置窗口

final class SettingsWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?

    func show(state: AppState) {
        if window == nil {
            let tabs = NSTabViewController()
            tabs.tabStyle = .toolbar
            tabs.canPropagateSelectedChildViewControllerTitle = true
            func add<V: View>(_ title: String, _ symbol: String, _ view: V) {
                let host = NSHostingController(rootView: view)
                host.sizingOptions = [.preferredContentSize]
                host.title = title
                let it = NSTabViewItem(viewController: host)
                it.label = title
                it.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
                tabs.addTabViewItem(it)
            }
            add("薪资", "banknote", SalaryTab(state: state))
            add("作息", "clock", ScheduleTab(state: state))
            add("节假日", "calendar", HolidaysTab(state: state))
            add("显示", "menubar.rectangle", DisplayTab(state: state))
            let w = NSWindow(contentViewController: tabs)
            w.styleMask = [.titled, .closable]
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func select(tab n: Int) -> NSWindow? {
        if let tabs = window?.contentViewController as? NSTabViewController, tabs.tabViewItems.indices.contains(n) {
            tabs.selectedTabViewItemIndex = n
        }
        return window
    }
}
