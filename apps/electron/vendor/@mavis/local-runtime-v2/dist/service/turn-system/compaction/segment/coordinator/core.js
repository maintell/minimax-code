import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent/compaction';
import { resolveSegmentCompactionBudget, } from '@mavis/context-manager';
import { resolveCheckpointSharedPrefix, checkpointMaxOutputTokens, createLocalContextFootprintMeasurer, } from '@mavis/harness/compaction';
import { createTokenCounter, } from '../rebuild-pipeline.js';
import { currentTurnStart } from '../segment-checks.js';
import { resolveSegmentContextSwitch, traceSegmentContextConfig, } from '../trace.js';
/**
 * After 1, 2 and 3 or more consecutive failures in one segment, the next
 * background compaction waits this long. A Turn over the input limit still
 * starts one at once.
 */
const BACKGROUND_RETRY_DELAYS_MS = [60_000, 300_000, 900_000];
/**
 * What every part of the coordinator shares: each Session's process-memory state, the last main
 * request's prefix, and how a route's budget and a history's footprint are measured.
 */
export class SegmentCoordinatorCore {
    options;
    sessions = new Map();
    prefixes = new Map();
    /** Digests of the last main request as sent, for the compaction cache diagnostic. */
    mainRequests = new Map();
    counter;
    constructor(options) {
        this.options = options;
        this.counter = options.counter ?? createTokenCounter();
    }
    get ports() {
        return this.options.ports;
    }
    now() {
        return this.ports.nowMs?.() ?? Date.now();
    }
    formatTime(ms) {
        return this.ports.formatTime?.(ms) ?? defaultFormatTime(ms);
    }
    state(sessionId) {
        let state = this.sessions.get(sessionId);
        if (!state) {
            state = {
                segmentId: undefined,
                failures: 0,
                generation: 0,
                idleTraced: false,
                turnsInSegment: 0,
            };
            this.sessions.set(sessionId, state);
        }
        return state;
    }
    /**
     * The switches in effect for a Session the host handed over on the segment
     * profile; undefined when the context switch turns the profile off.
     */
    profile(sessionId) {
        const resolved = resolveSegmentContextSwitch(this.ports.getConfig);
        const state = this.state(sessionId);
        const traced = `${String(resolved.backgroundCompaction)}:${String(resolved.emergencyRebuild)}`;
        if (state.switchTraced !== traced) {
            state.switchTraced = traced;
            traceSegmentContextConfig(this.ports.trace, sessionId, resolved);
        }
        return resolved.backgroundCompaction ? resolved : undefined;
    }
    /** The host hands over only Sessions on the segment profile; the context switch may still turn it off. */
    profileEnabled(sessionId) {
        return this.profile(sessionId) !== undefined;
    }
    /**
     * First record of the running Turn in the active segment. A checkpoint
     * committed in this Turn writes its header and retained text under this
     * Turn's ID too, so the search starts after that rebuilt prefix; when its
     * length is unknown, after the header.
     */
    turnTailStart(sessionId, current, turnId) {
        const state = this.sessions.get(sessionId);
        const known = state?.segmentId === current.segmentId ? state.segmentPrefixLength : undefined;
        const header = current.records[0]?.message.role === 'compactionSummary' ? 1 : 0;
        return currentTurnStart(current.records, turnId, known ?? header);
    }
    refreshSegment(state, segmentId) {
        if (state.segmentId !== segmentId) {
            if (state.segmentId !== undefined) {
                this.clearFailures(state);
                state.turnsInSegment = 0;
            }
            // A segment this process did not commit: its prefix length is unknown.
            state.segmentPrefixLength = segmentId === null ? 0 : undefined;
        }
        state.segmentId = segmentId;
    }
    /** One more consecutive failure; the next background attempt waits longer. */
    recordFailure(state) {
        state.failures += 1;
        const delays = this.options.retryDelaysMs ?? BACKGROUND_RETRY_DELAYS_MS;
        const delay = delays[Math.min(state.failures, delays.length) - 1] ?? 0;
        state.retryAtMs = this.now() + delay;
    }
    clearFailures(state) {
        state.failures = 0;
        state.retryAtMs = undefined;
    }
    retryWaiting(state) {
        return state.retryAtMs !== undefined && this.now() < state.retryAtMs;
    }
    /** Route, request shape and limits every rebuild shares (11.2). */
    rebuildOptions(sessionId, route, snapshot, signal) {
        const mainRequest = this.mainRequests.get(sessionId);
        return {
            route,
            ...(route.sharedPrefixAllowed && snapshot
                ? { sharedPrefix: this.sharedPrefix(sessionId, route, snapshot) }
                : {}),
            ...(mainRequest ? { mainRequest } : {}),
            maxOutputTokens: this.maxOutputTokens(route),
            summaryBudgetTokens: this.budget(route, snapshot).shares.summary,
            ...(signal ? { signal } : {}),
            nowMs: () => this.now(),
        };
    }
    sharedPrefix(sessionId, route, snapshot) {
        return resolveCheckpointSharedPrefix({
            sessionId,
            model: route.model,
            checkpointRequestShape: 'shared_prefix',
            systemPrompt: snapshot.systemPrompt,
            tools: snapshot.tools,
        }, this.options.mainRequestMessages);
    }
    maxOutputTokens(route) {
        return checkpointMaxOutputTokens(DEFAULT_COMPACTION_SETTINGS.reserveTokens, route.maxTokens ?? route.model.maxTokens, route.model.contextWindow);
    }
    /**
     * Route budget from the window and the configured output limit. `compactionTriggerAt`
     * is not an input and is never read here: the segment profile does not honour that user
     * setting, only the main automatic trigger does. See {@link footprint} for the matching
     * token-source contract.
     */
    budget(route, snapshot) {
        const maxOutputTokens = route.maxTokens ?? route.model.maxTokens;
        const foreground = this.options.foregroundBudget({
            contextWindow: route.model.contextWindow,
            maxOutputTokens,
            ...(snapshot ? { systemTokens: this.measure(route.model, [], snapshot) } : {}),
        });
        return resolveSegmentCompactionBudget({
            contextWindow: route.model.contextWindow,
            configuredMaxOutputTokens: maxOutputTokens,
            foreground,
        });
    }
    /**
     * The segment profile's footprint: the LOCAL ESTIMATE ONLY. It deliberately passes no
     * `usageAnchor`, so a Provider usage measurement never reaches this path.
     *
     * Three consequences, all intentional:
     *
     * - The soft and hard lines are compared against a local estimate, not against the next
     *   request's measured prompt. The segment ladder is a separate product decision from the
     *   main automatic trigger and must not inherit its calibration.
     * - A user `contextManagement.compactionTriggerAt` does not move it. Only the main
     *   automatic compactor reads that setting (createCompactionTriggerAtGetter in
     *   execution/production-context-compactors.ts); the segment profile ignores it.
     * - Wiring an anchor in here would silently change WHEN background compaction starts.
     *   That is a product behaviour change, not a refactor, so it needs its own decision.
     *
     * It does share the visual token pricer with the trigger, through the same measurer: a
     * screenshot costs its real dimensions on both paths. Only the token SOURCE differs.
     */
    footprint(model, messages, snapshot) {
        return createLocalContextFootprintMeasurer({
            model,
            ...(snapshot ? { systemPrompt: snapshot.systemPrompt, tools: snapshot.tools } : {}),
        }).measure(messages);
    }
    measure(model, messages, snapshot) {
        return this.footprint(model, messages, snapshot).inputTokens;
    }
    /** The segment's own conversation: everything after the checkpoint's header and retained text. */
    segmentGrowth(model, state, messages) {
        if (state.segmentPrefixLength === undefined)
            return undefined;
        const added = messages.slice(state.segmentPrefixLength);
        return { tokens: this.measure(model, added, undefined), messages: added.length };
    }
}
function defaultFormatTime(ms) {
    const date = new Date(ms);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
//# sourceMappingURL=core.js.map