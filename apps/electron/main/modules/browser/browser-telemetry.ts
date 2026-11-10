export let BROWSER_TELEMETRY_COOLDOWN_MS = 30000;
/** Shared outbox holds 200 events; browser events may occupy at most this many per window. */
export let BROWSER_TELEMETRY_QUOTA = 50;
export let BROWSER_TELEMETRY_QUOTA_WINDOW_MS = 10 * 60000;
export let BROWSER_SESSION_IDLE_MS = 30 * 60000;
export let BROWSER_SESSION_SEGMENT_MS = 6 * 60 * 60000;
export let BROWSER_RESOURCE_SAMPLE_INTERVAL_MS = 5 * 60000;
export let BROWSER_RECENT_EVENT_LIMIT = 200;
const DURATION_BUCKETS_MS = [0, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000];
const MEMORY_BUCKETS_MB = [0, 64, 128, 256, 512, 768, 1024, 1536, 2048, 3072, 4096, 8192];
const CPU_BUCKETS_PCT = [0, 1, 5, 10, 25, 50, 75, 100, 150, 200, 400];
const FRAME_BUCKETS = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55];
const AGENT_ACTIONS = [
    'navigate',
    'screenshot',
    'snapshot',
    'click',
    'type',
    'scroll',
    'evaluate',
    'other',
];
/** Fixed-bucket histogram; quantiles report the bucket upper bound (or max). */
export class BrowserTelemetryHistogram {
    constructor(bounds) {
        this.bounds = bounds;
        this.total = 0;
        this.maxValue = 0;
        this.counts = new Array(bounds.length + 1).fill(0);
    }
    add(value) {
        if (!Number.isFinite(value) || value < 0)
            return;
        let index = this.bounds.findIndex((bound) => value <= bound);
        if (index < 0)
            index = this.bounds.length;
        this.counts[index] += 1;
        this.total += 1;
        this.maxValue = Math.max(this.maxValue, value);
    }
    get count() {
        return this.total;
    }
    get max() {
        return this.total ? this.maxValue : undefined;
    }
    quantile(q) {
        if (!this.total)
            return undefined;
        const target = Math.max(1, Math.ceil(this.total * q));
        let seen = 0;
        for (let index = 0; index < this.counts.length; index += 1) {
            seen += this.counts[index];
            if (seen >= target)
                return Math.min(this.bounds[index] ?? this.maxValue, this.maxValue);
        }
        return this.maxValue;
    }
}

/** Mapping from the Browser tool vocabulary onto the reported action enum. */
export function classifyBrowserAgentAction(tool) {
    switch (tool) {
        case 'navigate':
            return 'navigate';
        case 'screenshot':
            return 'screenshot';
        case 'inspect':
        case 'get_dom':
        case 'inspect_editable_targets':
        case 'verify_text':
            return 'snapshot';
        case 'click':
        case 'double_click':
        case 'triple_click':
        case 'hover':
        case 'drag':
        case 'check':
        case 'uncheck':
        case 'select_option':
            return 'click';
        case 'type':
        case 'fill':
        case 'paste':
        case 'press_key':
            return 'type';
        case 'scroll':
            return 'scroll';
        case 'evaluate':
            return 'evaluate';
        default:
            return 'other';
    }
}
/** Remote payloads carry only the scheme; never a host, path or query. */
export function browserUrlScheme(url) {
    if (!url)
        return 'about';
    try {
        const scheme = new URL(url).protocol.replace(/:$/, '');
        return ['http', 'https', 'file', 'about', 'data', 'blob', 'chrome'].includes(scheme)
            ? scheme
            : 'other';
    }
    catch {
        return 'other';
    }
}
/** Diagnostics-only host for the feedback bundle; never sent remotely. */
export function browserUrlHost(url) {
    if (!url)
        return undefined;
    try {
        const { protocol, host } = new URL(url);
        return protocol === 'http:' || protocol === 'https:' ? host : undefined;
    }
    catch {
        return undefined;
    }
}
class SessionAggregate {
    constructor(now) {
        this.counters = {};
        this.tabsCurrent = 0;
        this.tabsMax = 0;
        this.guestsMax = 0;
        this.rss = new BrowserTelemetryHistogram(MEMORY_BUCKETS_MB);
        this.cpu = new BrowserTelemetryHistogram(CPU_BUCKETS_PCT);
        this.mainRssMax = 0;
        this.layoutRoundtrip = new BrowserTelemetryHistogram(DURATION_BUCKETS_MS);
        this.dragLag = new BrowserTelemetryHistogram(FRAME_BUCKETS);
        this.agent = new Map();
        this.startedAt = now;
        this.lastActivityAt = now;
    }
    bump(counter, by = 1) {
        this.counters[counter] = (this.counters[counter] ?? 0) + by;
    }
    hasActivity() {
        return (Object.values(this.counters).some((value) => value > 0) ||
            this.rss.count > 0 ||
            this.layoutRoundtrip.count > 0 ||
            this.agent.size > 0);
    }
}
export class BrowserTelemetry {
    constructor(deps) {
        this.deps = deps;
        this.cooldowns = new Map();
        this.quotaWindowStart = 0;
        this.quotaUsed = 0;
        this.sessions = new Map();
        this.recent = [];
        this.resourceTimer = null;
        this.idleTimer = null;
        this.launchReported = false;
        this.lastResources = null;
    }
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }
    // ---- event reporting -------------------------------------------------
    /**
     * Reports an incident immediately. `cooldownKey` groups repeats (e.g. per
     * tab); repeats within the cooldown are counted and attached to the next one.
     */
    report(eventName, page, fields, options = {}) {
        try {
            const now = this.deps.now();
            this.remember(eventName, page, fields, options.host, now);
            let suppressedCount = 0;
            if (options.cooldownKey) {
                const key = `${eventName}:${options.cooldownKey}`;
                const state = this.cooldowns.get(key);
                if (state && now < state.until) {
                    state.suppressed += 1;
                    return false;
                }
                suppressedCount = state?.suppressed ?? 0;
                this.cooldowns.set(key, { until: now + BROWSER_TELEMETRY_COOLDOWN_MS, suppressed: 0 });
                if (this.cooldowns.size > 500)
                    this.pruneCooldowns(now);
            }
            if (!this.takeQuota(now))
                return false;
            const payload = {
                ...this.commonFields(page),
                ...fields,
                ...(suppressedCount ? { suppressed_count: suppressedCount } : {}),
            };
            this.deps.enqueue(eventName, payload, options.kind ?? 'action');
            this.deps.log({ msg: `[BrowserTelemetry] ${eventName}`, ...payload });
            return true;
        }
        catch {
            return false;
        }
    }
    reportLaunch(fields) {
        if (this.launchReported)
            return;
        this.launchReported = true;
        this.report('browser.backend_launch', {}, {
            backend: fields.backend,
            wait_ms: fields.waitMs,
            ...(fields.latestBackend ? { latest_backend: fields.latestBackend } : {}),
        });
    }
    // ---- session aggregation --------------------------------------------
    count(backend, counter, by = 1) {
        const session = this.session(backend);
        session.bump(counter, by);
    }
    tabOpened(backend) {
        const session = this.session(backend);
        session.bump('tabs_created');
        session.tabsCurrent += 1;
        session.tabsMax = Math.max(session.tabsMax, session.tabsCurrent);
        this.ensureTimers();
    }
    tabClosed(backend) {
        const session = this.session(backend);
        session.tabsCurrent = Math.max(0, session.tabsCurrent - 1);
    }
    guestCount(backend, count) {
        const session = this.session(backend);
        session.guestsMax = Math.max(session.guestsMax, count);
    }
    agentOperation(backend, tool, durationMs, ok, background) {
        const session = this.session(backend);
        const action = classifyBrowserAgentAction(tool);
        let entry = session.agent.get(action);
        if (!entry) {
            entry = {
                count: 0,
                failed: 0,
                background: 0,
                durations: new BrowserTelemetryHistogram(DURATION_BUCKETS_MS),
            };
            session.agent.set(action, entry);
        }
        entry.count += 1;
        if (!ok)
            entry.failed += 1;
        if (background)
            entry.background += 1;
        entry.durations.add(durationMs);
        if (!ok)
            this.remember('agent_op_failed', { rendererBackend: backend }, { action }, undefined);
    }
    /** Renderer-side layout/drag/compat signals, batched over IPC. */
    rendererBatch(batch) {
        const session = this.session(batch.rendererBackend);
        for (const value of batch.layoutRoundtripMs ?? [])
            session.layoutRoundtrip.add(value);
        if (batch.layoutCommands)
            session.bump('layout_command_count', batch.layoutCommands);
        for (const drag of batch.drags ?? []) {
            session.bump('drag_count');
            session.bump('drag_long_frames', drag.longFrames);
            session.dragLag.add(drag.lagFrames);
            this.deps.log({
                msg: '[BrowserTelemetry] drag',
                rendererBackend: batch.rendererBackend,
                durationMs: drag.durationMs,
                lagFrames: drag.lagFrames,
                longFrames: drag.longFrames,
            });
        }
        if (batch.compatibility?.freeze)
            session.bump('freeze_count', batch.compatibility.freeze);
        if (batch.compatibility?.nativeMenu)
            session.bump('native_menu_count', batch.compatibility.nativeMenu);
        if (batch.compatibility?.parking)
            session.bump('parking_count', batch.compatibility.parking);
        for (const failure of batch.layoutFailures ?? []) {
            session.bump('layout_failed_count');
            this.report('browser.layout_failed', { rendererBackend: batch.rendererBackend }, { command: failure.command, attempts: failure.attempts }, { cooldownKey: `layout:${failure.command}` });
        }
    }
    sampleResources(reason) {
        try {
            const sample = this.deps.sampleResources?.() ?? null;
            if (!sample)
                return null;
            const now = this.deps.now();
            this.lastResources = { ...sample, ts: now };
            for (const session of this.sessions.values()) {
                session.rss.add(sample.browserRssMb);
                session.cpu.add(sample.browserCpuPct);
                session.mainRssMax = Math.max(session.mainRssMax, sample.mainRssMb);
            }
            this.deps.log({ msg: '[BrowserTelemetry] resources', reason, ...sample });
            return sample;
        }
        catch {
            return null;
        }
    }
    /** Flushes summaries: on quit, after idle, or every segment for long sessions. */
    flushSessions(reason) {
        const now = this.deps.now();
        for (const [backend, session] of [...this.sessions]) {
            if (!session.hasActivity())
                continue;
            const tabsOpen = session.tabsCurrent;
            this.report('browser.session_summary', { rendererBackend: backend }, this.summaryFields(session, now, reason));
            const next = new SessionAggregate(now);
            next.tabsCurrent = tabsOpen;
            next.tabsMax = tabsOpen;
            this.sessions.set(backend, next);
        }
    }
    // ---- diagnostics ----------------------------------------------------
    snapshot() {
        const now = this.deps.now();
        const sessions = {};
        for (const [backend, session] of this.sessions) {
            sessions[backend] = this.summaryFields(session, now, 'segment');
        }
        return { sessions, recentEvents: [...this.recent], lastResources: this.lastResources };
    }
    dispose() {
        if (this.resourceTimer)
            clearInterval(this.resourceTimer);
        if (this.idleTimer)
            clearInterval(this.idleTimer);
        this.resourceTimer = null;
        this.idleTimer = null;
    }
    // ---- internals ------------------------------------------------------
    commonFields(page) {
        const launch = this.deps.launch();
        return {
            ...(page.rendererBackend ? { renderer_backend: page.rendererBackend } : {}),
            ...(page.surfaceKind ? { surface_kind: page.surfaceKind } : {}),
            ...(page.presentation ? { presentation: page.presentation } : {}),
            ...(launch.launchBackend ? { launch_backend: launch.launchBackend } : {}),
            ...(launch.launchSource ? { launch_source: launch.launchSource } : {}),
            policy_revision: launch.policyRevision,
            pending_restart: launch.pendingRestart,
        };
    }
    session(backend) {
        const key = backend ?? 'web-contents-view';
        const now = this.deps.now();
        let session = this.sessions.get(key);
        if (!session) {
            session = new SessionAggregate(now);
            this.sessions.set(key, session);
        }
        session.lastActivityAt = now;
        return session;
    }
    summaryFields(session, now, reason) {
        const fields = {
            summary_reason: reason,
            duration_ms: Math.max(0, now - session.startedAt),
            tabs_max_concurrent: session.tabsMax,
            guests_max: session.guestsMax,
            sample_count: session.rss.count,
            ...session.counters,
        };
        const set = (name, value) => {
            if (value !== undefined)
                fields[name] = value;
        };
        set('browser_rss_mb_p50', session.rss.quantile(0.5));
        set('browser_rss_mb_p95', session.rss.quantile(0.95));
        set('browser_rss_mb_max', session.rss.max);
        set('browser_cpu_pct_p50', session.cpu.quantile(0.5));
        set('browser_cpu_pct_p95', session.cpu.quantile(0.95));
        set('browser_cpu_pct_max', session.cpu.max);
        if (session.mainRssMax)
            fields.main_rss_mb_max = session.mainRssMax;
        set('layout_roundtrip_ms_p50', session.layoutRoundtrip.quantile(0.5));
        set('layout_roundtrip_ms_p95', session.layoutRoundtrip.quantile(0.95));
        set('drag_lag_frames_p95', session.dragLag.quantile(0.95));
        let agentCount = 0;
        let agentFailed = 0;
        for (const action of AGENT_ACTIONS) {
            const entry = session.agent.get(action);
            if (!entry)
                continue;
            agentCount += entry.count;
            agentFailed += entry.failed;
            fields[`agent_${action}_count`] = entry.count;
            fields[`agent_${action}_failed`] = entry.failed;
            fields[`agent_${action}_background_count`] = entry.background;
            set(`agent_${action}_p50_ms`, entry.durations.quantile(0.5));
            set(`agent_${action}_p95_ms`, entry.durations.quantile(0.95));
        }
        if (agentCount) {
            fields.agent_op_count = agentCount;
            fields.agent_op_failed = agentFailed;
        }
        return fields;
    }
    remember(event, page, fields, host, now = this.deps.now()) {
        this.recent.push({
            ts: now,
            event,
            ...(page.rendererBackend ? { rendererBackend: page.rendererBackend } : {}),
            ...(page.surfaceKind ? { surfaceKind: page.surfaceKind } : {}),
            ...(host ? { host } : {}),
            fields,
        });
        if (this.recent.length > BROWSER_RECENT_EVENT_LIMIT)
            this.recent.shift();
    }
    takeQuota(now) {
        if (now - this.quotaWindowStart >= BROWSER_TELEMETRY_QUOTA_WINDOW_MS) {
            this.quotaWindowStart = now;
            this.quotaUsed = 0;
        }
        if (this.quotaUsed >= BROWSER_TELEMETRY_QUOTA)
            return false;
        this.quotaUsed += 1;
        return true;
    }
    pruneCooldowns(now) {
        for (const [key, state] of this.cooldowns)
            if (state.until <= now)
                this.cooldowns.delete(key);
    }
    ensureTimers() {
        if (!this.resourceTimer) {
            this.resourceTimer = setInterval(() => {
                const hasTabs = [...this.sessions.values()].some((session) => session.tabsCurrent > 0);
                if (hasTabs)
                    this.sampleResources('interval');
            }, BROWSER_RESOURCE_SAMPLE_INTERVAL_MS);
            this.resourceTimer.unref?.();
        }
        if (!this.idleTimer) {
            this.idleTimer = setInterval(() => {
                const now = this.deps.now();
                for (const session of this.sessions.values()) {
                    if (!session.hasActivity())
                        continue;
                    if (session.tabsCurrent === 0 &&
                        now - session.lastActivityAt >= BROWSER_SESSION_IDLE_MS) {
                        this.flushSessions('idle');
                        return;
                    }
                    if (now - session.startedAt >= BROWSER_SESSION_SEGMENT_MS) {
                        this.flushSessions('segment');
                        return;
                    }
                }
            }, 60000);
            this.idleTimer.unref?.();
        }
    }
}

