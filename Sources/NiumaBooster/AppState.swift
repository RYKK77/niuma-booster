import AppKit
import Combine
import NiumaCore

/// 全局状态：设置（持久化）、当前计算结果、老板模式。
final class AppState: ObservableObject {
    static let defaultsKey = "niuma.settings.v1"

    @Published var settings: AppSettings {
        didSet {
            guard settings != oldValue else { return }
            save()
            rebuild()
            onChange?(oldValue)
        }
    }
    @Published var boss = false {
        didSet { if boss != oldValue { onChange?(settings) } }
    }
    @Published private(set) var snapshot: Snapshot
    private(set) var engine: WageEngine

    /// 设置或老板模式变了（参数是旧设置）
    var onChange: ((AppSettings) -> Void)?

    private let store: UserDefaults?
    /// 离屏渲染时固定时间
    var fixedNow: Date?

    init(store: UserDefaults? = .standard, fixedNow: Date? = nil) {
        self.store = store
        self.fixedNow = fixedNow
        var s = AppSettings()
        if let data = store?.data(forKey: AppState.defaultsKey),
           let decoded = try? JSONDecoder().decode(AppSettings.self, from: data) {
            s = decoded
        }
        settings = s
        let e = WageEngine(settings: s, calendar: AppState.calendar())
        engine = e
        snapshot = e.snapshot(at: fixedNow ?? Date())
    }

    static func calendar() -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone.current
        c.locale = Locale(identifier: "zh_CN")
        return c
    }

    var calendar: Calendar { engine.calendar }
    var now: Date { fixedNow ?? Date() }

    /// 时区或设置变化后重建引擎
    func rebuild() {
        NSTimeZone.resetSystemTimeZone()
        engine = WageEngine(settings: settings, calendar: AppState.calendar())
        snapshot = engine.snapshot(at: now)
    }

    func tick() {
        let s = engine.snapshot(at: now)
        if s != snapshot { snapshot = s }
    }

    private func save() {
        guard let store, let data = try? JSONEncoder().encode(settings) else { return }
        store.set(data, forKey: AppState.defaultsKey)
    }

    var money: Money { Money(settings) }

    /// 老板模式下所有金额都打码
    func amount(_ v: Double, decimals: Int? = nil) -> String {
        if boss { return Money(currency: settings.currency, decimals: decimals ?? settings.decimals).masked }
        return money.string(v, decimals: decimals)
    }
}
