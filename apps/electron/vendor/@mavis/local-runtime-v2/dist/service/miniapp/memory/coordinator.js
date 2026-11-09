import { MiniAppError, isMiniAppStopTargetReplaced, miniAppBusyReason } from '../errors.js';
import { classifyMiniAppMemoryPressure, createPlatformMiniAppPressureSampler, debounceMiniAppMemoryPressure, INITIAL_MINIAPP_PRESSURE_STATE, } from './pressure.js';
import { admissionEvictionCandidates, classifyMiniAppTiers, miniAppLastAttendedAt, pageKey, pressureReclaimCandidates, } from './tiers.js';
const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
/** Under moderate pressure two reclaims are at least this far apart. */
const MODERATE_RECLAIM_SPACING_MS = 10_000;
/** A unit that refused or failed to sleep is left alone this long, or until it is attended. */
const FAILED_UNIT_SKIP_MS = 5 * 60_000;
/** Phases in which a backend runs or is coming up; the others hold no live service. */
const RUNNING_PHASES = new Set(['active', 'preparing']);
/** Released turns remembered so a hold that arrives after the turn settled is ignored. */
const RELEASED_TURN_MEMORY = 256;
const NO_OP_ADMISSION = Object.freeze({ release: () => undefined });
export function createMiniAppMemoryCoordinator(options) {
    return new DefaultMiniAppMemoryCoordinator(options);
}
class DefaultMiniAppMemoryCoordinator {
    options;
    nowMs;
    samplePressure;
    scheduleInterval;
    sampleIntervalMs;
    logger;
    /** Recorded attention events Main cannot see (open, @ mention, main-Agent MCP call). */
    attendedAtMs = new Map();
    turnHolds = new Map();
    /** Insertion-ordered; the oldest key is forgotten past `RELEASED_TURN_MEMORY`. */
    releasedTurns = new Set();
    /** Admitted starts that have not settled; they occupy a slot like a running root. */
    reservations = new Map();
    /**
     * When each running backend started (admission settled) or was first seen running, with the
     * process generation it belongs to: a replacement root (update, restart) earns its own grace.
     */
    startedAtMs = new Map();
    startedGeneration = new Map();
    lastSleep = new Map();
    /** Plugins with a slept unit the user has not come back to yet, by sleep time. */
    sleptAtMs = new Map();
    skipped = new Map();
    /** Whole-App stops in flight; a hold for the plugin cancels its stop before it commits. */
    pendingStops = new Map();
    closeController = new AbortController();
    tabs = [];
    pressureState = INITIAL_MINIAPP_PRESSURE_STATE;
    /** The last raw kernel level (macOS); absent when the last reading was not a sysctl level. */
    rawPressureLevel;
    lastModerateReclaimAtMs;
    idleReclaimLogged = false;
    /** Admissions and reclaims run one at a time, in arrival order. */
    serial = Promise.resolve();
    loop;
    sampling = false;
    closed = false;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
        this.logger = options.logger;
        this.samplePressure =
            options.samplePressure ??
                createPlatformMiniAppPressureSampler(options.logger ? { logger: options.logger } : {});
        this.scheduleInterval = options.scheduleInterval ?? defaultScheduleInterval;
        this.sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    }
    admit(input) {
        return this.enqueue(() => this.admitNow(input));
    }
    recordAttention(pluginId) {
        if (this.closed)
            return;
        this.attendedAtMs.set(pluginId, this.nowMs());
        this.ensureLoop();
    }
    holdForTurn(input) {
        if (input.pluginIds.length === 0)
            return;
        const holds = this.holdsFor(input);
        if (!holds)
            return;
        for (const pluginId of input.pluginIds) {
            holds.mentions.add(pluginId);
            this.cancelPendingStop(pluginId);
        }
        this.ensureLoop();
    }
    holdForToolCall(input) {
        const holds = this.holdsFor(input);
        if (!holds)
            return;
        holds.toolCalls.add(input.pluginId);
        this.cancelPendingStop(input.pluginId);
        this.ensureLoop();
    }
    releaseToolCallHold(input) {
        const key = turnKey(input);
        const holds = this.turnHolds.get(key);
        if (!holds)
            return;
        holds.toolCalls.delete(input.pluginId);
        if (holds.mentions.size === 0 && holds.toolCalls.size === 0)
            this.turnHolds.delete(key);
    }
    releaseTurn(input) {
        const key = turnKey(input);
        this.turnHolds.delete(key);
        this.releasedTurns.delete(key);
        this.releasedTurns.add(key);
        if (this.releasedTurns.size > RELEASED_TURN_MEMORY) {
            const oldest = this.releasedTurns.values().next();
            if (!oldest.done)
                this.releasedTurns.delete(oldest.value);
        }
    }
    reportSurfaces(snapshot) {
        if (this.closed)
            return;
        this.tabs = snapshot.tabs;
        for (const tab of snapshot.tabs) {
            if (tab.state === 'visible')
                this.noteRestored(tab.pluginId);
        }
        this.ensureLoop();
    }
    view() {
        const observation = this.observe();
        // Backends can also start outside admission (restart, publish); a list or inspect notices them.
        this.ensureLoop(observation);
        const tiers = this.classify(observation);
        const tiered = new Set(tiers.map((tier) => tier.pluginId));
        const entries = tiers.map((tier) => this.entryFor(tier));
        for (const pluginId of this.lastSleep.keys()) {
            if (tiered.has(pluginId))
                continue;
            const lastAttendedAtMs = miniAppLastAttendedAt(pluginId, {
                nowMs: this.nowMs(),
                recordedAttentionMs: (id) => this.attendedAtMs.get(id),
                tabs: this.tabs,
            });
            entries.push(this.entryFor({
                pluginId,
                tier: 'normal',
                ...(lastAttendedAtMs !== undefined ? { lastAttendedAtMs } : {}),
            }));
        }
        return {
            capacity: { limit: observation.limit, occupied: observation.occupied.size },
            pressure: this.pressureState.level,
            entries,
        };
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.stopLoop();
        this.closeController.abort();
    }
    // ---- admission ----
    async admitNow(input) {
        input.signal?.throwIfAborted();
        if (this.closed)
            return NO_OP_ADMISSION;
        let observation = this.observe();
        if (observation.occupied.has(input.pluginId))
            return NO_OP_ADMISSION;
        if (input.initiator === 'user' && !fits(observation)) {
            observation = await this.evictForUser(input, observation);
        }
        if (this.closed)
            return NO_OP_ADMISSION;
        if (!fits(observation))
            this.denyAdmission(input, observation);
        return this.reserve(input.pluginId);
    }
    /** Sleeps `normal`-tier Mini Apps, least recently attended first, until the new one fits. */
    async evictForUser(input, initial) {
        const close = this.closeController.signal;
        const signal = input.signal ? AbortSignal.any([input.signal, close]) : close;
        const tried = new Set();
        let observation = initial;
        while (!fits(observation) && !this.closed) {
            const candidate = admissionEvictionCandidates(this.classify(observation)).find((tier) => !tried.has(tier.pluginId) && tier.pluginId !== input.pluginId);
            if (!candidate)
                break;
            tried.add(candidate.pluginId);
            await this.sleepApp(candidate, { reason: 'count-cap', observation, signal });
            input.signal?.throwIfAborted();
            observation = this.observe();
        }
        return observation;
    }
    /** Same answer the Node runtime's own cap gives, before anything spawns. */
    denyAdmission(input, observation) {
        this.logger?.info?.({
            event: 'miniapp.admission_denied',
            pluginId: input.pluginId,
            initiator: input.initiator,
            occupied: observation.occupied.size,
            limit: observation.limit,
        }, 'Mini App admission found no slot to free');
        this.recordEvent(input.pluginId, 'memory.admission_denied');
        throw new MiniAppError('BUSY', `At most ${observation.limit} distinct MiniApp plugin services may run concurrently`, { busyReason: 'capacity_busy' });
    }
    reserve(pluginId) {
        const identity = Symbol(pluginId);
        this.reservations.set(identity, pluginId);
        this.ensureLoop();
        return {
            release: () => {
                if (!this.reservations.delete(identity))
                    return;
                const observation = this.observe();
                // A failed start only gives the slot back; it neither restores nor earns a start grace.
                if (observation.running.includes(pluginId)) {
                    this.startedAtMs.set(pluginId, this.nowMs());
                    this.startedGeneration.set(pluginId, observation.generations.get(pluginId));
                    this.noteRestored(pluginId);
                }
                this.ensureLoop(observation);
            },
        };
    }
    // ---- pressure loop ----
    ensureLoop(observation) {
        if (this.closed || this.loop || !this.hasWork(observation ?? this.observe()))
            return;
        this.loop = this.scheduleInterval(() => void this.tick(), this.sampleIntervalMs);
    }
    stopLoop() {
        this.loop?.cancel();
        this.loop = undefined;
    }
    hasWork(observation) {
        return (observation.running.length > 0 ||
            this.reservations.size > 0 ||
            this.tabs.some((tab) => tab.state !== 'sleeping'));
    }
    async tick() {
        if (this.sampling || this.closed)
            return;
        this.sampling = true;
        try {
            if (!this.hasWork(this.observe())) {
                this.stopLoop();
                return;
            }
            const sample = await this.readPressure();
            if (this.closed)
                return;
            this.applySample(sample);
            await this.enqueue(() => this.reclaimOnce());
        }
        catch (error) {
            this.logger?.error({ event: 'miniapp.memory_reclaim_failed', errorName: errorName(error) }, 'Mini App memory pressure step failed');
        }
        finally {
            this.sampling = false;
        }
    }
    async readPressure() {
        try {
            return await this.samplePressure();
        }
        catch {
            return { source: 'unavailable' };
        }
    }
    /** Logs a change of the debounced level or of the raw kernel level (WARN is recorded, not acted on). */
    applySample(sample) {
        const previous = this.pressureState.level;
        const previousRawLevel = this.rawPressureLevel;
        const rawLevel = sample.source === 'sysctl' ? sample.level : undefined;
        this.rawPressureLevel = rawLevel;
        // No signal means no reclaim this tick: an unavailable reading drops straight to normal
        // instead of letting the two-sample debounce carry a stale critical for one more reclaim.
        this.pressureState =
            sample.source === 'unavailable'
                ? INITIAL_MINIAPP_PRESSURE_STATE
                : debounceMiniAppMemoryPressure(this.pressureState, classifyMiniAppMemoryPressure(sample));
        const next = this.pressureState.level;
        if (next === previous && rawLevel === previousRawLevel)
            return;
        if (next !== previous)
            this.idleReclaimLogged = false;
        this.logger?.info?.({
            event: 'miniapp.memory_pressure_changed',
            previous,
            next,
            source: sample.source === 'available-bytes' ? 'bytes' : sample.source,
            ...(rawLevel !== undefined ? { rawLevel } : {}),
            ...(previousRawLevel !== undefined ? { previousRawLevel } : {}),
        }, 'Mini App memory pressure changed');
    }
    /** At most one unit per sample; the next decision waits for a fresh sample. */
    async reclaimOnce() {
        const pressure = this.pressureState.level;
        if (this.closed || pressure === 'normal' || this.moderateSpacingPending(pressure))
            return;
        const observation = this.observe();
        const unit = this.nextReclaimUnit(pressure, observation);
        if (!unit)
            return;
        const reason = pressure === 'moderate' ? 'pressure-moderate' : 'pressure-critical';
        const slept = unit.unit === 'page'
            ? await this.sleepPage(unit.page, { reason, observation, pressure })
            : await this.sleepApp(unit.app, {
                reason,
                observation,
                signal: this.closeController.signal,
            });
        if (!slept)
            return;
        this.idleReclaimLogged = false;
        if (pressure === 'moderate')
            this.lastModerateReclaimAtMs = this.nowMs();
    }
    moderateSpacingPending(pressure) {
        return (pressure === 'moderate' &&
            this.lastModerateReclaimAtMs !== undefined &&
            this.nowMs() - this.lastModerateReclaimAtMs < MODERATE_RECLAIM_SPACING_MS);
    }
    /** First unit not skipped; with none left, says so once per pressure episode. */
    nextReclaimUnit(pressure, observation) {
        const unit = pressureReclaimCandidates({
            pressure,
            nowMs: this.nowMs(),
            tabs: this.options.surface ? this.tabs : [],
            tiers: this.classify(observation),
        }).find((candidate) => !this.isSkipped(candidate));
        if (!unit && !this.idleReclaimLogged) {
            this.idleReclaimLogged = true;
            this.logger?.info?.({ event: 'miniapp.memory_reclaim_idle', pressure }, 'Mini App memory pressure found nothing to reclaim');
        }
        return unit;
    }
    // ---- sleeping ----
    async sleepPage(page, input) {
        const surface = this.options.surface;
        if (!surface)
            return false;
        const slept = await this.requestSurfaceSleep(surface, { unit: 'page', page }, { pluginId: page.pluginId, sessionId: page.sessionId, reason: input.reason, notify: false }, false);
        if (!slept)
            return false;
        this.tabs = this.tabs.map((tab) => tab.state === 'hidden' && pageKey(tab) === pageKey(page)
            ? { ...tab, state: 'sleeping' }
            : tab);
        this.recordSleep(page.pluginId, 'page', input.reason, {
            tier: this.classify(input.observation).find((tier) => tier.pluginId === page.pluginId)?.tier,
            pressure: input.pressure,
            observation: input.observation,
        });
        return true;
    }
    /**
     * Sleeps every page first (a refusal leaves the backend running), then re-checks the tier and
     * stops the backend. Only a count-cap sleep whose stop succeeded tells the user.
     */
    async sleepApp(app, input) {
        if (!(await this.sleepAppPages(app, input.reason)))
            return false;
        // The pages slept; the app may have been attended or held meanwhile. It stays up, not skipped.
        if (!this.stillSleepable(app.pluginId, input.reason))
            return false;
        const expectedProcessGeneration = input.observation.generations.get(app.pluginId);
        // The stop may wait at the publication gate; a hold that arrives meanwhile cancels it there.
        const pending = new AbortController();
        this.pendingStops.set(app.pluginId, pending);
        try {
            await this.options.stopMiniApp({
                pluginId: app.pluginId,
                signal: AbortSignal.any([input.signal, pending.signal]),
                ...(expectedProcessGeneration !== undefined ? { expectedProcessGeneration } : {}),
            });
        }
        catch (error) {
            if (pending.signal.aborted)
                this.noteStopCancelled(app);
            else if (!input.signal.aborted)
                this.noteStopFailure(app, error);
            return false;
        }
        finally {
            if (this.pendingStops.get(app.pluginId) === pending)
                this.pendingStops.delete(app.pluginId);
        }
        this.startedAtMs.delete(app.pluginId);
        this.startedGeneration.delete(app.pluginId);
        this.recordSleep(app.pluginId, 'app', input.reason, {
            tier: app.tier,
            pressure: this.pressureState.level,
            observation: input.observation,
        });
        if (input.reason === 'count-cap')
            await this.notifyAppSlept(app.pluginId, input.reason);
        return true;
    }
    /** A replaced root is not skipped: the new one is protected by its own start grace. */
    noteStopFailure(app, error) {
        if (isMiniAppStopTargetReplaced(error)) {
            this.logger?.info?.({ event: 'miniapp.memory_sleep_skipped', pluginId: app.pluginId, reason: 'replaced' }, 'Mini App sleep was skipped');
            return;
        }
        const busy = miniAppBusyReason(error) === 'operation_busy';
        this.skip({ unit: 'app', app }, busy ? 'stop-busy' : 'stop-failed', error);
    }
    /** A turn took the App while its stop queued: it stays up, not skipped, until the turn settles. */
    noteStopCancelled(app) {
        this.logger?.info?.({ event: 'miniapp.memory_sleep_skipped', pluginId: app.pluginId, reason: 'in_use' }, 'Mini App sleep was skipped');
    }
    /** Aborts the queued stop of `pluginId`, if any, before the plugin service commits it. */
    cancelPendingStop(pluginId) {
        this.pendingStops
            .get(pluginId)
            ?.abort(new MiniAppError('BUSY', 'Mini App is held by a turn', { busyReason: 'operation_busy' }));
    }
    /** True when every page of the plugin slept (or there is no desktop surface to ask). */
    async sleepAppPages(app, reason) {
        const surface = this.options.surface;
        if (!surface)
            return true;
        const slept = await this.requestSurfaceSleep(surface, { unit: 'app', app }, { pluginId: app.pluginId, reason, notify: false }, true);
        if (!slept)
            return false;
        // A snapshot that arrived meanwhile may show a tab visible again; that newer state stands.
        this.tabs = this.tabs.map((tab) => tab.pluginId === app.pluginId && tab.state === 'hidden' ? { ...tab, state: 'sleeping' } : tab);
        return true;
    }
    /** A refusal or a failed request skips `unit`; `not_found` counts as slept only when asked. */
    async requestSurfaceSleep(surface, unit, request, notFoundCountsAsSlept) {
        try {
            const result = await surface.sleep(request);
            if (result.slept || (notFoundCountsAsSlept && result.refusal === 'not_found'))
                return true;
            this.skip(unit, result.refusal);
        }
        catch (error) {
            this.skip(unit, 'rejected', error);
        }
        return false;
    }
    /** Count cap: still `normal`. Pressure: still not foreground. */
    stillSleepable(pluginId, reason) {
        const tier = this.classify(this.observe()).find((entry) => entry.pluginId === pluginId)?.tier;
        if (reason === 'count-cap')
            return tier === 'normal';
        return tier !== undefined && tier !== 'foreground';
    }
    /** Asks Main to tell the user; the backend has already stopped, so the answer changes nothing. */
    async notifyAppSlept(pluginId, reason) {
        try {
            await this.options.surface?.sleep({ pluginId, reason, notify: true });
        }
        catch (error) {
            // The stop stands; a lost notice only means no toast.
            this.logger?.warn({
                event: 'miniapp.memory_sleep_notice_failed',
                pluginId,
                reason,
                errorName: errorName(error),
            }, 'Mini App sleep notice could not be delivered');
        }
    }
    recordSleep(pluginId, unit, reason, context) {
        const atMs = this.nowMs();
        this.lastSleep.set(pluginId, { atMs, reason, unit });
        if (!this.sleptAtMs.has(pluginId))
            this.sleptAtMs.set(pluginId, atMs);
        this.logger?.info?.({
            event: 'miniapp.memory_sleep',
            pluginId,
            unit,
            reason,
            ...(context.tier ? { tier: context.tier } : {}),
            pressure: context.pressure,
            occupied: context.observation.occupied.size,
            limit: context.observation.limit,
        }, 'Mini App put to sleep to free memory');
        this.recordEvent(pluginId, unit === 'page' ? 'memory.page_slept' : 'memory.app_slept');
    }
    noteRestored(pluginId) {
        const sleptAtMs = this.sleptAtMs.get(pluginId);
        if (sleptAtMs === undefined)
            return;
        this.sleptAtMs.delete(pluginId);
        this.logger?.info?.({ event: 'miniapp.memory_restored', pluginId, sleptForMs: this.nowMs() - sleptAtMs }, 'Mini App restored after sleep');
        this.recordEvent(pluginId, 'memory.restored');
    }
    /** Leaves `unit` alone for five minutes, or until its attention time moves. */
    skip(unit, reason, error) {
        const { key, attentionMs, pluginId } = unitIdentity(unit);
        this.skipped.set(key, { untilMs: this.nowMs() + FAILED_UNIT_SKIP_MS, attentionMs });
        this.logger?.info?.({
            event: 'miniapp.memory_sleep_skipped',
            pluginId,
            reason,
            ...(error === undefined ? {} : errorFields(error)),
        }, 'Mini App sleep was skipped');
        this.recordEvent(pluginId, 'memory.sleep_skipped');
    }
    recordEvent(pluginId, code) {
        this.options.supervisor.recordMemoryEvent?.(pluginId, code);
    }
    /** Skipped for five minutes, or until the unit's attention time moves. */
    isSkipped(unit) {
        const { key, attentionMs } = unitIdentity(unit);
        const skipped = this.skipped.get(key);
        if (!skipped)
            return false;
        if (this.nowMs() < skipped.untilMs && skipped.attentionMs === attentionMs)
            return true;
        this.skipped.delete(key);
        return false;
    }
    // ---- state ----
    observe() {
        const capacity = this.options.supervisor.capacity();
        const statuses = this.options.supervisor.inspect();
        const phases = new Map(statuses.map((status) => [status.pluginId, status.phase]));
        const generations = new Map(statuses.map((status) => [status.pluginId, status.active?.processGeneration]));
        const running = new Set(capacity.occupiedPluginIds);
        for (const status of statuses) {
            if (RUNNING_PHASES.has(status.phase))
                running.add(status.pluginId);
        }
        const reserved = new Set(this.reservations.values());
        this.trackStarts(running, reserved, generations);
        return {
            limit: capacity.limit,
            occupied: new Set([...capacity.occupiedPluginIds, ...reserved]),
            running: [...running],
            phases,
            generations,
        };
    }
    /**
     * Keeps one start time per running root: first sight, or a new process generation under the
     * same plugin id (an update or restart replaced the root), starts the grace again.
     */
    trackStarts(running, reserved, generations) {
        for (const pluginId of this.startedAtMs.keys()) {
            if (running.has(pluginId) || reserved.has(pluginId))
                continue;
            this.startedAtMs.delete(pluginId);
            this.startedGeneration.delete(pluginId);
        }
        const nowMs = this.nowMs();
        for (const pluginId of running) {
            const generation = generations.get(pluginId);
            const known = this.startedGeneration.get(pluginId);
            if (!this.startedAtMs.has(pluginId) ||
                (generation !== undefined && known !== undefined && known !== generation)) {
                this.startedAtMs.set(pluginId, nowMs);
            }
            if (generation !== undefined)
                this.startedGeneration.set(pluginId, generation);
        }
    }
    classify(observation) {
        const reserved = new Set(this.reservations.values());
        const held = new Set();
        for (const holds of this.turnHolds.values()) {
            for (const pluginId of holds.mentions)
                held.add(pluginId);
            for (const pluginId of holds.toolCalls)
                held.add(pluginId);
        }
        return classifyMiniAppTiers({
            nowMs: this.nowMs(),
            runningPluginIds: observation.running,
            phaseOf: (pluginId) => observation.phases.get(pluginId),
            isStarting: (pluginId) => reserved.has(pluginId),
            startedAtMs: (pluginId) => this.startedAtMs.get(pluginId),
            heldForTurn: (pluginId) => held.has(pluginId),
            recordedAttentionMs: (pluginId) => this.attendedAtMs.get(pluginId),
            tabs: this.tabs,
            activity: (pluginId) => this.options.activity.read(pluginId),
        });
    }
    entryFor(tier) {
        const { lastAttendedAtMs } = tier;
        const lastSleep = this.lastSleep.get(tier.pluginId);
        return {
            pluginId: tier.pluginId,
            ...(lastAttendedAtMs !== undefined ? { lastAttendedAtMs } : {}),
            ...(tier.protection ? { protection: tier.protection } : {}),
            ...(lastSleep ? { lastSleep } : {}),
        };
    }
    /** The turn's holds, created on first use; none once the coordinator closed or the turn settled. */
    holdsFor(input) {
        const key = turnKey(input);
        if (this.closed || this.releasedTurns.has(key))
            return undefined;
        let holds = this.turnHolds.get(key);
        if (!holds) {
            holds = { mentions: new Set(), toolCalls: new Set() };
            this.turnHolds.set(key, holds);
        }
        return holds;
    }
    enqueue(step) {
        const previous = this.serial;
        const run = (async () => {
            await previous;
            return step();
        })();
        this.serial = settled(run);
        return run;
    }
}
/** Never rejects: the step's own caller observes its failure. */
async function settled(promise) {
    try {
        await promise;
    }
    catch {
        // Observed by the caller of `enqueue`.
    }
}
function fits(observation) {
    return observation.occupied.size + 1 <= observation.limit;
}
function turnKey(input) {
    return `${input.sessionId}\u0000${input.turnId}`;
}
/** Skip-map key, the attention time that clears a skip when it moves, and the owning plugin. */
function unitIdentity(unit) {
    return unit.unit === 'page'
        ? {
            key: `page\u0000${pageKey(unit.page)}`,
            attentionMs: unit.page.hiddenAtMs,
            pluginId: unit.page.pluginId,
        }
        : {
            key: `app\u0000${unit.app.pluginId}`,
            attentionMs: unit.app.lastAttendedAtMs,
            pluginId: unit.app.pluginId,
        };
}
function errorName(error) {
    return error instanceof Error ? error.name : typeof error;
}
/** Bounded, Host-owned fields only: never the error message. */
function errorFields(error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    const busyReason = miniAppBusyReason(error);
    return {
        errorName: errorName(error),
        ...(typeof code === 'string' ? { code } : {}),
        ...(busyReason ? { busyReason } : {}),
    };
}
function defaultScheduleInterval(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    timer.unref?.();
    return { cancel: () => clearInterval(timer) };
}
//# sourceMappingURL=coordinator.js.map