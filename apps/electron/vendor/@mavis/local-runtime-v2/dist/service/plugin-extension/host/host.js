import { createSiteTable, DEFAULT_SITE_TABLE, UI_RENDER_EVENT, } from '@mavis/shared/plugin-extension';
import { isExtensionErrorCode } from '../sdk/diagnostics.js';
import { OBSERVE_EVENT_NAMES } from '../sdk/contracts/events.js';
import { breakerKeyOf, disabledHooksOf, HealthLedger, latestFailure, Ring } from './breaker.js';
import { EXTENSION_TIER_ORDER, HOST_LIMITS } from './contracts.js';
import { CLOSED, CRASHED, DEADLINE, dispatchGesture, dispatchRender, LayerAborted, SUPERSEDED, systemClock, } from './dispatcher.js';
import { Invoker } from './invoker.js';
import { layerOf, siteClaimOf, uiRenderEventOf } from './render/site-hooks.js';
import { ObserveDispatch } from './observe.js';
import { realmKeyOf } from './protocol.js';
import { GestureQueues, RenderRegistry, siteKeyOf } from './render/render-registry.js';
import { PerPluginRateLimiter } from '../services/quota.js';
import { RealmLoadError, WorkerSupervisor } from './supervisor.js';
import { handleSites } from './render/handle-sites.js';
import { handleKey, isCoreOnly, siteCore } from './render/tree-guard.js';
/**
 * Main-thread ExtensionHost (two.md §0–§2, §4, §7, §11, §12). vm contexts are shared per
 * revision across sessions; activations, state, handles and evaluations are per session.
 */
const HANDLE_STALE = 'EXTENSION_HANDLE_STALE';
const silentLog = { info: () => undefined, warn: () => undefined };
function errorResponse(code, message) {
    return { kind: 'error', code, message };
}
function gestureCode(failure) {
    return isExtensionErrorCode(failure.code) ? failure.code : 'EXTENSION_HOOK_FAILED';
}
export class ExtensionHost {
    limits;
    clock;
    services;
    log;
    sites;
    supervisor;
    ledger;
    registry;
    gestures;
    observers;
    diagnostics;
    traces;
    invoker;
    activations = new Map();
    realmSessions = new Map();
    /** Realms loaded by `prepare` that no session runs yet. */
    prepared = new Set();
    inflight = new Map();
    subscriptions = new Map();
    consoleQuota;
    /** Site instances whose last render was answered "paused", with the plugins that paused it. */
    pausedSites = new Map();
    lifetime = new AbortController();
    background = new WeakSet();
    activationSeq = 0;
    constructor(options) {
        this.limits = { ...HOST_LIMITS, ...options.limits };
        this.clock = options.clock ?? systemClock;
        this.consoleQuota = new PerPluginRateLimiter(this.limits.consolePerMinute, () => this.clock.now());
        this.services = options.services;
        this.log = options.log ?? silentLog;
        this.sites = createSiteTable(options.sites ?? DEFAULT_SITE_TABLE);
        this.ledger = new HealthLedger(this.limits, this.clock);
        this.registry = new RenderRegistry(this.limits.handleTtlMs, this.clock, (record, seq) => this.releaseHandles(record, seq));
        this.gestures = new GestureQueues(this.limits.gestureQueueCapacity);
        this.observers = new ObserveDispatch({
            capacity: this.limits.observeQueueCapacity,
            ledger: this.ledger,
            records: (sessionId) => this.liveRecords(sessionId),
            run: (job) => this.runAction(job),
            diagnose: (entry) => this.diagnose(entry),
        });
        this.diagnostics = new Ring(this.limits.diagnosticsCapacity);
        this.traces = new Ring(this.limits.tracesCapacity);
        this.supervisor = this.createSupervisor(options);
        this.invoker = new Invoker({
            supervisor: this.supervisor,
            services: this.services,
            ledger: this.ledger,
            events: {
                stateWritten: (identity, key) => this.onStateWritten(identity.pluginId, identity.sessionId, key),
                invalidated: (invocation) => this.onInvalidated(invocation),
                callViolation: (invocation, name) => this.recordFailure({ plugin: invocation.identity.pluginId, breakerKey: invocation.breakerKey }, { code: 'CALL_NOT_DECLARED', message: name }, invocation.identity),
                storeSubscribed: (invocation, callbackId) => this.subscribe(invocation, callbackId),
                realmRejected: (activation, error) => this.rejectRealm(activation, error),
            },
        });
    }
    createSupervisor(options) {
        return new WorkerSupervisor({
            factory: options.workerFactory,
            limits: this.limits,
            clock: this.clock,
            slots: [
                UI_RENDER_EVENT,
                // `on(slot, …)` events; sites drawn by `ui.render` are not events.
                ...this.sites.slots.filter((slot) => {
                    const spec = this.sites.get(slot);
                    return spec !== undefined && spec.drawnBy === undefined;
                }),
                ...OBSERVE_EVENT_NAMES,
            ],
            isolation: 'shared',
            events: {
                onDeath: (death) => this.onWorkerDeath(death),
                onFire: (slotKey, message) => this.onFire(slotKey, message),
                onConsole: (realmKey, level, text) => this.onConsole(realmKey, level, text),
                onOrphanNotify: (slot, method, args) => this.onOrphanNotify(slot, method, args),
            },
        });
    }
    /** A drawing's own `invalidate` would re-run it forever, so only other Invocations redraw. */
    onInvalidated({ identity, activation }) {
        this.invalidateWhere((evaluation) => evaluation.sessionId === identity.sessionId &&
            evaluation.realmKeys.has(activation.realmKey));
    }
    onStateWritten(pluginId, sessionId, key) {
        this.invalidateWhere((evaluation) => evaluation.sessionId === sessionId &&
            evaluation.deps.some((dep) => dep.pluginId === pluginId && dep.key === key));
    }
    rejectRealm(activation, error) {
        const { input, realmKey } = activation;
        this.ledger.disableRealm(realmKey);
        this.diagnose({
            code: error.code,
            message: error.message,
            pluginId: input.pluginId,
            sessionId: input.sessionId,
        });
        this.services.emit({ type: 'entries-changed', pluginId: input.pluginId });
    }
    // -------------------------------------------------------------------------------------------
    // Activations
    async prepare(input) {
        if (this.lifetime.signal.aborted) {
            return { ok: false, code: 'EXTENSION_HOST_CLOSED', message: 'host closed' };
        }
        const realmKey = realmKeyOf(input.pluginId, input.artifact.digest);
        const breakerKey = breakerKeyOf({
            pluginId: input.pluginId,
            slot: 'register',
            entry: '*',
            tier: input.tier,
            artifactDigest: input.artifact.digest,
            sessionId: input.sessionId,
        });
        if (this.ledger.isHookDisabled(breakerKey)) {
            return {
                ok: false,
                code: 'EXTENSION_DISABLED',
                message: `${realmKey} is not loaded again after repeated register failures`,
            };
        }
        try {
            await this.invoker.load(input);
        }
        catch (error) {
            return this.prepareFailed(input, breakerKey, error);
        }
        this.ledger.recordSuccess(breakerKey);
        this.parkPrepared(input.pluginId, realmKey);
        return { ok: true };
    }
    prepareFailed(input, breakerKey, error) {
        const where = {
            pluginId: input.pluginId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        };
        let failure;
        if (error instanceof RealmLoadError) {
            failure = error.wire;
        }
        else if (error instanceof LayerAborted) {
            failure =
                error.reason === CLOSED
                    ? { code: 'EXTENSION_HOST_CLOSED', message: 'host closed' }
                    : { code: 'EXTENSION_WORKER_CRASHED', message: 'extension worker restarted' };
        }
        else {
            throw error;
        }
        this.diagnose({ code: failure.code, message: failure.message, ...where });
        if (error instanceof RealmLoadError && this.ledger.recordFailure(breakerKey)) {
            this.diagnose({
                code: 'EXTENSION_DISABLED',
                message: `hook ${breakerKey} disabled after repeated failures`,
                ...where,
            });
        }
        return { ok: false, code: failure.code, message: failure.message };
    }
    /** A prepared realm no session runs yet replaces the plugin's earlier unused one. */
    parkPrepared(pluginId, realmKey) {
        for (const key of [...this.prepared]) {
            if (key === realmKey || !key.startsWith(`${pluginId}@`))
                continue;
            this.prepared.delete(key);
            if (!this.realmSessions.has(key))
                this.supervisor.slotHosting(key)?.unload(key);
        }
        if (!this.realmSessions.has(realmKey))
            this.prepared.add(realmKey);
    }
    activate(input) {
        const existing = this.activations.get(input.sessionId)?.get(input.pluginId);
        if (existing)
            this.deactivate(input.sessionId, input.pluginId);
        this.activationSeq += 1;
        const record = {
            input,
            realmKey: realmKeyOf(input.pluginId, input.artifact.digest),
            seq: this.activationSeq,
        };
        this.prepared.delete(record.realmKey);
        let session = this.activations.get(input.sessionId);
        if (!session) {
            session = new Map();
            this.activations.set(input.sessionId, session);
        }
        session.set(input.pluginId, record);
        let sessions = this.realmSessions.get(record.realmKey);
        if (!sessions) {
            sessions = new Set();
            this.realmSessions.set(record.realmKey, sessions);
        }
        sessions.add(input.sessionId);
        this.invalidateWhere((evaluation) => evaluation.sessionId === input.sessionId);
        this.startSession(record);
    }
    /**
     * `session.start`, once per activation: a record is created only when the plugin begins to serve
     * the session (the session's first sync, or an install, preview or reload mid-session), so a new
     * record gets its own and a replaced one never a second. Queued now, ahead of any later event of
     * the plugin; `cwd` is read from the same session facts as `ctx.session.cwd` when its turn comes.
     */
    startSession(record) {
        if (this.lifetime.signal.aborted)
            return;
        const { sessionId } = record.input;
        this.background.add(this.observers.dispatchTo(record, 'session.start', async () => ({
            cwd: (await this.services.sessionFacts(sessionId)).cwd,
        })));
    }
    deactivate(sessionId, pluginId) {
        const session = this.activations.get(sessionId);
        const record = session?.get(pluginId);
        if (!session || !record)
            return;
        session.delete(pluginId);
        if (session.size === 0)
            this.activations.delete(sessionId);
        this.invoker.retire(record);
        this.retireRealmInSession(record.realmKey, sessionId);
    }
    deleteSession(sessionId) {
        for (const pluginId of [...(this.activations.get(sessionId)?.keys() ?? [])]) {
            this.deactivate(sessionId, pluginId);
        }
        for (const [siteKey, controller] of [...this.inflight]) {
            if (siteKey.startsWith(`${sessionId}\u0000`))
                controller.abort(SUPERSEDED);
        }
        this.registry.dropSession(sessionId);
        this.gestures.dropSession(sessionId);
        this.observers.dropSession(sessionId);
        this.ledger.forgetSession(sessionId);
        for (const siteKey of [...this.pausedSites.keys()]) {
            if (siteKey.startsWith(`${sessionId}\u0000`))
                this.pausedSites.delete(siteKey);
        }
    }
    retireRealmInSession(realmKey, sessionId) {
        this.registry.expireWhere((record) => record.sessionId === sessionId && issuedUses(record, realmKey));
        this.invalidateWhere((evaluation) => evaluation.sessionId === sessionId && evaluation.realmKeys.has(realmKey));
        this.dropSubscriptions((sub) => sub.realmKey === realmKey && sub.sessionId === sessionId);
        const slot = this.supervisor.slotHosting(realmKey);
        slot?.dropSession(realmKey, sessionId);
        const sessions = this.realmSessions.get(realmKey);
        sessions?.delete(sessionId);
        if (sessions && sessions.size > 0)
            return;
        this.realmSessions.delete(realmKey);
        slot?.unload(realmKey);
    }
    liveActivation(sessionId, pluginId) {
        return this.activations.get(sessionId)?.get(pluginId);
    }
    isLive(record) {
        return this.liveActivation(record.input.sessionId, record.input.pluginId) === record;
    }
    // -------------------------------------------------------------------------------------------
    // Leases, applied, invalidate
    issueViewLease(sessionId) {
        return this.registry.issueLease(sessionId);
    }
    releaseViewLease(lease) {
        this.registry.releaseLease(lease);
    }
    applied(request) {
        this.registry.applied(siteKeyOf(request.sessionId, request.slot, request.key), request.renderSeq);
    }
    resetBreaker(sessionId, pluginId) {
        const record = this.liveActivation(sessionId, pluginId);
        this.ledger.resetSession(pluginId, sessionId, record ? [record.realmKey] : []);
        this.diagnose({
            code: 'EXTENSION_BREAKER_RESET',
            message: 'the user retried a paused plugin in this session',
            pluginId,
            sessionId,
        });
        this.services.emit({ type: 'entries-changed', pluginId, sessionId });
        this.invalidateWhere((evaluation) => evaluation.sessionId === sessionId &&
            [...evaluation.realmKeys].some((key) => key.startsWith(`${pluginId}@`)));
        return record
            ? {
                pluginId,
                source: record.input.source,
                artifactDigest: record.input.artifact.digest,
            }
            : undefined;
    }
    retrySite(site) {
        const siteKey = siteKeyOf(site.sessionId, site.slot, site.key);
        const rendered = this.pausedSites.get(siteKey);
        this.pausedSites.delete(siteKey);
        const retried = (rendered ?? []).flatMap((pluginId) => {
            const reset = this.resetBreaker(site.sessionId, pluginId);
            return reset ? [reset] : [];
        });
        if (rendered && rendered.length > 0) {
            this.services.emit({
                type: 'invalidate',
                sessionId: site.sessionId,
                slot: site.slot,
                key: site.key,
            });
        }
        return retried;
    }
    invalidateWhere(match) {
        for (const evaluation of this.registry.forget(match))
            this.emitInvalidate(evaluation);
    }
    emitInvalidate(evaluation) {
        this.services.emit({
            type: 'invalidate',
            sessionId: evaluation.sessionId,
            slot: evaluation.slot,
            key: evaluation.key,
        });
    }
    // -------------------------------------------------------------------------------------------
    // Render
    async render(request) {
        if (this.lifetime.signal.aborted)
            return errorResponse('EXTENSION_HOST_CLOSED', 'host closed');
        const site = this.sites.get(request.slot);
        if (!site) {
            return errorResponse('EXTENSION_REQUEST_INVALID', `${request.slot} is not a render site`);
        }
        const target = siteClaimOf(site, request);
        if (!target) {
            const expected = site.drawnBy === UI_RENDER_EVENT ? '<plugin>/<id>' : `"${site.slot}"`;
            return errorResponse('EXTENSION_REQUEST_INVALID', `${request.key} is not ${expected}`);
        }
        const siteKey = siteKeyOf(request.sessionId, request.slot, request.key);
        const claim = this.registry.claim(siteKey, request.sessionId, request.viewLease);
        if (claim === 'invalid')
            return errorResponse('EXTENSION_REQUEST_INVALID', 'unknown view lease');
        if (claim === 'held')
            return errorResponse('VIEW_LEASE_HELD', 'site is mounted in another view');
        const layers = this.resolveLayers(request.sessionId, site, target);
        const disabled = this.disabledSite(request, site, siteKey, { ...target, layers });
        if (disabled)
            return disabled;
        this.pausedSites.delete(siteKey);
        const composite = layers.map((layer) => layer.activation.realmKey).join(',');
        const cached = this.registry.evaluation(siteKey);
        if (cached && this.reusable(cached, request, composite))
            return cached.response;
        return this.evaluate({ request, site, siteKey, layers, composite });
    }
    /**
     * Why a site instance answers `EXTENSION_DISABLED`, if it does: every layer it has is paused, or
     * the plugin a pane belongs to is not active (the tab is its; other plugins' layers do not keep
     * it drawing).
     */
    disabledSite(request, site, siteKey, target) {
        const ownerGone = target.owner !== undefined && !this.liveActivation(request.sessionId, target.owner);
        if (target.layers.length > 0 && !ownerGone)
            return undefined;
        const paused = target.layers.length === 0 ? this.pausedLayers(request.sessionId, site, target) : [];
        if (paused.length > 0) {
            this.pausedSites.set(siteKey, paused);
            return errorResponse('EXTENSION_DISABLED', latestFailure(this.diagnostics, request.sessionId, paused));
        }
        // A pane outlives a reload of its plugin and draws again once re-activated. A withdrawal drops
        // it from the roster, so this answers only until the renderer has removed the tab.
        if (ownerGone) {
            return errorResponse('EXTENSION_DISABLED', `${target.owner} is not active in this session`);
        }
        return undefined;
    }
    reusable(cached, request, composite) {
        if (cached.propsVersion !== request.propsVersion || cached.composite !== composite)
            return false;
        return !this.depsChanged(cached.sessionId, cached.deps);
    }
    depsChanged(sessionId, deps) {
        const versions = new Map();
        return deps.some((dep) => {
            let current = versions.get(dep.pluginId);
            if (!current) {
                const activation = this.liveActivation(sessionId, dep.pluginId);
                if (!activation)
                    return true;
                current = this.services.state.snapshot(activation.input).versions;
                versions.set(dep.pluginId, current);
            }
            return current[dep.key] !== dep.version;
        });
    }
    /** The session's activations whose revision is not disabled, in chain order. */
    liveRecords(sessionId) {
        return [...(this.activations.get(sessionId)?.values() ?? [])]
            .filter((record) => !this.ledger.isRealmDisabled(record.realmKey))
            .sort((a, b) => EXTENSION_TIER_ORDER.indexOf(a.input.tier) - EXTENSION_TIER_ORDER.indexOf(b.input.tier) ||
            a.seq - b.seq);
    }
    /** The instance's live layers, in chain order. */
    resolveLayers(sessionId, site, claim) {
        const layers = [];
        for (const record of this.liveRecords(sessionId)) {
            const layer = layerOf(record, site, claim);
            if (layer && !this.ledger.isHookDisabled(layer.breakerKey))
                layers.push(layer);
        }
        return layers;
    }
    /** Plugins with a layer on this site that the breaker or a crash took out in this session. */
    pausedLayers(sessionId, site, claim) {
        const paused = [];
        for (const record of this.activations.get(sessionId)?.values() ?? []) {
            const layer = layerOf(record, site, claim);
            if (!layer)
                continue;
            if (this.ledger.isRealmDisabled(record.realmKey) ||
                this.ledger.isHookDisabled(layer.breakerKey)) {
                paused.push(record.input.pluginId);
            }
        }
        return paused;
    }
    async evaluate(job) {
        this.inflight.get(job.siteKey)?.abort(SUPERSEDED);
        const controller = new AbortController();
        this.inflight.set(job.siteKey, controller);
        const deadline = this.clock.setTimeout(() => controller.abort(DEADLINE), this.limits.renderDeadlineMs);
        try {
            for (let attempt = 0;; attempt += 1) {
                const pass = await this.renderPass(job.request, job.site, job.layers, controller.signal);
                if (pass.result.abortReason)
                    return this.aborted(job, pass);
                if (attempt < this.limits.maxDirtyReruns &&
                    this.depsChanged(job.request.sessionId, pass.deps)) {
                    this.discard(pass, job.layers);
                    continue;
                }
                return this.publish(job, pass);
            }
        }
        finally {
            this.clock.clearTimeout(deadline);
            if (this.inflight.get(job.siteKey) === controller)
                this.inflight.delete(job.siteKey);
        }
    }
    async renderPass(request, site, layers, signal) {
        const renderSeq = this.registry.nextSeq();
        const deps = [];
        const result = await dispatchRender({
            layers,
            event: {
                slot: request.slot,
                key: request.key,
                surface: request.surface ?? 'desktop',
                props: request.props,
            },
            core: siteCore(site),
            signal,
            budgetMs: this.limits.ownTimeBudgetMs,
            clock: this.clock,
            run: (input) => this.runRenderLayer(input, { renderSeq, site, deps }),
            onFailure: (layer, failure) => this.recordFailure(layer, failure, request),
            onTimedOutWaiting: (layer, failure) => this.recordFailure(layer, failure, request, false),
        });
        for (const layer of result.layers) {
            if (layer.outcome !== 'returned' && layer.outcome !== 'passthrough')
                continue;
            const resolved = layers.find((candidate) => candidate.plugin === layer.plugin);
            if (resolved)
                this.ledger.recordSuccess(resolved.breakerKey);
        }
        return { renderSeq, result, deps };
    }
    async runRenderLayer(input, pass) {
        const { layer } = input;
        const { site } = pass;
        const result = await this.invoker.invoke({
            activation: layer.activation,
            kind: 'render',
            target: { type: 'expected', hook: layer.hook },
            breakerKey: layer.breakerKey,
            writable: false,
            signal: input.signal,
            budget: input.budget,
            site: { slot: input.event.slot, key: input.event.key },
            // A `ui.render` hook sees the instance it draws: `{ site }`, or `{ site: 'pane', id }`.
            event: layer.hook.slot === UI_RENDER_EVENT
                ? uiRenderEventOf(site, input.event.key)
                : {
                    slot: input.event.slot,
                    key: input.event.key,
                    surface: input.event.surface,
                    props: input.event.props,
                },
            render: { renderSeq: pass.renderSeq, spec: site },
            onNext: (event) => input.next(event),
        });
        pass.deps.push(...result.deps);
        return { tree: result.invocation.tree ?? siteCore(site), own: result.invocation.own ?? [] };
    }
    aborted(job, pass) {
        this.discard(pass, job.layers);
        const reason = pass.result.abortReason;
        if (reason === DEADLINE) {
            this.pushTrace(job.request, job.composite, pass);
            return { kind: 'hostDefault', renderSeq: pass.renderSeq, coreProps: job.request.props };
        }
        if (reason === CRASHED)
            return errorResponse('EXTENSION_WORKER_CRASHED', 'extension worker restarted');
        if (reason === CLOSED)
            return errorResponse('EXTENSION_HOST_CLOSED', 'host closed');
        return errorResponse('EXTENSION_RENDER_SUPERSEDED', 'a newer render replaced this one');
    }
    /** Frees handles a discarded pass bound in its realms. */
    discard(pass, layers) {
        for (const layer of layers) {
            this.supervisor
                .slotHosting(layer.activation.realmKey)
                ?.release(layer.activation.realmKey, [pass.renderSeq]);
        }
    }
    publish(job, pass) {
        const { request } = job;
        const tree = pass.result.tree;
        const coreProps = this.coreProps(request, pass.result.core?.props);
        const response = isCoreOnly(tree, siteCore(job.site))
            ? { kind: 'hostDefault', renderSeq: pass.renderSeq, coreProps }
            : {
                kind: 'tree',
                renderSeq: pass.renderSeq,
                tree,
                ...(pass.result.core ? { coreProps } : {}),
            };
        const layers = new Map(job.layers.map((layer) => [
            layer.plugin,
            {
                realmKey: layer.activation.realmKey,
                pluginId: layer.plugin,
                tier: layer.tier,
                breakerKey: layer.breakerKey,
            },
        ]));
        this.registry.publish(pass.renderSeq, {
            sessionId: request.sessionId,
            slot: request.slot,
            key: request.key,
            siteKey: job.siteKey,
            handles: handleSites(tree),
            layers,
        });
        this.registry.remember({
            sessionId: request.sessionId,
            siteKey: job.siteKey,
            slot: request.slot,
            key: request.key,
            propsVersion: request.propsVersion,
            composite: job.composite,
            deps: pass.deps,
            realmKeys: new Set(job.layers.map((layer) => layer.activation.realmKey)),
            response,
        });
        this.pushTrace(request, job.composite, pass);
        return response;
    }
    pushTrace(request, composite, pass) {
        this.traces.push({
            sessionId: request.sessionId,
            renderSeq: pass.renderSeq,
            slot: request.slot,
            key: request.key,
            artifactDigest: composite,
            layers: pass.result.layers,
        });
    }
    /** `next(e')` may only rewrite site props with values of the same JSON kind (two.md §7). */
    coreProps(request, props) {
        if (!props)
            return request.props;
        const valid = Object.entries(props).every(([name, value]) => {
            const original = Object.hasOwn(request.props, name) ? request.props[name] : undefined;
            if (original === undefined)
                return false;
            return original === null || value === null || jsonKind(original) === jsonKind(value);
        });
        if (valid)
            return props;
        this.diagnose({
            code: 'EXTENSION_CORE_PROPS_INVALID',
            message: 'next(e) rewrote site props outside the site schema',
            sessionId: request.sessionId,
            slot: request.slot,
            key: request.key,
        });
        return request.props;
    }
    // -------------------------------------------------------------------------------------------
    // Gestures and menu items
    press(request) {
        return this.gesture('press', request);
    }
    input(request) {
        return this.gesture('input', request);
    }
    select(request) {
        return this.gesture('select', request);
    }
    async gesture(kind, request) {
        const target = this.gestureTarget(request);
        if (!isGestureTarget(target))
            return target;
        const layer = target.record.layers.get(request.plugin);
        const activation = this.liveActivation(request.sessionId, request.plugin);
        if (!layer || !activation || activation.realmKey !== layer.realmKey) {
            return errorResponse('ACTIVATION_RETIRED', 'the plugin revision that drew this was retired');
        }
        if (this.ledger.isRealmDisabled(layer.realmKey) ||
            this.ledger.isHookDisabled(layer.breakerKey)) {
            return errorResponse('EXTENSION_DISABLED', 'the plugin hook is disabled');
        }
        return this.gestures.enqueue(request.sessionId, request.plugin, () => this.runGesture(kind, request, activation, layer.breakerKey));
    }
    /**
     * The bound handle a gesture reaches. Its own while that render's handles are bound; once a newer
     * render replaced it, the handle of the same keyed control in the site's current render: the
     * same element type, callback prop and key chain (`HandleSite.control`), found exactly once and
     * drawn by the same plugin revision. A control without a key of its own or on an ancestor is
     * never matched, nor one the current render no longer has: both answer stale. A handle the named
     * render never issued is refused either way.
     */
    gestureTarget(request) {
        const found = this.registry.lookup(request.renderSeq);
        if (!found)
            return { stale: true };
        const invalid = this.gestureTargetError(found.record, request);
        if (invalid)
            return invalid;
        if (found.bound) {
            return { renderSeq: request.renderSeq, handle: request.handle, record: found.record };
        }
        return (this.registry.sameControl(found.record, request.plugin, request.handle) ?? { stale: true });
    }
    gestureTargetError(record, request) {
        if (record.sessionId !== request.sessionId ||
            record.slot !== request.slot ||
            record.key !== request.key) {
            return errorResponse('EXTENSION_REQUEST_INVALID', 'renderSeq does not belong to this site');
        }
        if (!record.handles.has(handleKey(request.plugin, request.handle))) {
            return errorResponse('EXTENSION_REQUEST_INVALID', 'handle was not issued by this render');
        }
        return undefined;
    }
    /**
     * Finds the target again when its turn comes: a render may have replaced the drawing while the
     * gesture waited. A handle the realm let go between the check and the call is looked up once
     * more; nothing ran for it.
     */
    async runGesture(kind, request, activation, breakerKey) {
        let tried;
        for (;;) {
            const target = this.gestureTarget(request);
            if (!isGestureTarget(target) || !this.drawnBy(target, activation))
                return { stale: true };
            if (tried?.renderSeq === target.renderSeq && tried.handle === target.handle) {
                return { stale: true };
            }
            const response = await this.runAction({
                activation,
                kind,
                breakerKey,
                target: { type: 'handle', renderSeq: target.renderSeq, handle: target.handle },
                site: { slot: request.slot, key: request.key },
                args: request.value === undefined ? [] : [request.value],
            });
            if (!('stale' in response) || tried)
                return response;
            tried = target;
        }
    }
    /** Queued behind a swap, the handle belonged to the retired revision, never to the new one. */
    drawnBy(target, activation) {
        const layer = target.record.layers.get(activation.input.pluginId);
        return this.isLive(activation) && layer?.realmKey === activation.realmKey;
    }
    /** Non-UI family: no fallback, failures count and go back to the caller. */
    async runAction(job) {
        if (!this.isLive(job.activation)) {
            return errorResponse('ACTIVATION_RETIRED', 'the plugin revision was replaced before this ran');
        }
        const layer = {
            plugin: job.activation.input.pluginId,
            tier: job.activation.input.tier,
            breakerKey: job.breakerKey,
        };
        try {
            const failure = await dispatchGesture({
                layer,
                signal: this.lifetime.signal,
                budgetMs: this.limits.ownTimeBudgetMs,
                clock: this.clock,
                run: async ({ signal, budget }) => {
                    await this.invoker.invoke({ ...job, writable: true, signal, budget });
                },
                onFailure: (failed, info) => {
                    if (info.code !== HANDLE_STALE)
                        this.recordFailure(failed, info, job.activation.input);
                },
            });
            if (!failure) {
                this.ledger.recordSuccess(job.breakerKey);
                return { ok: true };
            }
            if (failure.code === HANDLE_STALE)
                return { stale: true };
            return errorResponse(gestureCode(failure), failure.message);
        }
        catch (error) {
            const reason = error instanceof LayerAborted ? error.reason : CRASHED;
            if (reason === CLOSED)
                return errorResponse('EXTENSION_HOST_CLOSED', 'host closed');
            return errorResponse('EXTENSION_WORKER_CRASHED', 'extension worker restarted');
        }
    }
    /**
     * Observe events (two.md §1.2): queued per (session, plugin) before this returns; the turn
     * never awaits them. The promise only lets a self-pacing caller (`session.measure`) wait.
     */
    observe(request) {
        if (this.lifetime.signal.aborted)
            return Promise.resolve();
        return this.observers.dispatch(request);
    }
    // -------------------------------------------------------------------------------------------
    // Callbacks: clock timers and store listeners
    /** Under the calling Invocation as it is; each change runs in an Invocation of its own. */
    subscribe(invocation, callbackId) {
        const { activation, breakerKey, slot, identity } = invocation;
        const key = `${slot.key}#${slot.generation}:${callbackId}`;
        const unsubscribe = this.services.subscribeStore(identity, (change) => {
            this.background.add(this.runCallback({
                slotKey: slot.key,
                realmKey: activation.realmKey,
                sessionId: activation.input.sessionId,
                callbackId,
                breakerKey,
                kind: 'store-change',
                args: [{ key: change.key, value: change.value ?? null }],
            }));
        });
        this.subscriptions.set(key, {
            realmKey: activation.realmKey,
            sessionId: activation.input.sessionId,
            unsubscribe,
        });
    }
    dropSubscriptions(match) {
        for (const [key, subscription] of [...this.subscriptions]) {
            if (!match(subscription))
                continue;
            this.subscriptions.delete(key);
            subscription.unsubscribe();
        }
    }
    onOrphanNotify(slot, method, args) {
        if (method !== 'store.unsubscribe' || typeof args[0] !== 'number')
            return;
        const key = `${slot.key}#${slot.generation}:${args[0]}`;
        const subscription = this.subscriptions.get(key);
        if (subscription)
            this.dropSubscriptions((candidate) => candidate === subscription);
    }
    onFire(slotKey, message) {
        this.background.add(this.runCallback({ ...message, slotKey, kind: 'clock' }));
    }
    async runCallback(job) {
        const pluginId = job.realmKey.slice(0, job.realmKey.lastIndexOf('@'));
        const activation = this.liveActivation(job.sessionId, pluginId);
        if (!activation ||
            activation.realmKey !== job.realmKey ||
            this.ledger.isRealmDisabled(job.realmKey)) {
            this.diagnose({
                code: 'ACTIVATION_RETIRED',
                message: `${job.kind} callback of a retired activation`,
                pluginId,
                sessionId: job.sessionId,
            });
            this.supervisor.slotHosting(job.realmKey)?.dropSession(job.realmKey, job.sessionId);
            return;
        }
        if (this.ledger.isHookDisabled(job.breakerKey))
            return;
        await this.runAction({
            activation,
            kind: job.kind,
            breakerKey: job.breakerKey,
            target: { type: 'callback', id: job.callbackId },
            args: job.args,
        });
    }
    // -------------------------------------------------------------------------------------------
    // Failures, crashes, console
    recordFailure(layer, failure, where, 
    /** False: reported only, not counted toward the breaker. */
    counted = true) {
        const disabled = counted && this.ledger.recordFailure(layer.breakerKey);
        this.diagnose({
            code: failure.code,
            message: failure.message,
            pluginId: layer.plugin,
            ...(where.sessionId ? { sessionId: where.sessionId } : {}),
            ...(where.slot ? { slot: where.slot } : {}),
            ...(where.key ? { key: where.key } : {}),
        });
        if (!disabled)
            return;
        this.diagnose({
            code: 'EXTENSION_DISABLED',
            message: `hook ${layer.breakerKey} disabled after repeated failures`,
            pluginId: layer.plugin,
            ...(where.sessionId ? { sessionId: where.sessionId } : {}),
        });
        this.services.emit({
            type: 'entries-changed',
            pluginId: layer.plugin,
            ...(where.sessionId ? { sessionId: where.sessionId } : {}),
        });
    }
    onWorkerDeath(death) {
        const verdict = this.ledger.applyCrash(death.attribution);
        this.diagnose({
            code: 'EXTENSION_WORKER_CRASHED',
            message: `${death.slotKey} ${death.cause}: ${JSON.stringify(death.attribution)}`,
        });
        this.log.warn({ slot: death.slotKey, cause: death.cause, attribution: death.attribution }, 'extension worker died');
        for (const realmKey of verdict.disabled) {
            this.services.emit({
                type: 'entries-changed',
                pluginId: realmKey.slice(0, realmKey.lastIndexOf('@')),
            });
        }
        if (verdict.switchIsolation && this.supervisor.mode === 'shared') {
            this.supervisor.switchMode('per-plugin');
            this.log.info({ mode: 'per-plugin' }, 'extension isolation switched after repeated unattributed crashes');
        }
        const lost = new Set(death.realmKeys);
        this.dropSubscriptions((subscription) => lost.has(subscription.realmKey));
        this.registry.expireWhere((record) => [...record.layers.values()].some((layer) => lost.has(layer.realmKey)));
        this.invalidateWhere((evaluation) => [...evaluation.realmKeys].some((key) => lost.has(key)));
    }
    onConsole(realmKey, level, text) {
        const pluginId = realmKey ? realmKey.slice(0, realmKey.lastIndexOf('@')) : undefined;
        const verdict = this.consoleQuota.take(pluginId ?? '');
        if (verdict !== 'allowed') {
            if (verdict === 'first-drop') {
                this.diagnose({
                    code: 'console.dropped',
                    message: 'console quota exceeded; dropping until the window rolls',
                    ...(pluginId ? { pluginId } : {}),
                });
            }
            return;
        }
        this.diagnose({ code: `console.${level}`, message: text, ...(pluginId ? { pluginId } : {}) });
    }
    diagnose(entry) {
        this.diagnostics.push({ at: this.clock.now(), ...entry });
    }
    releaseHandles(record, renderSeq) {
        for (const layer of record.layers.values()) {
            this.supervisor.slotHosting(layer.realmKey)?.release(layer.realmKey, [renderSeq]);
        }
    }
    // -------------------------------------------------------------------------------------------
    // Inspect and close
    inspect(filter = {}) {
        const ownsRealm = (key) => filter.pluginId === undefined || key.startsWith(`${filter.pluginId}@`);
        const health = this.ledger.snapshot();
        return {
            isolation: this.supervisor.mode,
            traces: this.traces.list((trace) => (filter.sessionId === undefined || trace.sessionId === filter.sessionId) &&
                (filter.pluginId === undefined ||
                    trace.layers.some((layer) => layer.plugin === filter.pluginId))),
            diagnostics: this.diagnostics.list((entry) => (filter.sessionId === undefined ||
                entry.sessionId === undefined ||
                entry.sessionId === filter.sessionId) &&
                (filter.pluginId === undefined || entry.pluginId === filter.pluginId)),
            disabledHooks: disabledHooksOf(health.disabledHooks, filter),
            disabledPlugins: health.disabledRealms.filter(ownsRealm),
        };
    }
    async close() {
        this.lifetime.abort(CLOSED);
        for (const controller of this.inflight.values())
            controller.abort(CLOSED);
        this.inflight.clear();
        this.dropSubscriptions(() => true);
        this.registry.close();
        await this.supervisor.close();
    }
}
function isGestureTarget(value) {
    return 'record' in value;
}
function issuedUses(record, realmKey) {
    return [...record.layers.values()].some((layer) => layer.realmKey === realmKey);
}
function jsonKind(value) {
    return Array.isArray(value) ? 'array' : typeof value;
}
//# sourceMappingURL=host.js.map