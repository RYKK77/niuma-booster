import AppKit
import SwiftUI
import UniformTypeIdentifiers
import NiumaCore

private let tabWidth: CGFloat = 620

private struct Hint: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(.system(size: 12)).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - 薪资

struct SalaryTab: View {
    @ObservedObject var state: AppState

    var body: some View {
        let s = state.snapshot
        let st = state.settings
        Form {
            Section("收入") {
                Picker("收入类型", selection: $state.settings.incomeType) {
                    ForEach(IncomeType.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                TextField("\(st.incomeType.label)金额（\(st.currency)）", value: $state.settings.amount,
                          format: .number.precision(.fractionLength(0...2)))
                    .multilineTextAlignment(.trailing)
                Hint(st.incomeType == .yearly
                     ? "年薪按 12 个月折算成月薪。税前、到手都可以，按你想看的口径填。"
                     : "税前、到手都可以，按你想看的口径填。改完按回车生效。")
            }
            if st.incomeType != .hourly {
                Section("日薪计算方式") {
                    Picker("", selection: $state.settings.basis) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("按当月实际计薪工作日")
                            Hint("工作日 − 法定节假日 + 调休补班日，带薪假照算。每个月日薪会不一样。")
                        }
                        .tag(WageBasis.actualWorkdays)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("固定 21.75 天")
                            Hint("劳动法的月计薪天数，每月日薪一样。")
                        }
                        .tag(WageBasis.fixed2175)
                    }
                    .pickerStyle(.radioGroup)
                    .labelsHidden()
                }
            }
            Section("本月算出来是这样") {
                let month = state.calendar.component(.month, from: s.shiftDay)
                HStack(spacing: 10) {
                    metric("\(month) 月计薪日", "\(s.paidDaysInMonth) 天")
                    arrow
                    metric("日薪", state.money.string(s.dailyWage))
                    arrow
                    metric("时薪（\(hours(s.shift.effectiveSeconds))）", state.money.string(s.hourly))
                    arrow
                    metric("每秒", state.money.string(s.perSecond, decimals: 4), accent: true)
                }
                .padding(.vertical, 6)
            }
            Section("金额格式") {
                TextField("货币符号", text: $state.settings.currency)
                    .multilineTextAlignment(.trailing)
                Picker("小数位", selection: $state.settings.decimals) {
                    Text("0").tag(0); Text("2").tag(2); Text("4").tag(4)
                }
                .pickerStyle(.segmented)
            }
        }
        .formStyle(.grouped)
        .frame(width: tabWidth, height: 610)
    }

    private var arrow: some View {
        Image(systemName: "arrow.right").font(.system(size: 11)).foregroundStyle(.tertiary)
    }

    private func metric(_ label: String, _ value: String, accent: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            Text(value).font(.system(size: 16, weight: .semibold)).monospacedDigit()
                .foregroundStyle(accent ? Theme.accentText : Color.primary)
                .lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func hours(_ sec: Double) -> String {
        let h = sec / 3600
        return h.rounded() == h ? "\(Int(h)) 小时" : String(format: "%.1f 小时", h)
    }
}

// MARK: - 作息

struct ScheduleTab: View {
    @ObservedObject var state: AppState
    private let weekOrder: [(Int, String)] = [(2, "一"), (3, "二"), (4, "三"), (5, "四"), (6, "五"), (7, "六"), (1, "日")]

    var body: some View {
        let st = state.settings
        let today = state.calendar.startOfDay(for: state.now)
        let sh = state.engine.shift(on: today)
        Form {
            Section("上下班时间") {
                DatePicker("上班", selection: minutes(\.workStart), displayedComponents: .hourAndMinute)
                DatePicker("下班", selection: minutes(\.workEnd), displayedComponents: .hourAndMinute)
                Toggle("午休（不计薪）", isOn: $state.settings.lunchEnabled)
                if st.lunchEnabled {
                    DatePicker("午休开始", selection: minutes(\.lunchStart), displayedComponents: .hourAndMinute)
                    DatePicker("午休结束", selection: minutes(\.lunchEnd), displayedComponents: .hourAndMinute)
                }
            }
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("每天计薪时段").fontWeight(.semibold)
                        Spacer()
                        Text("有效工时 ") + Text(String(format: "%.1f 小时", sh.effectiveSeconds / 3600)).bold()
                    }
                    ShiftBar(shift: sh, now: nil, height: 18)
                    HStack {
                        Text(Fmt.clock(st.workStart))
                        Spacer()
                        if sh.lunchStart != nil {
                            Text("午休 \(Fmt.clock(st.lunchStart))–\(Fmt.clock(st.lunchEnd))")
                            Spacer()
                        }
                        Text(Fmt.clock(st.workEnd) + (st.workEnd < st.workStart ? "（次日）" : ""))
                    }
                    .font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary)
                    if sh.effectiveSeconds <= 0 {
                        Text("有效工时是 0，检查一下上下班和午休时间。").font(.system(size: 12)).foregroundStyle(.red)
                    }
                    Hint("下班时间早于上班时间时按跨夜班算，这一班算在上班那天（比如 22:00 上班、次日 06:00 下班）。")
                }
                .padding(.vertical, 4)
            }
            Section("每周工作日") {
                HStack(spacing: 6) {
                    ForEach(weekOrder, id: \.0) { wd, name in
                        let on = st.workWeekdays.contains(wd)
                        Button {
                            if on { state.settings.workWeekdays.remove(wd) } else { state.settings.workWeekdays.insert(wd) }
                        } label: {
                            Text(name)
                                .font(.system(size: 13, weight: on ? .semibold : .regular))
                                .frame(width: 34, height: 28)
                                .foregroundStyle(on ? Color.white : Color.primary)
                                .background(on ? Theme.accent : Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 7))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("周\(name)")
                        .accessibilityAddTraits(on ? .isSelected : [])
                    }
                    Spacer()
                }
                Hint("法定节假日和调休会自动叠加在上面，不用手动改。")
                Toggle("大小周（隔一周的周六上班）", isOn: Binding(
                    get: { state.settings.bigSmallWeek },
                    set: { state.settings.setBigSmallWeek($0, today: state.now, calendar: state.calendar) }))
                if st.bigSmallWeek {
                    Picker("本周是", selection: bigWeekBinding) {
                        Text("大周（本周六上班）").tag(true)
                        Text("小周（本周六休息）").tag(false)
                    }
                    .pickerStyle(.radioGroup)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: tabWidth, height: 620)
    }

    private func minutes(_ kp: WritableKeyPath<AppSettings, Int>) -> Binding<Date> {
        let cal = state.calendar
        let base = cal.startOfDay(for: Date())
        return Binding(
            get: { cal.date(byAdding: .minute, value: state.settings[keyPath: kp], to: base)! },
            set: { d in
                let c = cal.dateComponents([.hour, .minute], from: d)
                state.settings[keyPath: kp] = (c.hour ?? 0) * 60 + (c.minute ?? 0)
            })
    }

    private var bigWeekBinding: Binding<Bool> {
        Binding(
            get: { state.engine.workCalendar.isBigWeek(state.now) },
            set: { big in
                let cal = state.calendar
                var mon = WorkCalendar.monday(of: state.now, calendar: cal)
                if !big { mon = cal.date(byAdding: .day, value: 7, to: mon)! }
                state.settings.bigWeekAnchor = DayKey.key(mon, calendar: cal)
            })
    }
}

// MARK: - 节假日

struct HolidaysTab: View {
    @ObservedObject var state: AppState
    @State private var month: Date
    @State private var selected: String? = nil
    @State private var importMessage: String? = nil

    init(state: AppState) {
        _state = ObservedObject(wrappedValue: state)
        _month = State(initialValue: state.calendar.startOfDay(for: state.now))
    }

    private var cal: Calendar { state.calendar }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("已内置 \(BuiltinHolidays.years.map(String.init).joined(separator: "、")) 年国务院放假安排")
                        .font(.system(size: 13, weight: .semibold))
                    Hint(importMessage ?? (state.settings.importedHolidays.isEmpty
                         ? "以后的年份公布后，导入 JSON 或在日历里手动标记即可。"
                         : "另外导入了 \(state.settings.importedHolidays.count) 天，导入的优先于内置。"))
                }
                Spacer()
                if !state.settings.importedHolidays.isEmpty {
                    Button("清除导入") { state.settings.importedHolidays = []; importMessage = nil }
                }
                Button("导入 JSON…") { importJSON() }
            }
            .padding(12)
            .background(.background, in: RoundedRectangle(cornerRadius: 10))

            HStack(alignment: .top, spacing: 16) {
                calendarBox.frame(width: 330)
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        noticeList
                        manualList
                    }
                }
            }
        }
        .padding(20)
        .frame(width: tabWidth + 80, height: 600)
    }

    // 日历

    private var monthDays: [Date] { state.engine.workCalendar.daysInMonth(of: month) }

    private var calendarBox: some View {
        let days = monthDays
        let first = days[0]
        let lead = (cal.component(.weekday, from: first) + 5) % 7
        let cols = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)
        let wc = state.engine.workCalendar
        let paid = wc.paidDays(inMonthOf: first).count
        let c = cal.dateComponents([.year, .month], from: first)
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button { shift(-1) } label: { Image(systemName: "chevron.left") }.accessibilityLabel("上个月")
                Spacer()
                Text("\(String(c.year!)) 年 \(c.month!) 月").font(.system(size: 14, weight: .semibold))
                Spacer()
                Button { shift(1) } label: { Image(systemName: "chevron.right") }.accessibilityLabel("下个月")
            }
            LazyVGrid(columns: cols, spacing: 4) {
                ForEach(["一", "二", "三", "四", "五", "六", "日"], id: \.self) {
                    Text($0).font(.system(size: 11)).foregroundStyle(.secondary)
                }
                ForEach(0..<lead, id: \.self) { _ in Color.clear.frame(height: 40) }
                ForEach(days, id: \.self) { d in cell(d) }
            }
            HStack(spacing: 10) {
                legend("休", "法定假日/手动休息", Theme.holidayBg, Theme.holidayFg)
                legend("班", "补班/手动上班", Theme.workBg, Theme.workFg)
                legend("假", "带薪假", Theme.leaveBg, Theme.leaveFg)
            }
            .font(.system(size: 11))
            Divider()
            HStack {
                Text("\(c.month!) 月计薪工作日 ") + Text("\(paid) 天").bold()
                Spacer()
                Text("日薪 ") + Text(state.money.string(state.engine.dailyWage(for: first))).bold().foregroundColor(Theme.accentText)
            }
            .font(.system(size: 13)).monospacedDigit()
            editor
        }
        .padding(12)
        .background(.background, in: RoundedRectangle(cornerRadius: 10))
    }

    private func cell(_ d: Date) -> some View {
        let wc = state.engine.workCalendar
        let info = wc.info(for: d)
        let key = wc.key(d)
        let isSel = key == selected
        let isToday = cal.isDate(d, inSameDayAs: state.now)
        let tag: (String, Color, Color)? = {
            switch info.kind {
            case .holiday, .manualRest: return ("休", Theme.holidayBg, Theme.holidayFg)
            case .makeupWorkday, .manualWork: return ("班", Theme.workBg, Theme.workFg)
            case .paidLeave: return ("假", Theme.leaveBg, Theme.leaveFg)
            case .workday, .weekend: return nil
            }
        }()
        let manual = wc.manualMark(forKey: key) != nil
        return Button { selected = key } label: {
            VStack(spacing: 1) {
                Text("\(cal.component(.day, from: d))")
                    .font(.system(size: 13, weight: isToday ? .bold : .regular))
                    .foregroundStyle(info.isPaid ? Color.primary : Color.secondary)
                if let tag {
                    Text(tag.0).font(.system(size: 9, weight: .semibold))
                        .padding(.horizontal, 3)
                        .foregroundStyle(tag.2)
                        .background(tag.1, in: RoundedRectangle(cornerRadius: 3))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 40)
            .background(info.isPaid ? Theme.card : Color.clear, in: RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(isSel ? Theme.accent : (manual ? Color.secondary.opacity(0.5) : .clear),
                                                              lineWidth: isSel ? 2 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(cal.component(.month, from: d))月\(cal.component(.day, from: d))日 \(Fmt.kindLabel(info))")
    }

    private func legend(_ t: String, _ label: String, _ bg: Color, _ fg: Color) -> some View {
        HStack(spacing: 4) {
            Text(t).font(.system(size: 9, weight: .semibold)).padding(.horizontal, 3)
                .foregroundStyle(fg).background(bg, in: RoundedRectangle(cornerRadius: 3))
            Text(label).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var editor: some View {
        if let key = selected, let comps = DayKey.parse(key), let date = cal.date(from: comps) {
            let mark = state.settings.manualMarks.first { $0.date == key }
            let defaultInfo: DayInfo = {
                var s = state.settings
                s.setMark(nil, for: key)
                return WorkCalendar(settings: s, calendar: cal).info(for: date)
            }()
            VStack(alignment: .leading, spacing: 6) {
                Text("\(comps.month!)月\(comps.day!)日 · 默认：\(Fmt.kindLabel(defaultInfo))")
                    .font(.system(size: 12, weight: .semibold))
                Picker("", selection: Binding<ManualKind?>(
                    get: { mark?.kind },
                    set: { k in state.settings.setMark(k.map { ManualMark(date: key, kind: $0, note: mark?.note ?? "") }, for: key) })) {
                    Text("默认").tag(ManualKind?.none)
                    Text("工作日").tag(ManualKind?.some(.work))
                    Text("休息").tag(ManualKind?.some(.rest))
                    Text("带薪假").tag(ManualKind?.some(.paidLeave))
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                if let mark {
                    TextField("备注（比如：年假、公司放假）", text: Binding(
                        get: { mark.note },
                        set: { n in var m = mark; m.note = n; state.settings.setMark(m, for: key) }))
                    .textFieldStyle(.roundedBorder)
                }
            }
        } else {
            Hint("点日期可改成：工作日 / 休息（不计薪）/ 带薪假（按全天计），或恢复默认。")
        }
    }

    private func shift(_ n: Int) {
        let first = state.engine.workCalendar.daysInMonth(of: month)[0]
        month = cal.date(byAdding: .month, value: n, to: first)!
        selected = nil
    }

    // 右侧列表

    private var noticeList: some View {
        let year = cal.component(.year, from: month)
        let groups = noticeGroups(year: year)
        return VStack(alignment: .leading, spacing: 6) {
            Text("\(String(year)) 法定节假日").font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
            VStack(spacing: 0) {
                if groups.isEmpty {
                    Hint("\(String(year)) 年还没有数据，导入 JSON 或在日历里手动标记。").padding(12)
                }
                ForEach(groups, id: \.name) { g in
                    HStack(alignment: .firstTextBaseline) {
                        Text(g.name).font(.system(size: 13))
                        Spacer()
                        Text(g.detail).font(.system(size: 12)).foregroundStyle(.secondary).monospacedDigit()
                    }
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    Divider().padding(.leading, 12)
                }
            }
            .background(.background, in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private struct Group { let name: String; let detail: String }

    private func noticeGroups(year: Int) -> [Group] {
        var map: [String: (holidays: [String], work: [String])] = [:]
        var order: [String] = []
        let all = HolidayImport.merge(BuiltinHolidays.entries, state.settings.importedHolidays)
        for e in all where e.date.hasPrefix("\(year)-") {
            if map[e.name] == nil { order.append(e.name); map[e.name] = ([], []) }
            if e.type == .holiday { map[e.name]!.holidays.append(e.date) } else { map[e.name]!.work.append(e.date) }
        }
        func md(_ k: String) -> String {
            guard let c = DayKey.parse(k) else { return k }
            return "\(c.month!)/\(c.day!)"
        }
        order.sort { a, b in
            (map[a]!.holidays.min() ?? map[a]!.work.min() ?? "") < (map[b]!.holidays.min() ?? map[b]!.work.min() ?? "")
        }
        return order.compactMap { name in
            guard let v = map[name] else { return nil }
            let h = v.holidays.sorted()
            var s = h.isEmpty ? "" : (h.count == 1 ? md(h[0]) : "\(md(h.first!))–\(md(h.last!))")
            if !v.work.isEmpty { s += (s.isEmpty ? "" : " · ") + "补班 " + v.work.sorted().map(md).joined(separator: "、") }
            return Group(name: name, detail: s)
        }
    }

    private var manualList: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("我的手动标记").font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
            VStack(spacing: 0) {
                if state.settings.manualMarks.isEmpty {
                    Hint("还没有。点左边日历里的日期来标记。").padding(12)
                }
                ForEach(state.settings.manualMarks) { m in
                    HStack {
                        Text(m.date).font(.system(size: 13)).monospacedDigit()
                        Spacer()
                        Text(m.note.isEmpty ? m.kind.label : "\(m.kind.label) · \(m.note)")
                            .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                        Button { state.settings.setMark(nil, for: m.date) } label: { Image(systemName: "xmark.circle.fill") }
                            .buttonStyle(.plain).foregroundStyle(.tertiary)
                            .accessibilityLabel("删除 \(m.date) 的标记")
                    }
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    Divider().padding(.leading, 12)
                }
            }
            .background(.background, in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private func importJSON() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.message = "格式：[{\"date\":\"2028-01-01\",\"type\":\"holiday\",\"name\":\"元旦\"}, …]，type 为 holiday（放假）或 workday（补班）"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let list = try HolidayImport.parse(Data(contentsOf: url))
            state.settings.importedHolidays = HolidayImport.merge(state.settings.importedHolidays, list)
            importMessage = "已导入 \(list.count) 天。"
        } catch {
            importMessage = "导入失败：文件不是正确的格式。"
        }
    }
}

// MARK: - 显示与通用

struct DisplayTab: View {
    @ObservedObject var state: AppState
    @State private var milestoneText = ""
    @State private var editingMilestones = false
    @State private var loginOn = LoginItem.isEnabled
    @State private var loginError: String? = nil

    var body: some View {
        let st = state.settings
        Form {
            Section("菜单栏") {
                HStack {
                    Text("预览").foregroundStyle(.secondary)
                    Spacer()
                    StatusPreview(state: state)
                }
                Picker("显示格式", selection: $state.settings.menuBarFormat) {
                    ForEach(MenuBarFormat.allCases) { f in
                        HStack {
                            Text(f == .amountOnly ? "\(f.label)（默认）" : f.label)
                            Spacer()
                            Text(sample(f)).foregroundStyle(.secondary).monospacedDigit()
                        }
                        .tag(f)
                    }
                }
                .pickerStyle(.inline)
                Toggle("显示牛头图标", isOn: $state.settings.showIcon)
                Picker("非上班时间", selection: $state.settings.offHoursDisplay) {
                    Text("显示状态文字").tag(OffHoursDisplay.text)
                    Text("只显示图标").tag(OffHoursDisplay.iconOnly)
                }
                .pickerStyle(.segmented)
            }
            Section("老板模式") {
                Picker("快捷键", selection: $state.settings.bossHotkey) {
                    ForEach(BossHotkey.allCases) { Text($0.label).tag($0) }
                }
                Toggle("现在开启（金额全部打码）", isOn: $state.boss)
                Hint("不用 ⌥⌘H：那是系统「隐藏其他应用」的快捷键，全局占用会影响所有 App。")
            }
            Section("加油") {
                Toggle("里程碑提示（面板显示，跨过时发通知）", isOn: $state.settings.milestonesEnabled)
                DisclosureGroup("编辑里程碑", isExpanded: $editingMilestones) {
                    VStack(alignment: .leading, spacing: 6) {
                        TextEditor(text: $milestoneText)
                            .font(.system(size: 12).monospacedDigit())
                            .frame(height: 110)
                        HStack {
                            Hint("每行一个：名称,金额")
                            Spacer()
                            Button("恢复默认") { milestoneText = Milestones.format(Milestone.defaults) }
                            Button("保存") {
                                let list = Milestones.parse(milestoneText)
                                if !list.isEmpty { state.settings.milestones = list }
                                milestoneText = Milestones.format(state.settings.milestones)
                            }
                            .keyboardShortcut(.defaultAction)
                        }
                    }
                }
                Toggle("面板显示加油语录", isOn: $state.settings.quotesEnabled)
                Toggle("下班时发通知", isOn: $state.settings.offWorkNotification)
            }
            Section("通用") {
                Toggle("开机自动启动", isOn: Binding(
                    get: { loginOn },
                    set: { on in
                        do {
                            try LoginItem.set(on)
                            loginError = nil
                        } catch {
                            loginError = "设置失败：\(error.localizedDescription)"
                        }
                        loginOn = LoginItem.isEnabled
                    }))
                .disabled(!LoginItem.canUse)
                if !LoginItem.canUse {
                    Hint("要先用 ./build.sh install 装到「应用程序」文件夹，再从那里打开，才能开启。")
                }
                if let loginError { Text(loginError).font(.system(size: 12)).foregroundStyle(.red) }
            }
        }
        .formStyle(.grouped)
        .frame(width: tabWidth, height: 780)
        .onAppear {
            milestoneText = Milestones.format(st.milestones)
            loginOn = LoginItem.isEnabled
        }
    }

    /// 用当前的真实数字给每种格式做示例
    private func sample(_ f: MenuBarFormat) -> String {
        var s = state.settings
        s.menuBarFormat = f
        let line = StatusText.make(state.snapshot, settings: s, boss: state.boss)
        return f == .iconOnly ? "金额只在面板里看" : ([line.prefix, line.main].compactMap { $0 }.joined(separator: " "))
    }
}

/// 设置页里的菜单栏预览，和真菜单栏用同一套文字
struct StatusPreview: View {
    @ObservedObject var state: AppState
    var body: some View {
        let line = StatusText.make(state.snapshot, settings: state.settings, boss: state.boss)
        let showIcon = state.settings.showIcon || line.forceIcon || line.main.isEmpty
        HStack(spacing: 5) {
            if showIcon { Image(nsImage: OxIcon.template).renderingMode(.template) }
            if let b = line.badge {
                Text(b).font(.system(size: 10, weight: .semibold)).padding(.horizontal, 3)
                    .foregroundStyle(Theme.workFg).background(Theme.workBg, in: RoundedRectangle(cornerRadius: 3))
            }
            if let p = line.prefix { Text(p).foregroundStyle(.secondary) }
            if !line.main.isEmpty { Text(line.main).monospacedDigit() }
            if line.check { Image(systemName: "checkmark").foregroundStyle(Theme.green).font(.system(size: 11, weight: .bold)) }
        }
        .font(.system(size: 13, weight: .medium))
        .padding(.horizontal, 10)
        .frame(height: 24)
        .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 6))
    }
}
