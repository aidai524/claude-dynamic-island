// ClaudeIsland: the screen-top island for every Claude Code session.
//
// Each session that loads the dynamic-island plugin writes its progress to
// ~/.claude/dynamic-island/sessions/<session id>.json. This app reads them all
// and draws one black capsule at the top of each display: hugging the notch
// where there is one, as a virtual notch in the middle of the menu bar where
// there is none. Hover it to see every session; it hides when nothing runs.
//
// Build: island/build.sh    Preview without a screen: ClaudeIsland --snapshot <dir>

import AppKit
import SwiftUI

// MARK: - What the plugin writes

struct Snapshot: Decodable {
    struct Step: Decodable {
        let title: String
        let status: String
        let active: String?
    }

    struct Tool: Decodable {
        let label: String
        let detail: String
    }

    struct Job: Decodable {
        let label: String
        let status: String
        let kind: String
    }

    let sessionId: String
    let cwd: String?
    let prompt: String?
    let phase: String
    let waiting: String?
    let waitingTool: String?
    let turnStartedAt: Double?
    let lastDurationMs: Double?
    let endedAt: Double?
    let plan: [Snapshot.Step]?
    let tool: Snapshot.Tool?
    let jobs: [Snapshot.Job]?
    let closed: Bool?
    let updatedAt: Double
}

// MARK: - What the island shows

/// Most urgent first: the order rows sort in and the capsule picks its lead by.
enum Tone: Int {
    case wait = 0, work, error, done

    var color: Color {
        switch self {
        case .work: return Color(red: 0.365, green: 0.792, blue: 0.647)
        case .wait: return Color(red: 0.937, green: 0.624, blue: 0.153)
        case .done: return Color(red: 0.592, green: 0.769, blue: 0.349)
        case .error: return Color(red: 0.941, green: 0.584, blue: 0.584)
        }
    }

    var isAlive: Bool { self == .work || self == .wait }
}

struct Row: Identifiable, Equatable {
    let id: String
    let title: String
    let tone: Tone
    /// The step in progress (or its present-continuous form).
    let step: String?
    let done: Int
    let total: Int
    /// The running tool, `Bash · 跑测试`.
    let tool: String?
    /// What the person is asked for, or how the turn ended.
    let note: String?
    let startedAt: Date?
    let durationMs: Double?
    let endedAt: Double?
    let jobsRunning: Int
}

/// Cut to a display width: a CJK character counts two, others one.
func short(_ text: String, _ width: Int) -> String {
    var used = 0
    var out = ""
    for ch in text {
        let w = ch.unicodeScalars.contains { $0.value >= 0x2E80 } ? 2 : 1
        if used + w > width - 1 { return out + "…" }
        used += w
        out.append(ch)
    }
    return out
}

func clock(_ seconds: TimeInterval) -> String {
    let total = max(0, Int(seconds))
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    let rest = total % 60
    return hours > 0
        ? String(format: "%d:%02d:%02d", hours, minutes, rest)
        : String(format: "%02d:%02d", minutes, rest)
}

// MARK: - Store: every session's file, read twice a second

final class Store: ObservableObject {
    @Published private(set) var rows: [Row] = []
    @Published private(set) var peek: Row?
    @Published private(set) var hiddenUntil: Date?

    /// True while any display's island is open: a peek then waits.
    var isExpanded = false {
        didSet { if isExpanded { clearPeek() } }
    }

    private let sessionsDir: URL?
    private let metaDir: URL?
    private var snaps: [String: (mtime: Date, snap: Snapshot)] = [:]
    private var meta: [URL: Meta] = [:]
    private var titles: [String: (title: String?, archived: Bool, focusedAt: Double?)] = [:]
    private var metaScannedAt = Date.distantPast
    private var seenEnd: [String: Double] = [:]
    private var lastTone: [String: Tone] = [:]
    private var isPrimed = false
    private var peekWork: DispatchWorkItem?

    private struct Meta {
        let mtime: Date
        let ids: [String]
        let title: String?
        let archived: Bool
        /// When the person last opened the session in Claude, epoch ms.
        let focusedAt: Double?
    }

    init(home: URL) {
        sessionsDir = home.appendingPathComponent(".claude/dynamic-island/sessions", isDirectory: true)
        metaDir = home.appendingPathComponent(
            "Library/Application Support/Claude/claude-code-sessions", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: sessionsDir!, withIntermediateDirectories: true)
    }

    /// A store of fixed rows, for previews.
    init(rows: [Row], peek: Row? = nil) {
        sessionsDir = nil
        metaDir = nil
        self.rows = rows
        self.peek = peek
    }

    var isHidden: Bool { hiddenUntil.map { $0 > Date() } ?? false }

    var isShowing: Bool { !isHidden && (!rows.isEmpty || peek != nil) }

    func hide(for seconds: TimeInterval) {
        hiddenUntil = Date().addingTimeInterval(seconds)
        clearPeek()
    }

    func poll(now: Date = Date()) {
        guard sessionsDir != nil else { return }
        if let until = hiddenUntil, until <= now { hiddenUntil = nil }
        readSessions(now: now)
        let unknown = snaps.keys.contains { titles[$0] == nil }
        if now.timeIntervalSince(metaScannedAt) > 8 || (unknown && now.timeIntervalSince(metaScannedAt) > 2) {
            scanTitles()
            metaScannedAt = now
        }
        let next = snaps.values.compactMap { row(for: $0.snap, now: now) }.sorted(by: Store.order)
        noticeChanges(next)
        if next != rows { rows = next }
    }

    func markSeen(_ row: Row) {
        if let ended = row.endedAt { seenEnd[row.id] = ended }
        poll()
    }

    /// The person has looked: finished sessions leave the island.
    func markFinishedSeen() {
        for row in rows where !row.tone.isAlive {
            if let ended = row.endedAt { seenEnd[row.id] = ended }
        }
        poll()
    }

    static func order(_ a: Row, _ b: Row) -> Bool {
        if a.tone != b.tone { return a.tone.rawValue < b.tone.rawValue }
        let ka = a.startedAt?.timeIntervalSince1970 ?? (a.endedAt ?? 0) / 1000
        let kb = b.startedAt?.timeIntervalSince1970 ?? (b.endedAt ?? 0) / 1000
        return ka > kb
    }

    private func readSessions(now: Date) {
        guard let dir = sessionsDir else { return }
        let fm = FileManager.default
        let urls = (try? fm.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles])) ?? []
        var present = Set<String>()
        for url in urls where url.pathExtension == "json" {
            let id = url.deletingPathExtension().lastPathComponent
            let mtime = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
            // A file nobody wrote for a day belongs to a session long gone.
            if now.timeIntervalSince(mtime) > 86_400 {
                try? fm.removeItem(at: url)
                continue
            }
            present.insert(id)
            if let cached = snaps[id], cached.mtime == mtime { continue }
            guard let data = try? Data(contentsOf: url),
                  let snap = try? JSONDecoder().decode(Snapshot.self, from: data)
            else { continue }  // half written: read again next time
            snaps[id] = (mtime, snap)
        }
        snaps = snaps.filter { present.contains($0.key) }
    }

    /// The Claude app's own titles for its Code sessions, by session id.
    private func scanTitles() {
        guard let dir = metaDir,
              let walker = FileManager.default.enumerator(
                  at: dir, includingPropertiesForKeys: [.contentModificationDateKey],
                  options: [.skipsHiddenFiles])
        else { return }
        var fresh: [URL: Meta] = [:]
        for case let url as URL in walker {
            guard url.lastPathComponent.hasPrefix("local_"), url.pathExtension == "json" else { continue }
            let mtime = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
            if let cached = meta[url], cached.mtime == mtime {
                fresh[url] = cached
                continue
            }
            guard let data = try? Data(contentsOf: url),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            let ids = ["cliSessionId", "lastAssistantCliSessionId"]
                .compactMap { object[$0] as? String }
                .filter { !$0.isEmpty }
            let title = (object["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            fresh[url] = Meta(
                mtime: mtime, ids: ids, title: title,
                archived: object["isArchived"] as? Bool ?? false,
                focusedAt: (object["lastFocusedAt"] as? NSNumber)?.doubleValue)
        }
        meta = fresh
        var map: [String: (title: String?, archived: Bool, focusedAt: Double?)] = [:]
        for entry in fresh.values {
            for id in entry.ids { map[id] = (entry.title, entry.archived, entry.focusedAt) }
        }
        titles = map
    }

    private func fallbackTitle(_ s: Snapshot) -> String {
        if let prompt = s.prompt, !prompt.isEmpty { return String(prompt.prefix(40)) }
        if let cwd = s.cwd, !cwd.isEmpty { return (cwd as NSString).lastPathComponent }
        return "Claude 会话"
    }

    private func waitingNote(_ s: Snapshot) -> String? {
        switch s.waiting {
        case "permission": return "等你授权" + (s.waitingTool.map { " \($0)" } ?? "")
        case "question": return "等你回答问题"
        case "plan": return "等你审阅计划"
        default: return nil
        }
    }

    private func row(for s: Snapshot, now: Date) -> Row? {
        if s.closed == true { return nil }
        let known = titles[s.sessionId]
        if known?.archived == true { return nil }
        let nowMs = now.timeIntervalSince1970 * 1000
        let steps = s.plan ?? []
        let done = steps.filter { $0.status == "completed" }.count
        let current = steps.first { $0.status == "in_progress" }
        let tool = s.tool.map { $0.detail.isEmpty ? $0.label : "\($0.label) · \($0.detail)" }
        let jobsRunning = (s.jobs ?? []).filter { $0.status == "running" }.count
        let title = known?.title ?? fallbackTitle(s)

        switch s.phase {
        case "working":
            // A working session writes every few seconds: silence means it is gone.
            guard nowMs - s.updatedAt < 120_000 else { return nil }
            return Row(
                id: s.sessionId, title: title, tone: s.waiting == nil ? .work : .wait,
                step: current.map { $0.active ?? $0.title }, done: done, total: steps.count,
                tool: tool, note: waitingNote(s),
                startedAt: s.turnStartedAt.map { Date(timeIntervalSince1970: $0 / 1000) },
                durationMs: nil, endedAt: nil, jobsRunning: jobsRunning)
        case "done", "error":
            guard let ended = s.endedAt, nowMs - ended < 30 * 60_000 else { return nil }
            if let seen = seenEnd[s.sessionId], seen >= ended { return nil }
            // Opened in Claude since it ended: the person has read it.
            if let focused = known?.focusedAt, focused >= ended { return nil }
            let tone: Tone = s.phase == "done" ? .done : .error
            return Row(
                id: s.sessionId, title: title, tone: tone, step: nil, done: done,
                total: steps.count, tool: nil, note: tone == .done ? "已完成" : "出错了",
                startedAt: nil, durationMs: s.lastDurationMs, endedAt: ended,
                jobsRunning: jobsRunning)
        default:
            return nil
        }
    }

    /// A session that starts waiting, finishes or fails pops the capsule open.
    private func noticeChanges(_ next: [Row]) {
        defer {
            isPrimed = true
            lastTone = Dictionary(next.map { ($0.id, $0.tone) }, uniquingKeysWith: { a, _ in a })
        }
        guard isPrimed, !isExpanded, !isHidden else { return }
        if let changed = next.first(where: { $0.tone != .work && lastTone[$0.id] != $0.tone }) {
            showPeek(changed)
        }
    }

    private func showPeek(_ row: Row) {
        peekWork?.cancel()
        peek = row
        let work = DispatchWorkItem { [weak self] in self?.peek = nil }
        peekWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 4.5, execute: work)
    }

    private func clearPeek() {
        peekWork?.cancel()
        peekWork = nil
        if peek != nil { peek = nil }
    }
}

// MARK: - One display's geometry and state

final class ScreenUI: ObservableObject {
    @Published var isExpanded = false
    @Published var hasNotch = false
    @Published var notchWidth: CGFloat = 0
    @Published var barHeight: CGFloat = 24
    /// Where the island sits in the panel, top-left origin: what hover tests.
    var islandFrame: CGRect = .zero
}

// MARK: - Views

struct IslandShape: Shape {
    var radius: CGFloat

    func path(in rect: CGRect) -> Path {
        UnevenRoundedRectangle(
            topLeadingRadius: 0, bottomLeadingRadius: radius,
            bottomTrailingRadius: radius, topTrailingRadius: 0, style: .continuous
        ).path(in: rect)
    }
}

struct BreathingDot: View {
    let color: Color
    var size: CGFloat = 8
    @State private var isOut = false

    var body: some View {
        ZStack {
            Circle().fill(color.opacity(0.55))
                .frame(width: size, height: size)
                .scaleEffect(isOut ? 2.4 : 1)
                .opacity(isOut ? 0 : 0.9)
            Circle().fill(color).frame(width: size, height: size)
        }
        .frame(width: size, height: size)
        .onAppear {
            withAnimation(.easeOut(duration: 1.5).repeatForever(autoreverses: false)) { isOut = true }
        }
    }
}

struct ToneIcon: View {
    let tone: Tone
    var size: CGFloat = 8

    var body: some View {
        switch tone {
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: size + 4, weight: .semibold)).foregroundStyle(tone.color)
        case .error:
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: size + 4, weight: .semibold)).foregroundStyle(tone.color)
        case .work, .wait:
            BreathingDot(color: tone.color, size: size)
        }
    }
}

struct Elapsed: View {
    let since: Date

    var body: some View {
        TimelineView(.periodic(from: Date(), by: 1)) { context in
            Text(clock(context.date.timeIntervalSince(since))).monospacedDigit()
        }
    }
}

/// The lead row's side facts: what it waits on, its count, its clock.
struct LeadFacts: View {
    let row: Row

    var body: some View {
        HStack(spacing: 6) {
            if let note = row.note, row.tone != .work {
                Text(note).foregroundStyle(row.tone.color)
            }
            if row.total > 0, row.tone == .work {
                Text("\(row.done)/\(row.total)").monospacedDigit().foregroundStyle(.secondary)
            }
            if row.tone.isAlive, let since = row.startedAt {
                Elapsed(since: since).foregroundStyle(.secondary)
            } else if !row.tone.isAlive, let ms = row.durationMs {
                Text("用时 " + clock(ms / 1000)).monospacedDigit().foregroundStyle(.secondary)
            }
        }
        .lineLimit(1)
        .fixedSize()
    }
}

struct CompactIsland: View {
    let rows: [Row]
    @ObservedObject var ui: ScreenUI
    let onExpand: () -> Void

    private var lead: Row { rows[0] }
    private var alive: Int { rows.filter { $0.tone.isAlive }.count }
    private var headline: String {
        if alive > 1 { return "\(alive) 个会话进行中" }
        return lead.step ?? lead.title
    }

    var body: some View {
        Group {
            if ui.hasNotch {
                // The notch sits in the middle: the words go on its two wings.
                HStack(spacing: 0) {
                    HStack(spacing: 7) {
                        ToneIcon(tone: lead.tone)
                        Text(short(headline, 16)).lineLimit(1)
                    }
                    .frame(width: 128, alignment: .leading)
                    Color.clear.frame(width: ui.notchWidth)
                    LeadFacts(row: lead).frame(width: 128, alignment: .trailing)
                }
            } else {
                HStack(spacing: 8) {
                    ToneIcon(tone: lead.tone)
                    Text(short(headline, 26)).lineLimit(1)
                    LeadFacts(row: lead)
                }
                .fixedSize()
            }
        }
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .frame(height: ui.barHeight)
        .background(IslandShape(radius: ui.hasNotch ? 12 : 11).fill(.black))
        .contentShape(Rectangle())
        .onTapGesture(perform: onExpand)
    }
}

struct PeekIsland: View {
    let row: Row
    @ObservedObject var ui: ScreenUI
    let onExpand: () -> Void

    var body: some View {
        Group {
            if ui.hasNotch {
                HStack(spacing: 0) {
                    HStack(spacing: 7) {
                        ToneIcon(tone: row.tone, size: 9)
                        Text(short(row.title, 22)).lineLimit(1)
                    }
                    .frame(width: 180, alignment: .leading)
                    Color.clear.frame(width: ui.notchWidth)
                    LeadFacts(row: row).frame(width: 180, alignment: .trailing)
                }
            } else {
                HStack(spacing: 9) {
                    ToneIcon(tone: row.tone, size: 9)
                    Text(short(row.title, 34)).lineLimit(1)
                    LeadFacts(row: row)
                }
                .fixedSize()
            }
        }
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 18)
        .frame(height: ui.barHeight + 8)
        .background(IslandShape(radius: 16).fill(.black))
        .contentShape(Rectangle())
        .onTapGesture(perform: onExpand)
    }
}

struct RowView: View {
    let row: Row
    let onOpen: (Row) -> Void
    @State private var isHovered = false

    private var detail: String? {
        var parts: [String] = []
        if let step = row.step { parts.append(step) }
        if let tool = row.tool { parts.append(tool) }
        if row.jobsRunning > 0 { parts.append("子任务 \(row.jobsRunning) 个运行中") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                ToneIcon(tone: row.tone).frame(width: 12)
                Text(row.title).font(.system(size: 13, weight: .semibold))
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 8)
                HStack(spacing: 6) {
                    if let note = row.note { Text(note).foregroundStyle(row.tone.color) }
                    if row.total > 0 {
                        Text("\(row.done)/\(row.total)").monospacedDigit().foregroundStyle(.secondary)
                    }
                    if row.tone.isAlive, let since = row.startedAt {
                        Elapsed(since: since).foregroundStyle(.secondary)
                    } else if let ms = row.durationMs {
                        Text("用时 " + clock(ms / 1000)).monospacedDigit().foregroundStyle(.secondary)
                    }
                }
                .font(.system(size: 12))
                .lineLimit(1)
            }
            if let detail {
                Text(detail).font(.system(size: 11.5))
                    .foregroundStyle(Color.white.opacity(0.62))
                    .lineLimit(1).truncationMode(.tail)
                    .padding(.leading, 20)
            }
        }
        .foregroundStyle(.white)
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.white.opacity(isHovered ? 0.09 : 0)))
        .contentShape(Rectangle())
        .onHover { isHovered = $0 }
        .onTapGesture { onOpen(row) }
    }
}

struct ExpandedIsland: View {
    let rows: [Row]
    @ObservedObject var ui: ScreenUI
    let onOpen: (Row) -> Void
    let onHide: () -> Void

    private var summary: String {
        let alive = rows.filter { $0.tone.isAlive }.count
        let ended = rows.count - alive
        var parts: [String] = []
        if alive > 0 { parts.append("\(alive) 个进行中") }
        if ended > 0 { parts.append("\(ended) 个刚结束") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            // The strip the notch or the menu bar takes: the title rides in it
            // where there is no notch in the way.
            HStack {
                if !ui.hasNotch {
                    Text("Claude 灵动岛").font(.system(size: 12, weight: .semibold))
                    Text(summary).font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .frame(height: ui.barHeight)
            .padding(.horizontal, 8)

            ForEach(rows.prefix(8)) { row in
                RowView(row: row, onOpen: onOpen)
            }
            if rows.count > 8 {
                Text("还有 \(rows.count - 8) 个会话").font(.system(size: 11.5))
                    .foregroundStyle(.secondary).padding(.horizontal, 8)
            }

            HStack(spacing: 14) {
                Text(ui.hasNotch ? "Claude 灵动岛 · \(summary)" : "点一行打开 Claude")
                    .foregroundStyle(.secondary)
                Spacer()
                Button("隐藏 1 小时", action: onHide).buttonStyle(.plain).foregroundStyle(.secondary)
            }
            .font(.system(size: 11))
            .padding(.horizontal, 8)
            .padding(.top, 6)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 10)
        .padding(.bottom, 12)
        .frame(width: max(470, ui.notchWidth + 300))
        .background(IslandShape(radius: 22).fill(.black))
    }
}

struct FrameKey: PreferenceKey {
    static var defaultValue: CGRect = .zero
    /// Siblings that draw no island hand in the default: they must not wipe it.
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        let next = nextValue()
        if next != .zero { value = next }
    }
}

struct IslandRoot: View {
    @ObservedObject var store: Store
    @ObservedObject var ui: ScreenUI
    var onExpand: () -> Void = {}
    let onOpen: (Row) -> Void
    let onHide: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            if store.isShowing {
                content
                    .background(GeometryReader { proxy in
                        Color.clear.preference(key: FrameKey.self, value: proxy.frame(in: .named("root")))
                    })
                    .transition(.opacity)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .coordinateSpace(name: "root")
        .onPreferenceChange(FrameKey.self) { ui.islandFrame = $0 }
        .animation(.spring(response: 0.36, dampingFraction: 0.82), value: ui.isExpanded)
        .animation(.spring(response: 0.36, dampingFraction: 0.82), value: store.peek?.id)
        .animation(.easeInOut(duration: 0.2), value: store.rows)
        .environment(\.colorScheme, .dark)
    }

    @ViewBuilder private var content: some View {
        if ui.isExpanded, !store.rows.isEmpty {
            ExpandedIsland(rows: store.rows, ui: ui, onOpen: onOpen, onHide: onHide)
        } else if let peek = store.peek {
            PeekIsland(row: peek, ui: ui, onExpand: onExpand)
        } else if !store.rows.isEmpty {
            CompactIsland(rows: store.rows, ui: ui, onExpand: onExpand)
        }
    }
}

// MARK: - Windows

final class IslandPanel: NSPanel {
    init() {
        super.init(
            contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        isFloatingPanel = true
        level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        isMovable = false
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class ScreenController {
    static let panelSize = NSSize(width: 680, height: 560)

    let screen: NSScreen
    let panel = IslandPanel()
    let ui = ScreenUI()
    private let store: Store
    private var hoverSince: Date?
    private var leaveSince: Date?
    private var expandedSince: Date?

    /// `offscreen` lays the panel out far from every display: the hover test's.
    init(screen: NSScreen, store: Store, app: AppController, offscreen: Bool = false) {
        self.screen = screen
        self.store = store
        let root = IslandRoot(
            store: store, ui: ui,
            onExpand: { [weak self] in self?.expand() },
            onOpen: { [weak app] row in app?.open(row) },
            onHide: { [weak app] in app?.hideForAnHour() })
        let host = FirstClickHostingView(rootView: root)
        host.frame = NSRect(origin: .zero, size: Self.panelSize)
        panel.contentView = host
        layout()
        if offscreen { panel.setFrameOrigin(NSPoint(x: -20_000, y: -20_000)) }
        panel.orderFrontRegardless()
    }

    func layout() {
        let frame = screen.frame
        if screen.safeAreaInsets.top > 0,
           let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            ui.hasNotch = true
            ui.notchWidth = max(0, frame.width - left.width - right.width)
            ui.barHeight = screen.safeAreaInsets.top
        } else {
            ui.hasNotch = false
            ui.notchWidth = 0
            let menuBar = frame.maxY - screen.visibleFrame.maxY
            ui.barHeight = menuBar > 12 ? menuBar : 24
        }
        panel.setFrame(
            NSRect(
                x: frame.midX - Self.panelSize.width / 2, y: frame.maxY - Self.panelSize.height,
                width: Self.panelSize.width, height: Self.panelSize.height),
            display: true)
    }

    func screenRect(_ rect: CGRect) -> NSRect {
        let frame = panel.frame
        return NSRect(x: frame.minX + rect.minX, y: frame.maxY - rect.maxY, width: rect.width, height: rect.height)
    }

    /// Thirty times a second: open on a short hover, close soon after leaving.
    func track(mouse point: NSPoint, now: Date) {
        guard store.isShowing, !store.rows.isEmpty else {
            if ui.isExpanded { collapse() }
            panel.ignoresMouseEvents = true
            hoverSince = nil
            return
        }
        let isInside = screenRect(ui.islandFrame).insetBy(dx: -4, dy: -4).contains(point)
        if ui.isExpanded {
            panel.ignoresMouseEvents = !isInside
            if isInside {
                leaveSince = nil
            } else {
                let since = leaveSince ?? now
                leaveSince = since
                if now.timeIntervalSince(since) > 0.3 { collapse() }
            }
        } else {
            // Over the capsule it takes the click; anywhere else clicks pass
            // through to the menu bar and the windows beneath.
            panel.ignoresMouseEvents = !isInside
            if isInside {
                let since = hoverSince ?? now
                hoverSince = since
                if now.timeIntervalSince(since) > 0.25 { expand() }
            } else {
                hoverSince = nil
            }
        }
    }

    var isExpanded: Bool { ui.isExpanded }

    func expand() {
        hoverSince = nil
        leaveSince = nil
        expandedSince = Date()
        ui.isExpanded = true
        panel.ignoresMouseEvents = false
    }

    func collapse() {
        let hasLooked = expandedSince.map { Date().timeIntervalSince($0) > 0.8 } ?? false
        ui.isExpanded = false
        expandedSince = nil
        leaveSince = nil
        panel.ignoresMouseEvents = true
        if hasLooked { store.markFinishedSeen() }
    }

    func close() {
        panel.orderOut(nil)
    }
}

// MARK: - App

final class AppController: NSObject, NSApplicationDelegate {
    private var store: Store!
    private var screens: [ScreenController] = []
    private var timers: [Timer] = []

    static let home = FileManager.default.homeDirectoryForCurrentUser
    /// Written by `/island app off`: the plugin starts no island while it stands.
    static let offFlag = home.appendingPathComponent(".claude/dynamic-island/off")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let me = Bundle.main.bundleIdentifier ?? "local.claude-island"
        if NSRunningApplication.runningApplications(withBundleIdentifier: me).count > 1 {
            NSApp.terminate(nil)
            return
        }
        // Opened again (by hand): automatic starts come back.
        try? FileManager.default.removeItem(at: Self.offFlag)

        store = Store(home: Self.home)
        store.poll()
        rebuildScreens()
        NotificationCenter.default.addObserver(
            self, selector: #selector(screensChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)

        let poll = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
        let mouse = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.trackMouse() }
        for timer in [poll, mouse] {
            RunLoop.main.add(timer, forMode: .common)
            timers.append(timer)
        }
    }

    @objc private func screensChanged() {
        rebuildScreens()
    }

    private func rebuildScreens() {
        screens.forEach { $0.close() }
        screens = NSScreen.screens.map { ScreenController(screen: $0, store: store, app: self) }
    }

    private func tick() {
        store.poll()
        store.isExpanded = screens.contains { $0.isExpanded }
    }

    private func trackMouse() {
        let point = NSEvent.mouseLocation
        let now = Date()
        for screen in screens { screen.track(mouse: point, now: now) }
        store.isExpanded = screens.contains { $0.isExpanded }
    }

    func open(_ row: Row) {
        store.markSeen(row)
        screens.forEach { $0.collapse() }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.anthropic.claudefordesktop") {
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    func hideForAnHour() {
        screens.forEach { $0.collapse() }
        store.hide(for: 3600)
    }
}

// MARK: - Previews without a screen

@MainActor
func renderSnapshots(to dir: URL, live: Bool) {
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let now = Date()
    let sample: [Row] = [
        Row(id: "a", title: "修复登录页样式", tone: .wait, step: "跑端到端测试", done: 2, total: 3,
            tool: "Bash · npx playwright test", note: "等你授权 Bash", startedAt: now.addingTimeInterval(-312),
            durationMs: nil, endedAt: nil, jobsRunning: 0),
        Row(id: "b", title: "给博客加深色模式", tone: .work, step: "调整配色变量",
            done: 3, total: 6, tool: "编辑 · theme.css", note: nil, startedAt: now.addingTimeInterval(-102),
            durationMs: nil, endedAt: nil, jobsRunning: 1),
        Row(id: "c", title: "写周报", tone: .done, step: nil, done: 4, total: 4, tool: nil, note: "已完成",
            startedAt: nil, durationMs: 723_000, endedAt: now.timeIntervalSince1970 * 1000, jobsRunning: 0),
    ]
    let rows: [Row]
    if live {
        let store = Store(home: AppController.home)
        store.poll()
        rows = store.rows
        print("live rows: \(rows.count)")
        for row in rows {
            print("  [\(row.tone)] \(row.title) | \(row.step ?? "-") | \(row.done)/\(row.total) | \(row.tool ?? "-") | \(row.note ?? "-")")
        }
        if rows.isEmpty { return }
    } else {
        rows = sample
    }

    func shot(_ name: String, store: Store, notch: Bool, expanded: Bool) {
        let ui = ScreenUI()
        ui.hasNotch = notch
        ui.notchWidth = notch ? 200 : 0
        ui.barHeight = notch ? 32 : 25
        ui.isExpanded = expanded
        let view = ZStack(alignment: .top) {
            Color(white: 0.86)
            Color(white: 0.93).frame(height: ui.barHeight)
            if notch {
                IslandShape(radius: 10).fill(.black).frame(width: ui.notchWidth, height: ui.barHeight)
            }
            IslandRoot(store: store, ui: ui, onOpen: { _ in }, onHide: {})
        }
        .frame(width: 760, height: expanded ? 300 : 70)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.nsImage, let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:])
        else { print("could not render \(name)"); return }
        let url = dir.appendingPathComponent(name)
        try? png.write(to: url)
        print(url.path)
    }

    let prefix = live ? "live-" : ""
    shot("\(prefix)compact.png", store: Store(rows: rows), notch: false, expanded: false)
    shot("\(prefix)compact-notch.png", store: Store(rows: rows), notch: true, expanded: false)
    shot("\(prefix)expanded.png", store: Store(rows: rows), notch: false, expanded: true)
    shot("\(prefix)expanded-notch.png", store: Store(rows: rows), notch: true, expanded: true)
    if let first = rows.last {
        shot("\(prefix)peek.png", store: Store(rows: rows, peek: first), notch: false, expanded: false)
    }
}

// MARK: - Self test: the store's rules against files in a scratch home

func runSelfTest() -> Int32 {
    let fm = FileManager.default
    let home = fm.temporaryDirectory.appendingPathComponent("claude-island-test-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: home) }
    let dir = home.appendingPathComponent(".claude/dynamic-island/sessions")
    let metaDir = home.appendingPathComponent("Library/Application Support/Claude/claude-code-sessions/a/b")
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    try? fm.createDirectory(at: metaDir, withIntermediateDirectories: true)
    var failures = 0
    func check(_ ok: Bool, _ what: String) {
        print(ok ? "pass  \(what)" : "FAIL  \(what)")
        if !ok { failures += 1 }
    }
    let start = Date()
    let nowMs = start.timeIntervalSince1970 * 1000
    // The store rescans Claude's titles every few seconds: each step moves on.
    var step = 0.0
    func later() -> Date {
        step += 10
        return start.addingTimeInterval(step)
    }
    func write(_ id: String, _ fields: String, updatedAt: Double = nowMs, closed: Bool = false) {
        let json = """
        {"v":1,"sessionId":"\(id)","cwd":"/tmp/proj","prompt":"修一下测试","plan":[{"title":"跑测试","status":"in_progress","active":null},{"title":"修复","status":"pending","active":null}],"tool":{"label":"Bash","detail":"npm test"},"jobs":[],"closed":\(closed),"updatedAt":\(updatedAt),\(fields)}
        """
        try? json.data(using: .utf8)!.write(to: dir.appendingPathComponent("\(id).json"))
    }
    let store = Store(home: home)

    write("s1", #""phase":"working","waiting":null,"turnStartedAt":\#(nowMs - 5000),"endedAt":null"#)
    store.poll(now: start)
    check(store.rows.count == 1 && store.rows.first?.tone == .work, "a working session shows")
    check(store.rows.first?.title == "修一下测试", "with the prompt as its title while Claude names none")
    check(store.rows.first?.step == "跑测试" && store.rows.first?.total == 2, "with its step and count")
    check(store.peek == nil, "and the first look raises no peek")

    let meta = """
    {"sessionId":"local_x","cliSessionId":"s1","title":"修复登录页","isArchived":false,"lastFocusedAt":\(nowMs - 60_000)}
    """
    try? meta.data(using: .utf8)!.write(to: metaDir.appendingPathComponent("local_x.json"))
    write("s1", #""phase":"working","waiting":"permission","waitingTool":"Bash","turnStartedAt":\#(nowMs - 5000),"endedAt":null"#)
    store.poll(now: later())
    check(store.rows.first?.title == "修复登录页", "Claude's own title wins")
    check(store.rows.first?.tone == .wait && store.rows.first?.note == "等你授权 Bash", "a permission prompt reads as waiting")
    check(store.peek?.id == "s1", "and pops the capsule open")

    write("s1", #""phase":"done","waiting":null,"turnStartedAt":null,"lastDurationMs":65000,"endedAt":\#(nowMs)"#)
    store.poll(now: later())
    check(store.rows.first?.tone == .done && store.rows.first?.note == "已完成", "a finished turn reads done")
    check(store.peek?.tone == .done, "and pops the capsule open again")
    store.markFinishedSeen()
    check(store.rows.isEmpty, "once looked at, it leaves")

    write("s2", #""phase":"working","waiting":null,"turnStartedAt":\#(nowMs - 400_000),"endedAt":null"#, updatedAt: nowMs - 200_000)
    store.poll(now: later())
    check(store.rows.isEmpty, "a working session that stopped writing is gone")

    write("s3", #""phase":"done","waiting":null,"turnStartedAt":null,"lastDurationMs":1000,"endedAt":\#(nowMs - 1000)"#)
    let seenMeta = """
    {"sessionId":"local_y","cliSessionId":"s3","title":"写周报","isArchived":false,"lastFocusedAt":\(nowMs)}
    """
    try? seenMeta.data(using: .utf8)!.write(to: metaDir.appendingPathComponent("local_y.json"))
    store.poll(now: later())
    check(store.rows.isEmpty, "a finished session opened in Claude since counts as read")

    write("s4", #""phase":"working","waiting":null,"turnStartedAt":\#(nowMs),"endedAt":null"#, closed: true)
    store.poll(now: later())
    check(store.rows.isEmpty, "a closed session is dropped")

    print(failures == 0 ? "all passed" : "\(failures) failed")
    return failures == 0 ? 0 : 1
}

// MARK: - Hover test: a real panel, laid out off every display

@MainActor
func runHoverTest() -> Int32 {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    var failures = 0
    func check(_ ok: Bool, _ what: String) {
        print(ok ? "pass  \(what)" : "FAIL  \(what)")
        if !ok { failures += 1 }
    }
    func settle() {
        for _ in 0..<15 { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    }
    let now = Date()
    let rows = [
        Row(id: "a", title: "示例项目", tone: .work, step: "跑测试", done: 1, total: 4, tool: "Bash · ls",
            note: nil, startedAt: now.addingTimeInterval(-60), durationMs: nil, endedAt: nil, jobsRunning: 0),
    ]
    let store = Store(rows: rows)
    let owner = AppController()
    guard let screen = NSScreen.screens.first else { print("no screen"); return 1 }
    let controller = ScreenController(screen: screen, store: store, app: owner, offscreen: true)
    settle()

    let compact = controller.ui.islandFrame
    let rect = controller.screenRect(compact)
    print("panel \(controller.panel.frame)  island(SwiftUI) \(compact)  island(screen) \(rect)")
    check(compact.width > 40 && compact.height > 10, "the capsule reports where it is drawn")

    let center = NSPoint(x: rect.midX, y: rect.midY)
    let away = NSPoint(x: rect.midX, y: rect.minY - 900)

    controller.track(mouse: away, now: now)
    check(controller.panel.ignoresMouseEvents, "away from the capsule, clicks pass through")
    controller.track(mouse: center, now: now)
    check(!controller.panel.ignoresMouseEvents, "over the capsule, it takes the click")
    controller.track(mouse: center, now: now.addingTimeInterval(0.1))
    check(!controller.ui.isExpanded, "passing over it briefly does not open it")
    controller.track(mouse: center, now: now.addingTimeInterval(0.3))
    check(controller.ui.isExpanded, "resting on the capsule opens the list")
    settle()
    let open = controller.ui.islandFrame
    print("island(open) \(open)")
    check(open.height > compact.height * 3, "the open list is drawn below the capsule")

    controller.track(mouse: away, now: now.addingTimeInterval(0.4))
    controller.track(mouse: away, now: now.addingTimeInterval(0.9))
    check(!controller.ui.isExpanded, "leaving closes it")
    settle()

    // A click, as the window server hands one to the panel.
    let later = now.addingTimeInterval(5)
    controller.track(mouse: center, now: later)
    let local = controller.panel.convertPoint(fromScreen: center)
    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
        if let event = NSEvent.mouseEvent(
            with: type, location: local, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: controller.panel.windowNumber, context: nil, eventNumber: 0,
            clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) {
            controller.panel.sendEvent(event)
        }
        settle()
    }
    check(controller.ui.isExpanded, "clicking the capsule opens the list at once")

    controller.close()
    print(failures == 0 ? "all passed" : "\(failures) failed")
    return failures == 0 ? 0 : 1
}

func printGeometry() {
    for (index, screen) in NSScreen.screens.enumerated() {
        let aux = screen.auxiliaryTopLeftArea.map { "\($0)" } ?? "none"
        print("screen \(index): frame \(screen.frame) visible \(screen.visibleFrame) safeTop \(screen.safeAreaInsets.top) auxLeft \(aux)")
    }
}

@main
@MainActor
enum Main {
    static let delegate = AppController()

    static func main() {
        let args = CommandLine.arguments
        if let index = args.firstIndex(where: { $0 == "--snapshot" || $0 == "--snapshot-live" }),
           index + 1 < args.count {
            _ = NSApplication.shared
            renderSnapshots(to: URL(fileURLWithPath: args[index + 1]), live: args[index] == "--snapshot-live")
            return
        }
        if args.contains("--geometry") {
            _ = NSApplication.shared
            printGeometry()
            return
        }
        if args.contains("--self-test") {
            exit(runSelfTest())
        }
        if args.contains("--hover-test") {
            exit(runHoverTest())
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.delegate = delegate
        app.run()
    }
}
