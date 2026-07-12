import SwiftUI
import AppKit
import Foundation
import ServiceManagement

// MARK: - Config

enum Config {
    static let base = "http://127.0.0.1:8934"

    // The .app bundle lives IN the project directory (menubar/build.sh builds
    // it right next to server.mjs), so resolve the server dir relative to the
    // bundle's own location at runtime. Falls back to ~/Documents/Claude
    // Sessions if server.mjs isn't found next to the bundle (e.g. running
    // from a different location).
    static let serverDir: String = {
        let bundleParent = Bundle.main.bundleURL.deletingLastPathComponent()
        let candidate = bundleParent.appendingPathComponent("server.mjs")
        if FileManager.default.fileExists(atPath: candidate.path) {
            return bundleParent.path
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent("Documents/Claude Sessions").path
    }()

    static let serverScript: String = serverDir + "/server.mjs"

    // No version-pinned paths. Prefer the newest nvm-installed node (any
    // user, any version), then common Homebrew/system locations, then fall
    // back to resolving `node` via a login shell at spawn time.
    static let nodeCandidates: [String] = {
        var candidates: [String] = []
        let home = FileManager.default.homeDirectoryForCurrentUser
        let nvmDir = home.appendingPathComponent(".nvm/versions/node")
        if let entries = try? FileManager.default.contentsOfDirectory(atPath: nvmDir.path) {
            // Sort version dirs (e.g. "v22.15.0") descending so the newest wins.
            let sorted = entries.sorted { a, b in
                a.compare(b, options: .numeric) == .orderedDescending
            }
            for v in sorted {
                let bin = nvmDir.appendingPathComponent(v).appendingPathComponent("bin/node").path
                candidates.append(bin)
            }
        }
        candidates.append("/opt/homebrew/bin/node")
        candidates.append("/usr/local/bin/node")
        return candidates
    }()
}

// MARK: - Brand (AI Makers)

extension Color {
    // Adapts to light/dark automatically, matching the popover's system appearance.
    static func dynamic(light: NSColor, dark: NSColor) -> Color {
        Color(NSColor(name: nil, dynamicProvider: { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return isDark ? dark : light
        }))
    }
}

enum Brand {
    // Terracotta — accents, active markers, buttons, links, captions, focus.
    static let terracotta = Color(red: 0.851, green: 0.467, blue: 0.341)      // #D97757
    static let terracottaDark = Color(red: 0.702, green: 0.353, blue: 0.227)  // #B35A3A (hover/pressed)
    static let terracottaDeep = Color(red: 0.541, green: 0.271, blue: 0.188)  // #8A4530 (emphasis text)

    // Surfaces — cream in light mode, warm dark ink in dark mode.
    static let cream = Color.dynamic(
        light: NSColor(calibratedRed: 0.980, green: 0.965, blue: 0.941, alpha: 1), // #FAF6F0
        dark:  NSColor(calibratedRed: 0.102, green: 0.086, blue: 0.078, alpha: 1)  // #1A1614
    )
    static let creamRaised = Color.dynamic(
        light: NSColor(calibratedRed: 0.996, green: 0.988, blue: 0.976, alpha: 1), // #FEFCF9
        dark:  NSColor(calibratedRed: 0.133, green: 0.114, blue: 0.102, alpha: 1)  // #221D1A
    )
    static let sand = Color.dynamic(
        light: NSColor(calibratedRed: 0.886, green: 0.804, blue: 0.702, alpha: 1),  // #E2CDB3
        dark:  NSColor(calibratedRed: 0.886, green: 0.804, blue: 0.702, alpha: 0.28)
    )

    // Ink — dark warm text in light mode, cream text in dark mode.
    static let ink = Color.dynamic(
        light: NSColor(calibratedRed: 0.102, green: 0.102, blue: 0.114, alpha: 1), // #1A1A1D
        dark:  NSColor(calibratedRed: 0.980, green: 0.965, blue: 0.941, alpha: 1)  // #FAF6F0
    )
    static let inkMute = Color.dynamic(
        light: NSColor(calibratedRed: 0.420, green: 0.384, blue: 0.345, alpha: 1), // #6B6258
        dark:  NSColor(calibratedRed: 0.827, green: 0.769, blue: 0.694, alpha: 1)  // lighter warm grey
    )

    // Distinct accent for Codex/ChatGPT accounts, so provider is readable at a
    // glance next to the terracotta Claude accounts.
    static let codexTeal = Color(red: 0.06, green: 0.64, blue: 0.50)

    // Green/red counts for the automations health glance.
    static let ok = Color(red: 0.133, green: 0.773, blue: 0.369)   // #22C55E
    static let bad = Color(red: 0.937, green: 0.267, blue: 0.267)  // #EF4444
}

// Small provider tag pill ("Claude" / "Codex") shown on each account row.
struct ProviderTag: View {
    let account: Account
    var body: some View {
        let isCodex = account.isCodex
        let tint = isCodex ? Brand.codexTeal : Brand.terracotta
        Text(isCodex ? "Codex" : "Claude")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(tint.opacity(0.16))
            .clipShape(Capsule())
    }
}

// The AI Makers diamond mark — four rounded squares in a 2x2 grid, rotated 45°.
// Pre-rotation grid is red(top-left) / orange(top-right) / green(bottom-left) /
// blue(bottom-right); a 45° clockwise rotation carries that to the brand lockup:
// red-top, orange-right, green-left, blue-bottom. Small gap between squares.
// Size-parameterized so it can be dropped in at any scale (brand bar, buttons, etc).
struct AIMakersDiamond: View {
    var size: CGFloat = 18

    var body: some View {
        let square = size / 1.41421356
        let gap = square * 0.07
        let cell = (square - gap) / 2
        let offset = cell / 2 + gap / 2
        let corner = max(1, cell * 0.14)
        ZStack {
            RoundedRectangle(cornerRadius: corner)
                .fill(Color(red: 0.937, green: 0.267, blue: 0.267)) // red #EF4444 -> top
                .frame(width: cell, height: cell)
                .offset(x: -offset, y: -offset)
            RoundedRectangle(cornerRadius: corner)
                .fill(Color(red: 0.976, green: 0.451, blue: 0.086)) // orange #F97316 -> right
                .frame(width: cell, height: cell)
                .offset(x: offset, y: -offset)
            RoundedRectangle(cornerRadius: corner)
                .fill(Color(red: 0.133, green: 0.773, blue: 0.369)) // green #22C55E -> left
                .frame(width: cell, height: cell)
                .offset(x: -offset, y: offset)
            RoundedRectangle(cornerRadius: corner)
                .fill(Color(red: 0.231, green: 0.510, blue: 0.965)) // blue #3B82F6 -> bottom
                .frame(width: cell, height: cell)
                .offset(x: offset, y: offset)
        }
        .frame(width: square, height: square)
        .rotationEffect(.degrees(45))
        .frame(width: size, height: size)
    }
}

// Terracotta text-link button style — dark terracotta on press.
struct TerracottaLinkStyle: ButtonStyle {
    var size: CGFloat = 12
    var weight: Font.Weight = .regular
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: size, weight: weight))
            .foregroundStyle(configuration.isPressed ? Brand.terracottaDark : Brand.terracotta)
    }
}

// Thin sand-colored rule, used in place of Divider() to keep hairlines on-brand.
struct SandRule: View {
    var vertical: Bool = false
    var body: some View {
        Rectangle()
            .fill(Brand.sand)
            .frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
    }
}

// MARK: - Models

struct Account: Codable, Identifiable {
    var id: String { service }
    let provider: String?          // "claude" | "codex"; absent => claude
    let service: String
    let email: String?             // Claude only; codex has none (use label)
    let label: String?             // Codex display label (and claude mirror)
    let orgTitle: String?          // Codex org, if any
    let plan: String?
    let isActive: Bool?
    let status: String?
    let usage: Usage?
    let usageError: String?
    let error: String?

    var active: Bool { isActive ?? false }

    // Provider identity (default claude when the field is missing).
    var providerName: String { provider ?? "claude" }
    var isCodex: Bool { providerName == "codex" }

    // Display name: codex has no email, so fall back to label, then service.
    var displayName: String {
        if let e = email, !e.isEmpty { return e }
        if let l = label, !l.isEmpty { return l }
        return service
    }

    // Not switchable while the token itself is dead — switching would just fail.
    // Codex is switchable only while its token is healthy (status == "ok").
    var isSwitchable: Bool {
        if isCodex { return status == "ok" }
        return status != "needs_refresh"
    }

    // Muted one-line status to show in place of usage bars when usage is
    // unavailable but the account itself still renders (never blank).
    var degradedNote: String? {
        // Codex: any non-ok status means the OAuth token needs re-linking.
        if isCodex {
            if let s = status, s != "ok" { return "Reconnect Codex" }
            guard usage == nil else { return nil }
            if usageError != nil { return "Usage unavailable" }
            return nil
        }
        switch status {
        case "needs_refresh":
            return "Session expired — re-add to refresh"
        case "error":
            return "Usage unavailable — tap Refresh"
        default:
            guard usage == nil else { return nil }
            // A usage-endpoint error (incl. 429 throttling) means usage could
            // not be fetched — NOT that the account is at its limit. True
            // at-limit shows as 100% bars from real usage data.
            if usageError != nil { return "Usage unavailable" }
            return nil
        }
    }

    // Worst weekly percent (weekly_all / weekly_scoped)
    var worstWeeklyPercent: Int {
        guard let limits = usage?.limits else { return 0 }
        return limits
            .filter { $0.kind == "weekly_all" || $0.kind == "weekly_scoped" }
            .map { $0.percent ?? 0 }
            .max() ?? 0
    }

    // Worst weekly severity, considering percent thresholds too
    var worstWeeklySeverity: String {
        guard let limits = usage?.limits else { return "normal" }
        let weekly = limits.filter { $0.kind == "weekly_all" || $0.kind == "weekly_scoped" }
        if weekly.contains(where: { ($0.severity == "high") || (($0.percent ?? 0) >= 90) }) { return "high" }
        if weekly.contains(where: { ($0.severity == "warning") || (($0.percent ?? 0) >= 70) }) { return "warning" }
        return "normal"
    }
}

struct Usage: Codable {
    let limits: [Limit]?
    let five_hour: Window?
    let seven_day: Window?
}

struct Limit: Codable, Identifiable {
    var id: String { (kind ?? "") + (label ?? "") }
    let kind: String?
    let group: String?
    let percent: Int?
    let severity: String?
    let resets_at: String?
    let label: String?
    let is_active: Bool?
}

struct Window: Codable {
    let utilization: Int?
    let resets_at: String?
}

struct Session: Codable, Identifiable {
    let id: String
    let title: String?
    let cwd: String?
    let gitBranch: String?
    let lastTimestamp: String?
    let userCount: Int?
    let assistantCount: Int?
    let account: String?           // owning account email/slug for per-account (CLAUDE_CONFIG_DIR) sessions; nil = global

    var projectBasename: String {
        guard let cwd = cwd, !cwd.isEmpty else { return "" }
        return (cwd as NSString).lastPathComponent
    }

    // Short account tag for the RECENTS row (local-part of the email, else slug).
    var accountTag: String? {
        guard let a = account, !a.isEmpty else { return nil }
        if let at = a.firstIndex(of: "@") { return String(a[..<at]) }
        return a
    }
}

// Running claude CLI sessions summary (/api/claude/running) — drives whether the
// switch confirm offers the migration choices.
struct RunningInfo: Codable {
    let count: Int?            // migratable (non-pinned, mappable) running sessions
    let pinned: Int?
    let unmappable: Int?
}

// Live migration status (/api/migration) for the footer indicator.
struct MigrationStatus: Codable {
    let active: Bool?
    let mode: String?
    let total: Int?
    let done: Int?
    let remaining: Int?
}

struct Automation: Codable, Identifiable {
    let id: String
    let kind: String?
    let name: String?
    let schedule: String?
    let target: String?
    let status: String?          // "running" | "idle" | "error"
    let enabled: Bool?
    let lastExit: Int?
    let lastRun: String?
    let nextRun: String?
    let logPath: String?

    // Failed = server flagged error, or last invocation exited non-zero.
    var failed: Bool { status == "error" || (lastExit ?? 0) != 0 }
    var running: Bool { status == "running" }
}

struct SaveCurrentResult: Codable {
    let email: String?
    let plan: String?
    let service: String?
}

struct LoginStatus: Codable {
    let status: String
    let email: String?
    let error: String?
}

// MARK: - Helpers

enum Severity {
    static func color(_ s: String) -> Color {
        switch s {
        case "high": return Color(red: 0.937, green: 0.267, blue: 0.267)   // #EF4444 red
        case "warning": return Brand.terracotta                            // #D97757 terracotta
        default: return Color(red: 0.133, green: 0.773, blue: 0.369)       // #22C55E green
        }
    }
    // Derive from a percent + optional server severity
    static func from(percent: Int, severity: String?) -> String {
        if severity == "high" || percent >= 90 { return "high" }
        if severity == "warning" || percent >= 70 { return "warning" }
        return "normal"
    }
}

func parseISO(_ s: String?) -> Date? {
    guard let s = s, !s.isEmpty else { return nil }
    let f1 = ISO8601DateFormatter()
    f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f1.date(from: s) { return d }
    let f2 = ISO8601DateFormatter()
    f2.formatOptions = [.withInternetDateTime]
    if let d = f2.date(from: s) { return d }
    // Fallback: trim excessive fractional digits (microseconds -> millis)
    if let range = s.range(of: #"\.\d+"#, options: .regularExpression) {
        var trimmed = s
        let frac = String(s[range]).prefix(4) // ".ddd"
        trimmed.replaceSubrange(range, with: String(frac))
        if let d = f1.date(from: trimmed) { return d }
    }
    return nil
}

// "resets in 2d 4h" from a future ISO date
func resetCaption(_ iso: String?) -> String? {
    guard let d = parseISO(iso) else { return nil }
    let secs = d.timeIntervalSinceNow
    if secs <= 0 { return "resets now" }
    return "resets in " + shortDuration(secs)
}

func shortDuration(_ secs: TimeInterval) -> String {
    let total = Int(secs)
    let days = total / 86400
    let hours = (total % 86400) / 3600
    let mins = (total % 3600) / 60
    if days > 0 { return "\(days)d \(hours)h" }
    if hours > 0 { return "\(hours)h \(mins)m" }
    return "\(mins)m"
}

// relative past time e.g. "3h ago"
func relativePast(_ iso: String?) -> String {
    guard let d = parseISO(iso) else { return "" }
    let secs = -d.timeIntervalSinceNow
    if secs < 60 { return "just now" }
    let total = Int(secs)
    let days = total / 86400
    let hours = (total % 86400) / 3600
    let mins = (total % 3600) / 60
    if days > 0 { return "\(days)d ago" }
    if hours > 0 { return "\(hours)h ago" }
    return "\(mins)m ago"
}

// MARK: - API Client

actor API {
    static let shared = API()

    private func url(_ path: String) -> URL { URL(string: Config.base + path)! }

    func ping() async -> Bool {
        var req = URLRequest(url: url("/"))
        req.timeoutInterval = 2
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse { return http.statusCode < 500 }
            return true
        } catch { return false }
    }

    func getAccounts() async throws -> [Account] {
        var req = URLRequest(url: url("/api/accounts"))
        req.timeoutInterval = 8
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode([Account].self, from: data)
    }

    func getSessions() async throws -> [Session] {
        var req = URLRequest(url: url("/api/sessions"))
        req.timeoutInterval = 8
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode([Session].self, from: data)
    }

    func getAutomations() async throws -> [Automation] {
        var req = URLRequest(url: url("/api/automations"))
        req.timeoutInterval = 8
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode([Automation].self, from: data)
    }

    @discardableResult
    func post(_ path: String, body: [String: Any]? = nil) async throws -> Data {
        var req = URLRequest(url: url(path))
        req.httpMethod = "POST"
        req.timeoutInterval = 10
        if let body = body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, _) = try await URLSession.shared.data(for: req)
        return data
    }

    func resume(_ id: String) async throws { try await post("/api/resume/\(id)") }

    // Provider-aware activate: Claude switches by {service}; Codex by
    // {provider:"codex", id}. Both hit /api/accounts/activate. `migrate` (Claude
    // only) is "idle" | "now" | "none" for running-session handling.
    func activate(_ acc: Account, migrate: String = "none") async throws {
        if acc.isCodex {
            try await post("/api/accounts/activate", body: ["provider": "codex", "id": acc.id])
        } else {
            try await post("/api/accounts/activate", body: ["service": acc.service, "migrate": migrate])
        }
    }

    func getRunning() async throws -> RunningInfo {
        var req = URLRequest(url: url("/api/claude/running"))
        req.timeoutInterval = 8
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(RunningInfo.self, from: data)
    }

    func getMigration() async throws -> MigrationStatus {
        var req = URLRequest(url: url("/api/migration"))
        req.timeoutInterval = 8
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(MigrationStatus.self, from: data)
    }

    func openTerminal(_ service: String) async throws {
        try await post("/api/accounts/open-terminal", body: ["service": service])
    }
    func loginStart() async throws { try await post("/api/accounts/login-start") }
    func removeAccount(_ service: String) async throws { try await post("/api/accounts/remove", body: ["service": service]) }
    func loginStatus() async throws -> LoginStatus {
        var req = URLRequest(url: url("/api/accounts/login-status"))
        req.timeoutInterval = 8
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(LoginStatus.self, from: data)
    }
}

// MARK: - Server lifecycle

enum ServerLauncher {
    static func nodePath() -> String {
        for c in Config.nodeCandidates where FileManager.default.isExecutableFile(atPath: c) { return c }
        // Last resort: resolve `node` via a login shell so user-specific PATH
        // customizations (asdf, custom installs, etc.) are still honored.
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        proc.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            if let out = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !out.isEmpty, FileManager.default.isExecutableFile(atPath: out) {
                return out
            }
        } catch {
            // fall through
        }
        return "/usr/bin/env" // last resort; will run `env node`
    }

    static func ensureRunning() async {
        if await API.shared.ping() { return }
        spawn()
        // poll up to ~6s
        for _ in 0..<30 {
            try? await Task.sleep(nanoseconds: 200_000_000)
            if await API.shared.ping() { return }
        }
    }

    static func spawn() {
        let node = nodePath()
        let proc = Process()
        if node == "/usr/bin/env" {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["node", Config.serverScript]
        } else {
            proc.executableURL = URL(fileURLWithPath: node)
            proc.arguments = [Config.serverScript]
        }
        proc.currentDirectoryURL = URL(fileURLWithPath: Config.serverDir)
        // detach stdout/stderr to the log file
        let logPath = Config.serverDir + "/server.log"
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }
        if let fh = FileHandle(forWritingAtPath: logPath) {
            fh.seekToEndOfFile()
            proc.standardOutput = fh
            proc.standardError = fh
        }
        do { try proc.run() } catch { NSLog("Failed to spawn server: \(error)") }
    }
}

// MARK: - App State

@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    @Published var accounts: [Account] = []
    @Published var sessions: [Session] = []
    @Published var automations: [Automation] = []
    @Published var loading = false
    @Published var lastError: String?
    @Published var loginWaiting = false   // one-click OAuth: browser sign-in in progress
    @Published var startAtLogin = false
    @Published var runningClaudeCount = 0  // migratable running claude CLI sessions
    @Published var migration: MigrationStatus? = nil  // live migration indicator

    private var timer: Timer?
    private var loginPollTask: Task<Void, Never>?
    private var migrationPollTask: Task<Void, Never>?

    var migrationActive: Bool { migration?.active ?? false }

    var activeAccount: Account? { accounts.first(where: { $0.active }) ?? accounts.first }

    // Menubar status icon drives off the active CLAUDE account only — a codex
    // account (which has no usage limits) must never steer the icon.
    var activeClaudeAccount: Account? {
        let claude = accounts.filter { !$0.isCodex }
        return claude.first(where: { $0.active }) ?? claude.first
    }

    // Automations health glance (footer).
    var automationsTotal: Int { automations.count }
    var automationsRunning: Int { automations.filter { $0.running }.count }
    var automationsFailed: Int { automations.filter { $0.failed }.count }

    func start() {
        refreshStartAtLogin()
        Task {
            await ServerLauncher.ensureRunning()
            await refreshAll()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 180, repeats: true) { [weak self] _ in
            Task {
                await self?.loadAccounts()
                await self?.loadAutomations()
            }
        }
    }

    func refreshAll() async {
        loading = true
        async let a: () = loadAccounts()
        async let s: () = loadSessions()
        async let au: () = loadAutomations()
        _ = await (a, s, au)
        loading = false
    }

    func loadAccounts() async {
        do {
            let acc = try await API.shared.getAccounts()
            self.accounts = acc
            self.lastError = nil
        } catch {
            self.lastError = "accounts: \(error.localizedDescription)"
        }
        await loadRunning()
    }

    // Refresh the migratable running-session count so the switch confirm knows
    // whether to offer the migration choices. Non-fatal.
    func loadRunning() async {
        if let info = try? await API.shared.getRunning() {
            self.runningClaudeCount = info.count ?? 0
        }
    }

    func loadSessions() async {
        do {
            let s = try await API.shared.getSessions()
            self.sessions = Array(s.prefix(20))
        } catch {
            self.lastError = "sessions: \(error.localizedDescription)"
        }
    }

    func loadAutomations() async {
        do {
            self.automations = try await API.shared.getAutomations()
        } catch {
            // Non-fatal: the glance just hides if the endpoint is unavailable.
            self.automations = []
        }
    }

    // migrate: "idle" (graceful when idle) | "now" (restart running immediately)
    // | "none" (leave running sessions on the old account).
    func activate(_ acc: Account, migrate: String = "none") {
        Task {
            try? await API.shared.activate(acc, migrate: migrate)
            await loadAccounts()
            if !acc.isCodex && migrate != "none" { startMigrationPolling() }
        }
    }

    // Poll /api/migration while a migration is in flight so the footer shows a
    // live "migrating N sessions…" indicator that clears when done.
    private func startMigrationPolling() {
        migrationPollTask?.cancel()
        migrationPollTask = Task { [weak self] in
            for _ in 0..<400 { // ~ up to 33 min at 5s cadence (covers the server's 30-min idle cap)
                guard let self = self else { return }
                if Task.isCancelled { return }
                if let m = try? await API.shared.getMigration() {
                    self.migration = m
                    if !(m.active ?? false) {
                        // one last account refresh, then clear the indicator shortly after
                        await self.loadAccounts()
                        try? await Task.sleep(nanoseconds: 4_000_000_000)
                        self.migration = nil
                        return
                    }
                }
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
            self?.migration = nil
        }
    }

    func openTerminal(_ acc: Account) {
        Task { try? await API.shared.openTerminal(acc.service) }
    }

    func resume(_ id: String) {
        Task { try? await API.shared.resume(id) }
    }

    // One-click OAuth: kick off the loopback login (opens the browser
    // server-side), then poll login-status until the account lands.
    func addAccount() {
        Task {
            do {
                try await API.shared.loginStart()
                self.loginWaiting = true
                self.startLoginPolling()
            } catch {
                self.lastError = "login: \(error.localizedDescription)"
            }
        }
    }

    private func startLoginPolling() {
        loginPollTask?.cancel()
        loginPollTask = Task { [weak self] in
            // Poll ~1.5s for up to ~5 minutes.
            for _ in 0..<200 {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if Task.isCancelled { return }
                guard let self = self else { return }
                guard let status = try? await API.shared.loginStatus() else { continue }
                if status.status == "done" {
                    self.loginWaiting = false
                    await self.loadAccounts()
                    return
                } else if status.status == "error" {
                    self.loginWaiting = false
                    self.lastError = "login: \(status.error ?? "failed")"
                    return
                } else if status.status == "idle" {
                    self.loginWaiting = false
                    return
                }
            }
            self?.loginWaiting = false
        }
    }

    func cancelLogin() {
        loginPollTask?.cancel()
        loginPollTask = nil
        loginWaiting = false
    }

    func remove(_ service: String) {
        Task {
            try? await API.shared.removeAccount(service)
            await loadAccounts()
        }
    }

    // MARK: Start at Login (SMAppService)

    func refreshStartAtLogin() {
        if #available(macOS 13.0, *) {
            startAtLogin = (SMAppService.mainApp.status == .enabled)
        }
    }

    func setStartAtLogin(_ on: Bool) {
        if #available(macOS 13.0, *) {
            do {
                if on { try SMAppService.mainApp.register() }
                else { try SMAppService.mainApp.unregister() }
            } catch {
                NSLog("SMAppService error: \(error)")
            }
            refreshStartAtLogin()
        }
    }
}

// MARK: - Views

struct BarView: View {
    let label: String
    let percent: Int
    let severity: String
    let resetsAt: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(Brand.ink)
                Spacer()
                Text("\(percent)%")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Severity.color(severity))
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Brand.sand.opacity(0.45))
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Severity.color(severity))
                        .frame(width: max(4, geo.size.width * CGFloat(min(percent, 100)) / 100.0))
                }
            }
            .frame(height: 7)
            if let cap = resetCaption(resetsAt) {
                Text(cap).font(.system(size: 10)).foregroundStyle(Brand.inkMute)
            }
        }
    }
}

// Order: session, weekly_all, weekly_scoped(s)
func orderedLimits(_ acc: Account) -> [Limit] {
    let limits = acc.usage?.limits ?? []
    let session = limits.filter { $0.kind == "session" }
    let all = limits.filter { $0.kind == "weekly_all" }
    let scoped = limits.filter { $0.kind == "weekly_scoped" }
    return session + all + scoped
}

func displayLabel(_ lim: Limit) -> String {
    switch lim.kind {
    case "session": return "Current session"
    case "weekly_all": return "All models"
    case "weekly_scoped": return lim.label ?? "Scoped"
    default: return lim.label ?? (lim.kind ?? "Limit")
    }
}

// Reusable per-account usage block: email + plan badge + active marker,
// then that account's bars (or a degraded note in their place). Used by
// Column 1 to render every account's limits at a glance.
struct AccountUsageBlock: View {
    let acc: Account

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                ProviderTag(account: acc)
                Text(acc.displayName).font(.system(size: 12, weight: .semibold)).foregroundStyle(Brand.ink).lineLimit(1)
                if let plan = acc.plan, !plan.isEmpty {
                    Text(plan)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(acc.isCodex ? Brand.codexTeal : Brand.terracottaDeep)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background((acc.isCodex ? Brand.codexTeal : Brand.terracotta).opacity(0.16))
                        .clipShape(Capsule())
                }
                Spacer()
                if acc.active {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(acc.isCodex ? Brand.codexTeal : Brand.terracotta)
                        .font(.system(size: 12))
                }
            }
            if let note = acc.degradedNote {
                Text(note).font(.system(size: 11)).foregroundStyle(Brand.inkMute)
            } else {
                ForEach(orderedLimits(acc)) { lim in
                    let pct = lim.percent ?? 0
                    BarView(
                        label: displayLabel(lim),
                        percent: pct,
                        severity: Severity.from(percent: pct, severity: lim.severity),
                        resetsAt: lim.resets_at
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(acc.status == "needs_refresh" ? 0.7 : 1.0)
    }
}

struct ContentView: View {
    @EnvironmentObject var state: AppState
    // Inline confirmations for the MANAGE column. NSAlert.runModal() is unusable
    // from a menu-bar popover (the dialog opens unfocused behind other windows),
    // so confirm/cancel renders directly under the account row instead.
    @State private var pendingSwitchId: String? = nil
    @State private var pendingRemoveId: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            // SLIM BRAND BAR — pinned above the 3 columns, ~36pt tall.
            brandBar

            SandRule()

            // THREE COLUMNS — the ONLY scrolling regions. Captions pinned above
            // each column's ScrollView; columns share width equally.
            HStack(alignment: .top, spacing: 0) {
                // Column 1 — ACCOUNTS: every account + all its limits (monitor).
                VStack(alignment: .leading, spacing: 6) {
                    Text("ACCOUNTS")
                        .font(.system(size: 10, weight: .bold)).foregroundStyle(Brand.terracotta)
                        .padding(.horizontal, 12).padding(.top, 10)
                    ScrollView {
                        accountsMonitorList
                            .padding(.horizontal, 12).padding(.bottom, 12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                SandRule(vertical: true)

                // Column 2 — RECENTS: last sessions, click to resume.
                VStack(alignment: .leading, spacing: 6) {
                    Text("RECENTS")
                        .font(.system(size: 10, weight: .bold)).foregroundStyle(Brand.terracotta)
                        .padding(.horizontal, 12).padding(.top, 10)
                    ScrollView {
                        resumeList
                            .padding(.horizontal, 12).padding(.bottom, 12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                SandRule(vertical: true)

                // Column 3 — MANAGE: add / set active / remove.
                VStack(alignment: .leading, spacing: 6) {
                    Text("MANAGE")
                        .font(.system(size: 10, weight: .bold)).foregroundStyle(Brand.terracotta)
                        .padding(.horizontal, 12).padding(.top, 10)
                    ScrollView {
                        manageList
                            .padding(.horizontal, 12).padding(.bottom, 12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: .infinity)

            SandRule()

            // FOOTER — pinned, full width.
            footer
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
        }
        .background(Brand.cream)
        .frame(width: 960, height: 560)
    }

    // Slim brand bar: diamond + "AI Makers" wordmark + subtitle, cream ground.
    @ViewBuilder private var brandBar: some View {
        HStack(spacing: 8) {
            AIMakersDiamond(size: 18)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("AI Makers")
                    .font(.system(size: 14, weight: .black))
                    .kerning(-0.2)
                    .foregroundStyle(Brand.ink)
                Text("· Claude + Codex accounts")
                    .font(.system(size: 12, weight: .regular))
                    .foregroundStyle(Brand.inkMute)
            }
            Spacer()
        }
        .padding(.horizontal, 14)
        .frame(height: 36)
        .background(Brand.cream)
    }

    // Column 1 — every account's usage bars (list only; caption is pinned by
    // the parent column). Primary at-a-glance monitor of all accounts.
    @ViewBuilder private var accountsMonitorList: some View {
        VStack(alignment: .leading, spacing: 14) {
            if state.accounts.isEmpty {
                Text(state.loading ? "Loading…" : "No accounts")
                    .font(.system(size: 12)).foregroundStyle(Brand.inkMute)
                if let e = state.lastError {
                    Text(e).font(.system(size: 10)).foregroundStyle(Color(red: 0.937, green: 0.267, blue: 0.267))
                }
            }
            ForEach(Array(state.accounts.enumerated()), id: \.element.id) { index, acc in
                AccountUsageBlock(acc: acc)
                if index < state.accounts.count - 1 {
                    SandRule()
                }
            }
        }
    }

    // Column 3 — add account, plus set-active/remove per account (list only;
    // caption is pinned by the parent column). Set-active/remove confirm INLINE
    // under the row; add-account keeps the one-click loginStart + poll flow.
    @ViewBuilder private var manageList: some View {
        VStack(alignment: .leading, spacing: 10) {
            if state.loginWaiting {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Waiting for browser sign-in…")
                        .font(.system(size: 12)).foregroundStyle(Brand.inkMute)
                    Spacer()
                    Button("Cancel") { state.cancelLogin() }
                        .buttonStyle(TerracottaLinkStyle(size: 11))
                }
            } else {
                Button {
                    state.addAccount()
                } label: {
                    Label("Add account…", systemImage: "plus")
                }
                .buttonStyle(TerracottaLinkStyle(size: 12, weight: .semibold))
            }

            SandRule()

            ForEach(state.accounts) { acc in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        ProviderTag(account: acc)
                        Text(acc.displayName).font(.system(size: 12)).foregroundStyle(Brand.ink).lineLimit(1)
                        Spacer()
                        if acc.active {
                            Text("✓ Active")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(acc.isCodex ? Brand.codexTeal : Brand.terracotta)
                        } else if acc.isSwitchable {
                            Button("Set active") {
                                pendingSwitchId = acc.id
                                pendingRemoveId = nil
                            }
                            .buttonStyle(TerracottaLinkStyle(size: 11))
                        } else {
                            Text(acc.isCodex ? "Reconnect" : "Needs refresh")
                                .font(.system(size: 11)).foregroundStyle(Brand.inkMute)
                        }
                        // Open an isolated per-account terminal (Claude only —
                        // Codex has no CLAUDE_CONFIG_DIR isolation).
                        if !acc.isCodex && acc.isSwitchable {
                            Button {
                                state.openTerminal(acc)
                            } label: {
                                Image(systemName: "terminal").font(.system(size: 11))
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Brand.inkMute)
                            .help("Open a new terminal signed in as this account")
                        }
                        if !acc.active {
                            Button {
                                pendingRemoveId = acc.id
                                pendingSwitchId = nil
                            } label: {
                                Image(systemName: "trash").font(.system(size: 11))
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Brand.inkMute)
                        }
                    }
                    if pendingSwitchId == acc.id {
                        switchConfirm(acc)
                    }
                    if pendingRemoveId == acc.id {
                        inlineConfirm(
                            message: "Remove \(acc.displayName)? This deletes the stored credentials for this account.",
                            actionLabel: "Remove",
                            destructive: true,
                            onConfirm: { state.remove(acc.service); pendingRemoveId = nil },
                            onCancel: { pendingRemoveId = nil }
                        )
                    }
                }
                .opacity(acc.status == "needs_refresh" ? 0.55 : 1.0)
                .padding(.vertical, 2)
            }
        }
    }

    // Compact confirm strip rendered inside the popover, under the row it belongs to.
    @ViewBuilder private func inlineConfirm(
        message: String, actionLabel: String, destructive: Bool,
        onConfirm: @escaping () -> Void, onCancel: @escaping () -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(message)
                .font(.system(size: 10))
                .foregroundStyle(Brand.inkMute)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button(actionLabel, action: onConfirm)
                    .buttonStyle(.plain)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(destructive ? Color(red: 0.937, green: 0.267, blue: 0.267) : Brand.terracotta)
                Button("Cancel", action: onCancel)
                    .buttonStyle(.plain)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Brand.inkMute)
                Spacer()
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Brand.cream))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Brand.sand, lineWidth: 1))
    }

    // Switch confirm. With NO running claude sessions it's a plain confirm.
    // With running sessions it offers the three migration choices (feature 1).
    @ViewBuilder private func switchConfirm(_ acc: Account) -> some View {
        let running = state.runningClaudeCount
        VStack(alignment: .leading, spacing: 8) {
            if acc.isCodex || running == 0 {
                Text("Switch to \(acc.displayName)? \(acc.isCodex ? "Codex" : "Claude Code") uses it for new sessions; running sessions keep theirs until restarted.")
                    .font(.system(size: 10)).foregroundStyle(Brand.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    Button("Switch") { state.activate(acc, migrate: "none"); pendingSwitchId = nil }
                        .buttonStyle(.plain).font(.system(size: 11, weight: .bold)).foregroundStyle(Brand.terracotta)
                    Button("Cancel") { pendingSwitchId = nil }
                        .buttonStyle(.plain).font(.system(size: 11, weight: .semibold)).foregroundStyle(Brand.inkMute)
                    Spacer()
                }
            } else {
                Text("Switch to \(acc.displayName)? \(running) running session\(running == 1 ? "" : "s") on the current account:")
                    .font(.system(size: 10)).foregroundStyle(Brand.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
                choiceButton(
                    title: "Switch, migrate running when idle",
                    subtitle: "Resumes each session on the new account once it stops working (recommended).",
                    emphasized: true
                ) { state.activate(acc, migrate: "idle"); pendingSwitchId = nil }
                choiceButton(
                    title: "Switch + restart running NOW",
                    subtitle: "Cancels active runs immediately, then resumes them on the new account.",
                    emphasized: false
                ) { state.activate(acc, migrate: "now"); pendingSwitchId = nil }
                choiceButton(
                    title: "Switch, leave running on old account",
                    subtitle: "Only new sessions use the switched account.",
                    emphasized: false
                ) { state.activate(acc, migrate: "none"); pendingSwitchId = nil }
                HStack {
                    Button("Cancel") { pendingSwitchId = nil }
                        .buttonStyle(.plain).font(.system(size: 11, weight: .semibold)).foregroundStyle(Brand.inkMute)
                    Spacer()
                }
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Brand.cream))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Brand.sand, lineWidth: 1))
    }

    // One migration-choice row: bold title + muted subtitle, full-width tap target.
    @ViewBuilder private func choiceButton(
        title: String, subtitle: String, emphasized: Bool, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 11, weight: emphasized ? .bold : .semibold))
                    .foregroundStyle(emphasized ? Brand.terracotta : Brand.ink)
                Text(subtitle)
                    .font(.system(size: 9)).foregroundStyle(Brand.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4).padding(.horizontal, 6)
            .background(RoundedRectangle(cornerRadius: 5).fill(emphasized ? Brand.terracotta.opacity(0.10) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // 3. Resume — list only (caption is pinned by the parent column).
    @ViewBuilder private var resumeList: some View {
        VStack(alignment: .leading, spacing: 6) {
            if state.sessions.isEmpty {
                Text(state.loading ? "Loading…" : "No sessions")
                    .font(.system(size: 11)).foregroundStyle(Brand.inkMute)
            }
            ForEach(state.sessions) { s in
                Button {
                    state.resume(s.id)
                } label: {
                    HStack(spacing: 4) {
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 5) {
                                Text(s.title ?? "Untitled").font(.system(size: 12)).foregroundStyle(Brand.ink).lineLimit(1)
                                if let tag = s.accountTag {
                                    Text(tag)
                                        .font(.system(size: 8, weight: .bold))
                                        .foregroundStyle(Brand.terracottaDeep)
                                        .padding(.horizontal, 5).padding(.vertical, 1)
                                        .background(Brand.terracotta.opacity(0.16))
                                        .clipShape(Capsule())
                                }
                            }
                            Text(subtitle(s)).font(.system(size: 10)).foregroundStyle(Brand.inkMute).lineLimit(1)
                        }
                        Spacer()
                        Image(systemName: "arrow.right.circle").font(.system(size: 12)).foregroundStyle(Brand.terracotta)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.vertical, 1)
            }
        }
    }

    private func subtitle(_ s: Session) -> String {
        var parts: [String] = []
        let proj = s.projectBasename
        if !proj.isEmpty { parts.append(proj) }
        let rel = relativePast(s.lastTimestamp)
        if !rel.isEmpty { parts.append(rel) }
        return parts.joined(separator: " · ")
    }

    // Compact automations health glance — deep-links into the dashboard's
    // automations view. The menubar only glances; the dashboard owns controls.
    @ViewBuilder private var automationsGlance: some View {
        Button {
            let link = Config.base + "/#automations"
            if let url = URL(string: link) { NSWorkspace.shared.open(url) }
        } label: {
            HStack(spacing: 5) {
                Text("⚙").font(.system(size: 11)).foregroundStyle(Brand.inkMute)
                Text("\(state.automationsTotal) automations")
                    .font(.system(size: 11)).foregroundStyle(Brand.inkMute)
                Text("·").font(.system(size: 11)).foregroundStyle(Brand.inkMute)
                Text("\(state.automationsRunning) running")
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(Brand.ok)
                Text("·").font(.system(size: 11)).foregroundStyle(Brand.inkMute)
                Text("\(state.automationsFailed) failed")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(state.automationsFailed > 0 ? Brand.bad : Brand.inkMute)
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 9)).foregroundStyle(Brand.inkMute)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Open automations in the dashboard")
    }

    // 4. Footer
    @ViewBuilder private var footer: some View {
        VStack(spacing: 6) {
            if let m = state.migration, (m.active ?? false) || (m.remaining ?? 0) > 0 {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    let remaining = m.remaining ?? 0
                    let total = m.total ?? 0
                    Text(remaining > 0
                        ? "Migrating \(remaining) of \(total) running session\(total == 1 ? "" : "s")…"
                        : "Migration complete")
                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(Brand.terracotta)
                    Spacer()
                }
            }
            HStack {
                automationsGlance
                Spacer()
            }
            HStack {
                Button("Open Dashboard") {
                    if let url = URL(string: Config.base) { NSWorkspace.shared.open(url) }
                }
                .buttonStyle(TerracottaLinkStyle(size: 12))
                Spacer()
                Button("Refresh now") {
                    Task { await state.refreshAll() }
                }
                .buttonStyle(TerracottaLinkStyle(size: 12))
            }
            HStack {
                Toggle("Start at Login", isOn: Binding(
                    get: { state.startAtLogin },
                    set: { state.setStartAtLogin($0) }
                ))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .font(.system(size: 12))
                .foregroundStyle(Brand.ink)
                .tint(Brand.terracotta)
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
                    .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(Brand.inkMute)
            }
        }
    }
}

// MARK: - Menubar icon

// AI Makers diamond, bundled into Contents/Resources by build.sh, used as the
// non-template menubar status icon so the brand always shows. Health still
// reads at a glance via the severity-tinted percent text beside it.
enum MenuIcon {
    static let diamondImage: NSImage? = {
        guard let url = Bundle.main.url(forResource: "aimakers-diamond", withExtension: "png") else { return nil }
        guard let img = NSImage(contentsOf: url) else { return nil }
        img.size = NSSize(width: 18, height: 18)
        img.isTemplate = false
        return img
    }()

    // Worst-percent severity for the active account, used to tint the % text.
    static func severity(_ acc: Account?) -> String {
        guard let acc = acc else { return "normal" }
        return acc.worstWeeklySeverity
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Kick off server-ensure + initial data load at launch, independent of the
        // popover ever being opened (MenuBarExtra content is lazy).
        AppState.shared.start()
    }
}

@main
struct AIOpsMenubarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var state = AppState.shared

    var body: some Scene {
        MenuBarExtra {
            ContentView()
                .environmentObject(state)
                .onAppear { Task { await state.refreshAll() } }
        } label: {
            // Icon health reads off the active CLAUDE account only — codex
            // accounts have no usage limits and must not drive the badge.
            let claude = state.activeClaudeAccount
            let pct = claude?.worstWeeklyPercent ?? 0
            let sev = MenuIcon.severity(claude)
            HStack(spacing: 3) {
                if let diamond = MenuIcon.diamondImage {
                    Image(nsImage: diamond)
                } else {
                    Image(systemName: "diamond.fill")
                }
                if pct >= 70 {
                    Text("\(pct)%")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Severity.color(sev))
                }
            }
        }
        .menuBarExtraStyle(.window)
    }
}
