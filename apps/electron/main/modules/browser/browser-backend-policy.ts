import { randomUUID } from "node:crypto";
const REFRESH_LEASE_MS = 30000;
const MAX_CONFIG_LENGTH = 4096;
/**
 * Longest a cold launch without a cached policy waits before opening native pages.
 * A fresh-connection read measured 0.2-0.45s, so 1s still covers slow links.
 */
export let BROWSER_BACKEND_LAUNCH_TIMEOUT_MS = 1000;
const NATIVE_BACKEND = 'web-contents-view';
const CONFIG_KEYS = new Set(['browser_rollout']);
// Retired fields stay accepted so already-published documents remain valid; they are never read.
const RETIRED_CONFIG_KEYS = new Set([
    'schema_version',
    'browser_backend',
    'miniapp_backend',
    'miniapp_rollout',
]);
const ROLLOUT_KEYS = new Set(['user_ids', 'user_id_hash_end_numbers']);
// Match Desktop update grayscale's unsigned DJB2 buckets; never sample per refresh/tab.
export function getBrowserBackendBucket(userId) {
    let hash = 5381;
    for (let index = 0; index < userId.length; index += 1) {
        hash = (hash * 33 + userId.charCodeAt(index)) >>> 0;
    }
    return hash % 10;
}
function parseRollout(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const config = value;
    if (Object.keys(config).some((key) => !ROLLOUT_KEYS.has(key)))
        return null;
    const userIds = config.user_ids;
    if (userIds !== undefined &&
        (!Array.isArray(userIds) ||
            userIds.some((item) => typeof item !== 'string' || item.trim().length === 0))) {
        return null;
    }
    const userIdHashEndNumbers = config.user_id_hash_end_numbers;
    if (userIdHashEndNumbers !== undefined &&
        (!Array.isArray(userIdHashEndNumbers) ||
            userIdHashEndNumbers.some((item) => !Number.isSafeInteger(item) || item < 0 || item > 9))) {
        return null;
    }
    return {
        userIds: userIds === undefined ? [] : [...new Set(userIds.map((item) => item.trim()))].sort(),
        userIdHashEndNumbers: userIdHashEndNumbers === undefined
            ? []
            : [...new Set(userIdHashEndNumbers)].sort((a, b) => a - b),
    };
}
/** Validates a remote or cached document; null means invalid, never "native". */
export function parseBrowserBackendPolicy(value) {
    if (value === undefined || value === null)
        return { rollout: null };
    if (typeof value === 'string') {
        if (value.length > MAX_CONFIG_LENGTH)
            return null;
        try {
            value = JSON.parse(value);
        }
        catch {
            return null;
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const config = value;
    if (Object.keys(config).some((key) => !CONFIG_KEYS.has(key) && !RETIRED_CONFIG_KEYS.has(key))) {
        return null;
    }
    if (config.browser_rollout === undefined)
        return { rollout: null };
    const rollout = parseRollout(config.browser_rollout);
    return rollout ? { rollout } : null;
}
function serializePolicy(document) {
    return document.rollout
        ? {
            browser_rollout: {
                user_ids: [...document.rollout.userIds],
                user_id_hash_end_numbers: [...document.rollout.userIdHashEndNumbers],
            },
        }
        : {};
}
/**
 * One backend per process. The first signed-in account fixes it from its cached
 * document, else from the first remote read, else native after a bounded wait.
 * Later policy changes (promotion or rollback) and account switches never change
 * it; they only update the per-account cache for the next launch, so a running
 * process never mixes Browser/Mini App backends.
 */
export class BrowserBackendPolicy {
    constructor(now = Date.now, launchTimeoutMs = BROWSER_BACKEND_LAUNCH_TIMEOUT_MS) {
        this.now = now;
        this.launchTimeoutMs = launchTimeoutMs;
        this.latest = null;
        this.latestSerialized = null;
        this.revision = 0;
        this.accountId = null;
        this.configured = false;
        /** Null until decided; once set it never changes for this process. */
        this.launch = null;
        this.launchWaiters = [];
        this.launchTimer = null;
        this.store = null;
        this.launchListeners = new Set();
        this.firstAccountAt = null;
        this.fetchRemote = null;
        this.launchFetch = null;
        this.leases = new Map();
    }
    /** Ends this process-level decision; only IPC shutdown and tests start over. */
    reset() {
        this.setAccount(null);
        this.clearLaunchTimer();
        this.launch = null;
        this.firstAccountAt = null;
        const waiters = this.launchWaiters;
        this.launchWaiters = [];
        for (const resolve of waiters)
            resolve();
        this.attachSources(null);
    }
    attachSources(sources) {
        this.store = sources?.store ?? null;
        this.fetchRemote = sources?.fetchRemote ?? null;
    }
    snapshot() {
        return {
            revision: this.revision,
            launchBackend: this.launch?.backend ?? null,
            launchSource: this.launch?.source ?? null,
        };
    }
    diagnosticSnapshot() {
        return {
            ...this.snapshot(),
            configured: this.configured,
            accountBound: this.accountId !== null,
            latestBackend: this.latest ? this.target(this.latest).backend : null,
        };
    }
    setAccount(accountId) {
        if (this.accountId === accountId)
            return;
        this.accountId = accountId;
        this.configured = false;
        this.leases.clear();
        this.launchFetch?.abort();
        this.launchFetch = null;
        this.latest = null;
        this.latestSerialized = null;
        this.revision += 1;
        if (!accountId)
            return;
        if (this.firstAccountAt === null)
            this.firstAccountAt = this.now();
        const cached = this.readCache(accountId);
        if (cached) {
            this.latest = cached;
            this.latestSerialized = JSON.stringify(cached);
        }
        // A decided launch is never re-evaluated: a later account only refreshes its
        // own cache and reports pending-restart when its target differs.
        if (this.launch)
            return;
        if (cached) {
            this.decideLaunch(this.target(cached).backend, 'cached');
        }
        else {
            // The bounded wait starts with the first account, not with the first page request.
            this.ensureLaunchTimer();
            this.startLaunchFetch(accountId);
        }
    }
    beginRefresh(owner) {
        if (!this.accountId)
            return null;
        const id = randomUUID();
        this.leases.set(owner, { id, expiresAt: this.now() + REFRESH_LEASE_MS });
        return id;
    }
    revokeOwner(owner) {
        this.leases.delete(owner);
    }
    applyRefresh(owner, leaseId, value) {
        const lease = this.leases.get(owner);
        if (!lease || lease.id !== leaseId || this.now() >= lease.expiresAt)
            return 'stale';
        this.leases.delete(owner);
        return this.apply(value);
    }
    apply(value) {
        const parsed = parseBrowserBackendPolicy(value);
        if (!parsed)
            return 'invalid';
        this.configured = true;
        // Parser output has canonical list order, so equivalent polls keep their revision.
        const serialized = JSON.stringify(parsed);
        if (serialized !== this.latestSerialized) {
            this.latest = parsed;
            this.latestSerialized = serialized;
            this.revision += 1;
            if (this.accountId)
                this.writeCache(this.accountId, parsed);
        }
        if (!this.launch)
            this.decideLaunch(this.target(parsed).backend, 'remote');
        return 'applied';
    }
    /** Synchronous selection once this launch decided; null while a cold launch waits. */
    selectIfDecided() {
        if (!this.launch && !this.accountId)
            this.decideLaunch(NATIVE_BACKEND, 'unavailable');
        return this.launch ? this.select() : null;
    }
    /**
     * Selection for a new Browser or Mini App page, waiting at most the launch
     * timeout. A page requested before any account has nothing to wait for and
     * locks this process native.
     */
    async resolveSelection() {
        if (!this.launch && !this.accountId)
            this.decideLaunch(NATIVE_BACKEND, 'unavailable');
        if (!this.launch) {
            await new Promise((resolve) => {
                this.launchWaiters.push(resolve);
                this.ensureLaunchTimer();
            });
        }
        return this.select();
    }
    select() {
        // Every new page in this process uses the launch backend; promotions and
        // rollbacks alike wait for the next launch.
        const backend = this.launch?.backend ?? NATIVE_BACKEND;
        const target = this.latest ? this.target(this.latest) : null;
        const requested = target?.backend ?? backend;
        const backendFallbackReason = requested !== backend
            ? 'pending-restart'
            : !target
                ? 'policy-unavailable'
                : target.notTargeted
                    ? 'rollout-not-targeted'
                    : undefined;
        return {
            rendererBackend: backend,
            requestedRendererBackend: requested,
            backendPolicyRevision: this.revision,
            ...(backendFallbackReason ? { backendFallbackReason } : {}),
        };
    }
    target(document) {
        if (!document.rollout)
            return { backend: NATIVE_BACKEND, notTargeted: false };
        const accountId = this.accountId;
        const matched = Boolean(accountId &&
            (document.rollout.userIds.includes(accountId) ||
                document.rollout.userIdHashEndNumbers.includes(getBrowserBackendBucket(accountId))));
        return matched
            ? { backend: 'webview', notTargeted: false }
            : { backend: NATIVE_BACKEND, notTargeted: true };
    }
    /** Cold launch without a cached document: Main reads Apollo itself, bounded by the timer. */
    startLaunchFetch(accountId) {
        const fetchRemote = this.fetchRemote;
        if (!fetchRemote)
            return;
        const controller = new AbortController();
        this.launchFetch = controller;
        const timer = setTimeout(() => controller.abort(), this.launchTimeoutMs);
        timer.unref?.();
        void fetchRemote(controller.signal)
            .then((value) => {
            if (this.launchFetch === controller && this.accountId === accountId)
                this.apply(value);
        })
            .catch(() => {
            // The renderer refresh or the launch timer still decides this launch.
        })
            .finally(() => {
            clearTimeout(timer);
            if (this.launchFetch === controller)
                this.launchFetch = null;
        });
    }
    decideLaunch(backend, source) {
        this.clearLaunchTimer();
        this.launch = { backend, source };
        const waiters = this.launchWaiters;
        this.launchWaiters = [];
        for (const resolve of waiters)
            resolve();
        const decision = {
            backend,
            source,
            waitMs: this.firstAccountAt === null ? 0 : Math.max(0, this.now() - this.firstAccountAt),
            latestBackend: this.latest ? this.target(this.latest).backend : null,
        };
        for (const listener of [...this.launchListeners]) {
            try {
                listener(decision);
            }
            catch {
                // Observers must never affect the launch decision.
            }
        }
    }
    /** Observes the one-time launch decision (telemetry). */
    onLaunchDecided(listener) {
        this.launchListeners.add(listener);
        return () => this.launchListeners.delete(listener);
    }
    ensureLaunchTimer() {
        if (this.launch || this.launchTimer)
            return;
        this.launchTimer = setTimeout(() => {
            this.launchTimer = null;
            if (!this.launch)
                this.decideLaunch(NATIVE_BACKEND, 'unavailable');
        }, this.launchTimeoutMs);
        this.launchTimer.unref?.();
    }
    clearLaunchTimer() {
        if (!this.launchTimer)
            return;
        clearTimeout(this.launchTimer);
        this.launchTimer = null;
    }
    readCache(accountId) {
        try {
            const raw = this.store?.load(accountId);
            return raw === undefined ? null : parseBrowserBackendPolicy(raw);
        }
        catch {
            return null;
        }
    }
    writeCache(accountId, document) {
        try {
            this.store?.save(accountId, serializePolicy(document));
        }
        catch {
            // A failed write only loses the next-launch hint; the current launch is unaffected.
        }
    }
}

export let browserBackendPolicy = new BrowserBackendPolicy();
