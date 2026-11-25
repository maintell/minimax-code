export function breakerKeyOf(parts) {
    return `${parts.pluginId}|${parts.slot}:${parts.entry}|${parts.tier}|${parts.artifactDigest}|${parts.sessionId}`;
}
/**
 * Inverse of `breakerKeyOf`. Plugin ids, slots, tiers, digests and session ids never hold `|`
 * and slots never hold `:`; only the entry label may, so it is read last.
 * @internal Exported for focused tests.
 */
export function breakerKeyParts(key) {
    const first = key.indexOf('|');
    const fields = key.slice(first + 1).split('|');
    const sessionId = fields.pop();
    const artifactDigest = fields.pop();
    const tier = fields.pop();
    const site = fields.join('|');
    const colon = site.indexOf(':');
    if (first < 0 || sessionId === undefined || !artifactDigest || !tier || colon < 0) {
        return undefined;
    }
    return {
        pluginId: key.slice(0, first),
        slot: site.slice(0, colon),
        entry: site.slice(colon + 1),
        tier,
        artifactDigest,
        sessionId,
    };
}
/** The hook breaker key belongs to `sessionId`. */
function isSessionBreakerKey(key, sessionId) {
    return key.endsWith(`|${sessionId}`);
}
/**
 * `id` for entry sites, the site for `ui.render`, `server/tool` for tool bindings, `*` without a
 * matcher.
 */
export function entryLabel(matcher) {
    if (!matcher)
        return '*';
    if (matcher.id !== undefined)
        return matcher.id;
    if (matcher.site !== undefined)
        return matcher.site;
    if (matcher.server !== undefined) {
        return matcher.tool === undefined ? matcher.server : `${matcher.server}/${matcher.tool}`;
    }
    return JSON.stringify(matcher);
}
/**
 * `written` is the realm the attribution memory names (undefined when the Worker was back in its
 * own loop); `inflight` are realms with unsettled Invocations on that Worker.
 */
export function attributeCrash(written, inflight) {
    const candidates = [...new Set(written ? [written, ...inflight] : inflight)];
    if (written && candidates.length === 1)
        return { kind: 'certain', realmKey: written };
    if (candidates.length > 0)
        return { kind: 'uncertain', candidates };
    return { kind: 'none' };
}
export class HealthLedger {
    limits;
    clock;
    failures = new Map();
    disabledHooks = new Set();
    disabledRealms = new Set();
    suspects = new Map();
    unattributed = [];
    constructor(limits, clock) {
        this.limits = limits;
        this.clock = clock;
    }
    /** Returns true when this failure disabled the hook. */
    recordFailure(breakerKey) {
        if (this.disabledHooks.has(breakerKey))
            return false;
        const count = (this.failures.get(breakerKey) ?? 0) + 1;
        this.failures.set(breakerKey, count);
        if (count < this.limits.breakerThreshold)
            return false;
        this.disabledHooks.add(breakerKey);
        this.failures.delete(breakerKey);
        return true;
    }
    recordSuccess(breakerKey) {
        this.failures.delete(breakerKey);
    }
    isHookDisabled(breakerKey) {
        return this.disabledHooks.has(breakerKey);
    }
    disableRealm(realmKey) {
        this.disabledRealms.add(realmKey);
    }
    isRealmDisabled(realmKey) {
        return this.disabledRealms.has(realmKey);
    }
    applyCrash(attribution) {
        if (attribution.kind === 'certain') {
            this.suspects.clear();
            this.disableRealm(attribution.realmKey);
            return { disabled: [attribution.realmKey], switchIsolation: false };
        }
        if (attribution.kind === 'uncertain')
            return { disabled: this.suspect(attribution.candidates), switchIsolation: false };
        const now = this.clock.now();
        this.unattributed = [
            ...this.unattributed.filter((at) => now - at < this.limits.unattributedWindowMs),
            now,
        ];
        if (this.unattributed.length < 2)
            return { disabled: [], switchIsolation: false };
        this.unattributed = [];
        return { disabled: [], switchIsolation: true };
    }
    /**
     * 「重试」: clears the hook breakers `pluginId` has in `sessionId`, and the crash disable and
     * suspicion of the given revisions (the plugin's live revisions in that session).
     */
    resetSession(pluginId, sessionId, realmKeys) {
        const owns = (key) => key.startsWith(`${pluginId}|`) && isSessionBreakerKey(key, sessionId);
        for (const key of [...this.failures.keys()])
            if (owns(key))
                this.failures.delete(key);
        for (const key of [...this.disabledHooks])
            if (owns(key))
                this.disabledHooks.delete(key);
        for (const realmKey of realmKeys) {
            this.disabledRealms.delete(realmKey);
            this.suspects.delete(realmKey);
        }
    }
    /** A deleted session leaves no breaker counts behind. */
    forgetSession(sessionId) {
        for (const key of [...this.failures.keys()]) {
            if (isSessionBreakerKey(key, sessionId))
                this.failures.delete(key);
        }
        for (const key of [...this.disabledHooks]) {
            if (isSessionBreakerKey(key, sessionId))
                this.disabledHooks.delete(key);
        }
    }
    snapshot() {
        return { disabledHooks: [...this.disabledHooks], disabledRealms: [...this.disabledRealms] };
    }
    /** Suspicion only counts consecutive crashes: a crash without the realm clears it. */
    suspect(candidates) {
        for (const key of [...this.suspects.keys()]) {
            if (!candidates.includes(key))
                this.suspects.delete(key);
        }
        const disabled = [];
        for (const realmKey of candidates) {
            const count = (this.suspects.get(realmKey) ?? 0) + 1;
            this.suspects.set(realmKey, count);
            if (count < this.limits.suspectThreshold)
                continue;
            this.suspects.delete(realmKey);
            this.disableRealm(realmKey);
            disabled.push(realmKey);
        }
        return disabled;
    }
}
/** Bounded newest-last buffer for diagnostics and traces. */
export class Ring {
    capacity;
    items = [];
    constructor(capacity) {
        this.capacity = capacity;
    }
    push(item) {
        this.items.push(item);
        if (this.items.length > this.capacity)
            this.items.splice(0, this.items.length - this.capacity);
    }
    list(filter = () => true) {
        return this.items.filter(filter);
    }
}
/** Tripped hook breakers as `inspect` lists them, narrowed to the filter. */
export function disabledHooksOf(keys, filter) {
    const hooks = [];
    for (const key of keys) {
        const parts = breakerKeyParts(key);
        if (!parts)
            continue;
        if (filter.pluginId !== undefined && parts.pluginId !== filter.pluginId)
            continue;
        if (filter.sessionId !== undefined && parts.sessionId !== filter.sessionId)
            continue;
        const { pluginId, slot, entry, artifactDigest, sessionId } = parts;
        hooks.push({ key, pluginId, slot, entry, artifactDigest, sessionId });
    }
    return hooks;
}
const FAILURE_SUMMARY_MAX = 300;
/** Summary of the newest failure of these plugins in this session; empty when none is kept. */
export function latestFailure(diagnostics, sessionId, pluginIds) {
    const latest = diagnostics
        .list((entry) => entry.pluginId !== undefined &&
        pluginIds.includes(entry.pluginId) &&
        (entry.sessionId === undefined || entry.sessionId === sessionId) &&
        entry.code !== 'EXTENSION_DISABLED' &&
        entry.code !== 'EXTENSION_BREAKER_RESET' &&
        !entry.code.startsWith('console.'))
        .at(-1);
    if (!latest)
        return '';
    const summary = `${latest.code}: ${latest.message}`;
    return summary.length > FAILURE_SUMMARY_MAX
        ? `${summary.slice(0, FAILURE_SUMMARY_MAX - 1)}…`
        : summary;
}
//# sourceMappingURL=breaker.js.map