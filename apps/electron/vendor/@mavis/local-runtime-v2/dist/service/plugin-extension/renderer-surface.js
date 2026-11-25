import { settleInBackground } from '../../infra/async/settle.js';
import { SubscriberRegistry } from '../../infra/sse/subscriber-registry.js';
const HEARTBEAT_MS = 15_000;
/**
 * Per-stream backlog a slow reader may hold. Past it the stream ends; the renderer reconnects and
 * refetches entries and every site, so nothing missed stays stale.
 */
const STREAM_MAX_ITEMS = 256;
const STREAM_MAX_BYTES = 512 * 1_024;
const MAX_PROPS_VERSIONS = 2_000;
/**
 * `report` reason of the paused placeholder's 「重试」: the renderer has no route of its own for it,
 * so it rides `report` and never counts toward the breaker.
 */
const RETRY_REPORT_REASON = 'retry';
/** A failure the HTTP controller maps by `code`. */
class ExtensionSurfaceError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'ExtensionSurfaceError';
    }
}
/**
 * Renderer transport of one runtime (two.md §7). The disabled state comes from the session's
 * activation records. A session has one view lease here: the routes carry no view identity, so mounts in two windows of one
 * session are not told apart.
 */
export class ExtensionRendererSurfaceService {
    deps;
    versions = new Map();
    leases = new Map();
    propsVersions = new Map();
    streams = new SubscriberRegistry({
        maxItems: STREAM_MAX_ITEMS,
        maxBytes: STREAM_MAX_BYTES,
    });
    unsubscribe;
    heartbeat;
    retrySeq = 0;
    constructor(deps) {
        this.deps = deps;
        this.unsubscribe = deps.subscribe((event) => {
            if (event.type === 'entries-changed')
                this.bump(event.sessionId);
            else if (event.type === 'invalidate' && event.key === undefined)
                this.bump(event.sessionId);
            this.streams.publish({ timestamp: deps.nowMs(), event });
        });
        this.heartbeat = setInterval(() => this.streams.publish({ timestamp: deps.nowMs() }), HEARTBEAT_MS);
        this.heartbeat.unref?.();
    }
    async listEntries(sessionId) {
        await this.requireSession(sessionId);
        const records = this.deps.listActivations(sessionId);
        return {
            version: this.versions.get(sessionId) ?? 0,
            viewLease: this.leaseOf(sessionId),
            disabled: this.disabled(sessionId, records),
        };
    }
    async render(input) {
        await this.requireSession(input.sessionId);
        const props = readProps(input.props);
        const response = await this.deps.host.render({
            sessionId: input.sessionId,
            slot: input.slot,
            key: input.key,
            ...(isSurface(input.surface) ? { surface: input.surface } : {}),
            props,
            propsVersion: this.propsVersion(input, props),
            viewLease: input.viewLease,
            match: this.matchFields(input.slot, props),
        });
        if (response.kind === 'tree') {
            return {
                kind: 'tree',
                renderSeq: response.renderSeq,
                tree: response.tree,
                ...(response.coreProps ? { coreProps: response.coreProps } : {}),
            };
        }
        return response;
    }
    async gesture(input) {
        await this.requireSession(input.sessionId);
        const site = { sessionId: input.sessionId, slot: input.slot, key: input.key };
        const request = {
            ...site,
            plugin: input.plugin,
            renderSeq: input.renderSeq,
            handle: input.handle,
            ...(input.value === undefined ? {} : { value: input.value }),
        };
        return settled(await this.deps.host[input.kind](request));
    }
    async applied(input) {
        await this.requireSession(input.sessionId);
        this.deps.host.applied(input);
    }
    /**
     * Renderer-side fallbacks are accepted and checked; they never count toward the breaker. A
     * `retry` report resets this session's breaker of the plugins that paused the site.
     */
    async report(input) {
        await this.requireSession(input.sessionId);
        if (input.reason !== RETRY_REPORT_REASON)
            return;
        const site = { sessionId: input.sessionId, slot: input.slot, key: input.key };
        for (const plugin of this.deps.host.retrySite(site)) {
            this.retrySeq += 1;
            this.deps.audit.record({
                origin: { ...plugin, ...site },
                callId: `breaker-reset-${this.retrySeq}`,
                domain: 'host',
                method: 'breaker.reset',
                outcome: { status: 'ok', stampedAt: this.deps.nowMs() },
                durationMs: 0,
            });
        }
    }
    async answerQuery(input) {
        await this.requireSession(input.sessionId);
        this.deps.answerQuery(input);
    }
    async closePane(input) {
        await this.requireSession(input.sessionId);
        this.deps.panes.close(input.sessionId, input.pluginId, input.id);
        // Syncs the host with the session's records before it looks for hooks.
        this.deps.listActivations(input.sessionId);
        // The tab is already gone; the plugin's hooks run on their own queue.
        settleInBackground(this.deps.host.observe({
            sessionId: input.sessionId,
            event: 'ui.close',
            payload: { sessionId: input.sessionId, id: input.id },
            match: { id: input.id },
            pluginId: input.pluginId,
        }));
    }
    async openStream(sessionId, signal) {
        await this.requireSession(sessionId);
        return this.events(sessionId, signal);
    }
    deleteSession(sessionId) {
        this.versions.delete(sessionId);
        this.deps.panes.deleteSession(sessionId);
        const lease = this.leases.get(sessionId);
        if (lease)
            this.deps.host.releaseViewLease(lease);
        this.leases.delete(sessionId);
        for (const key of [...this.propsVersions.keys()]) {
            if (key.startsWith(`${JSON.stringify(sessionId)},`))
                this.propsVersions.delete(key);
        }
    }
    close() {
        clearInterval(this.heartbeat);
        this.unsubscribe();
        this.streams.close();
    }
    /**
     * Subscribes at once, so nothing emitted before the first read is lost, and starts with a
     * `pane.snapshot` of every pane tab open in the session at that moment: the roster is the
     * authority, so a renderer that subscribes late, again after a reload or a reconnect, or back on
     * a session it left drops the tabs closed or withdrawn meanwhile and shows the ones opened
     * without it. A reader past the backlog limit gets the end of the stream.
     */
    events(sessionId, signal) {
        const subscription = this.streams.subscribe({
            filter: ({ event }) => event === undefined || concernsSession(event, sessionId),
        });
        const snapshot = {
            kind: 'pane.snapshot',
            timestamp: this.deps.nowMs(),
            panes: this.deps.panes.list(sessionId),
        };
        const stop = () => subscription.close();
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted)
            stop();
        const toFrame = (published) => this.toFrame(sessionId, published);
        return (async function* read() {
            try {
                yield snapshot;
                for (;;) {
                    let next;
                    try {
                        next = await subscription.next();
                    }
                    catch {
                        return; // Overflow: the renderer reconnects and refetches.
                    }
                    if (next.done)
                        return;
                    yield toFrame(next.value);
                }
            }
            finally {
                signal?.removeEventListener('abort', stop);
                stop();
            }
        })();
    }
    toFrame(sessionId, { timestamp, event }) {
        if (event === undefined)
            return { kind: 'heartbeat', timestamp };
        if (event.type === 'entries-changed' || (event.type === 'invalidate' && !event.key)) {
            return { kind: 'entries-changed', timestamp, version: this.versions.get(sessionId) ?? 0 };
        }
        return sessionFrame(event, timestamp);
    }
    bump(sessionId) {
        const sessions = sessionId === undefined ? [...this.leases.keys()] : [sessionId];
        for (const id of sessions)
            this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    }
    leaseOf(sessionId) {
        let lease = this.leases.get(sessionId);
        if (!lease) {
            lease = this.deps.host.issueViewLease(sessionId);
            this.leases.set(sessionId, lease);
        }
        return lease;
    }
    /** A site instance's props version moves only when its props change. */
    propsVersion(site, props) {
        const key = [site.sessionId, site.slot, site.key].map((part) => JSON.stringify(part)).join();
        const json = JSON.stringify(props);
        const prior = this.propsVersions.get(key);
        if (prior?.json === json)
            return prior.version;
        const version = (prior?.version ?? 0) + 1;
        this.propsVersions.delete(key);
        this.propsVersions.set(key, { json, version });
        while (this.propsVersions.size > MAX_PROPS_VERSIONS) {
            this.propsVersions.delete(this.propsVersions.keys().next().value ?? '');
        }
        return version;
    }
    /** Matcher values other than the key (`id`) are read from same-named string props. */
    matchFields(slot, props) {
        const fields = {};
        for (const field of this.deps.sites.get(slot)?.matcherFields ?? []) {
            const value = props[field.name];
            if (field.name !== 'id' && typeof value === 'string')
                fields[field.name] = value;
        }
        return fields;
    }
    disabled(sessionId, records) {
        const live = new Map(records.map((record) => [record.pluginId, record]));
        const health = this.deps.host.inspect({ sessionId });
        const disabled = [];
        for (const realm of health.disabledPlugins) {
            const at = realm.lastIndexOf('@');
            const record = live.get(realm.slice(0, at));
            if (record && realm.slice(at + 1) === record.artifactDigest) {
                disabled.push({ pluginId: record.pluginId });
            }
        }
        for (const hook of health.disabledHooks) {
            const record = live.get(hook.pluginId);
            if (!record || hook.artifactDigest !== record.artifactDigest)
                continue;
            disabled.push({ pluginId: hook.pluginId, slot: hook.slot, entry: hook.entry });
        }
        return disabled;
    }
    async requireSession(sessionId) {
        if (await this.deps.sessionExists(sessionId))
            return;
        throw new ExtensionSurfaceError('SESSION_NOT_FOUND', `session ${sessionId} does not exist`);
    }
}
/** Whether a published event reaches the stream of `sessionId`. */
function concernsSession(event, sessionId) {
    if (event.type === 'entries-changed' || (event.type === 'invalidate' && !event.key)) {
        return event.sessionId === undefined || event.sessionId === sessionId;
    }
    return event.sessionId === sessionId;
}
function toastFrame(event, timestamp) {
    const { pluginId, text, tone } = event;
    return { kind: 'toast', timestamp, pluginId, text, ...(tone !== undefined ? { tone } : {}) };
}
function sessionFrame(event, timestamp) {
    switch (event.type) {
        case 'invalidate':
            return { kind: 'invalidate', timestamp, slot: event.slot, key: event.key ?? '' };
        case 'ui.toast':
            return toastFrame(event, timestamp);
        case 'ui.open':
            return {
                kind: 'ui.open',
                timestamp,
                pluginId: event.pluginId,
                id: event.id,
                title: event.title,
                ...(event.focus !== undefined ? { focus: event.focus } : {}),
            };
        case 'ui.close':
            return { kind: 'ui.close', timestamp, pluginId: event.pluginId, id: event.id };
        case 'query':
            return {
                kind: 'query',
                timestamp,
                requestId: event.requestId,
                sessionId: event.sessionId,
                op: event.op,
                ...(event.composerSuggest ? { composerSuggest: event.composerSuggest } : {}),
                ...(event.composerFill ? { composerFill: event.composerFill } : {}),
            };
    }
}
function readProps(props) {
    if (props === undefined)
        return {};
    if (typeof props === 'object' && props !== null && !Array.isArray(props)) {
        return props;
    }
    throw new ExtensionSurfaceError('EXTENSION_REQUEST_INVALID', 'props must be a JSON object');
}
function isSurface(value) {
    return value === 'desktop' || value === 'web' || value === 'tui';
}
function settled(response) {
    if ('kind' in response)
        throw new ExtensionSurfaceError(response.code, response.message);
    return response;
}
//# sourceMappingURL=renderer-surface.js.map