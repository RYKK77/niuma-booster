import AppKit
import Carbon
import NiumaCore
import ServiceManagement
import UserNotifications

// MARK: - 牛头图标（和设计稿同一套线条，模板图自动适配深浅色菜单栏）

enum OxIcon {
    static let template: NSImage = make(size: 16, color: .black, template: true)

    static func make(size: CGFloat, color: NSColor, template: Bool) -> NSImage {
        let img = NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
            let k = rect.width / 16
            let p = NSBezierPath()
            p.lineWidth = 1.4 * k
            p.lineCapStyle = .round
            p.lineJoinStyle = .round
            func pt(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: x * k, y: y * k) }
            // 左角
            p.move(to: pt(1.5, 2.5))
            p.curve(to: pt(5, 6), controlPoint1: pt(1.7, 4.5), controlPoint2: pt(2.9, 5.8))
            // 右角
            p.move(to: pt(14.5, 2.5))
            p.curve(to: pt(11, 6), controlPoint1: pt(14.3, 4.5), controlPoint2: pt(13.1, 5.8))
            // 脸
            p.move(to: pt(5, 6))
            p.line(to: pt(11, 6))
            p.line(to: pt(10.4, 11.2))
            p.appendArc(withCenter: pt(8, 11.2), radius: 2.4 * k, startAngle: 0, endAngle: 180, clockwise: false)
            p.close()
            color.setStroke()
            p.stroke()
            return true
        }
        img.isTemplate = template
        img.accessibilityDescription = "牛马加油器"
        return img
    }
}

// MARK: - 全局快捷键（Carbon，不需要辅助功能权限）

final class HotKey {
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let action: () -> Void

    init?(_ preset: BossHotkey, action: @escaping () -> Void) {
        let combo: (UInt32, UInt32)
        switch preset {
        case .ctrlOptB: combo = (UInt32(kVK_ANSI_B), UInt32(controlKey | optionKey))
        case .ctrlOptCmdH: combo = (UInt32(kVK_ANSI_H), UInt32(controlKey | optionKey | cmdKey))
        case .off: return nil
        }
        self.action = action
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
            guard let userData else { return noErr }
            let me = Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { me.action() }
            return noErr
        }, 1, &spec, selfPtr, &handler)
        let id = EventHotKeyID(signature: OSType(0x4E4D_4A59), id: 1)
        let status = RegisterEventHotKey(combo.0, combo.1, id, GetApplicationEventTarget(), 0, &ref)
        if status != noErr {
            NSLog("牛马加油器：快捷键注册失败 \(status)")
        }
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        if let handler { RemoveEventHandler(handler) }
    }
}

// MARK: - 通知（只在真正的 .app 里用，裸二进制下调用会崩）

enum Notifier {
    static var available: Bool {
        Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app"
    }

    static func requestPermission() {
        guard available else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    static func post(_ title: String, _ body: String) {
        guard available else { return }
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        c.sound = .default
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }
}

// MARK: - 开机自启（只允许从「应用程序」目录里的 .app 注册）

enum LoginItem {
    static var canUse: Bool {
        let path = Bundle.main.bundleURL.path
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return Bundle.main.bundleURL.pathExtension == "app"
            && (path.hasPrefix("/Applications/") || path.hasPrefix(home + "/Applications/"))
    }

    static var isEnabled: Bool {
        guard Notifier.available else { return false }
        return SMAppService.mainApp.status == .enabled
    }

    static func set(_ on: Bool) throws {
        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }
}

// MARK: - 里程碑和下班通知

/// 只对「运行中新跨过」的里程碑发通知。启动、唤醒、改时间后先静默对齐，避免一口气弹一串。
final class Cheerleader {
    private var dayKey: String?
    private var lastEarned: Double = 0
    private var offWorkSent = false

    func prime(_ s: Snapshot, calendar: Calendar) {
        dayKey = DayKey.key(s.shiftDay, calendar: calendar)
        lastEarned = s.earnedToday
        offWorkSent = s.phase == .afterWork
    }

    func update(_ s: Snapshot, settings: AppSettings, calendar: Calendar, money: Money, boss: Bool) {
        let key = DayKey.key(s.shiftDay, calendar: calendar)
        if key != dayKey {
            dayKey = key
            lastEarned = 0
            offWorkSent = false
        }
        defer { lastEarned = s.earnedToday }
        guard s.day.accrues else { return }

        // 老板模式下不弹里程碑（名字会暴露收入），下班通知也不带金额
        if settings.milestonesEnabled, !boss {
            for m in Milestones.crossed(from: lastEarned, to: s.earnedToday, list: settings.milestones) {
                Notifier.post("刚挣够\(m.name)", "今日已到账 \(money.string(m.amount, decimals: 0))+，继续加油。")
            }
        }
        if settings.offWorkNotification, s.phase == .afterWork, !offWorkSent {
            offWorkSent = true
            Notifier.post("下班啦", boss ? "今天的钱已全部到账，润！" : "今日 \(money.string(s.earnedToday)) 已全部到账，润！")
        }
    }
}
