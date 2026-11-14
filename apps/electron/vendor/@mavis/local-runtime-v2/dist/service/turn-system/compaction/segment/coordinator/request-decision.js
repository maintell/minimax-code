import { randomUUID } from 'node:crypto';
import { mapMergedCommit, mergedRebuildBase } from '../merged-rebuild.js';
import { buildCommitCandidate, failureReason, generatedFields, generateRebuild, routeFromHook, sharedSnapshot, writeExternalState, } from '../rebuild-pipeline.js';
import { currentTurnStart, notReadyReason, prefixConflict } from '../segment-checks.js';
import { traceSegmentCompaction } from '../trace.js';
/** A Turn over the input limit waits this long for the segment rebuild, then hands over to the default ladder. */
const FOREGROUND_WAIT_MS = 120_000;
/** The whole wait of a Turn over the input limit, the default ladder included. */
const FOREGROUND_LIMIT_MS = 180_000;
/**
 * What each main request does before it is sent (11.5, 11.8, 11.9, 2.6): sent as it is, sent
 * while the segment is rebuilt in the background, or held over the input limit until a rebuild
 * lands or a bounded wait runs out.
 */
export class SegmentRequestDecision {
    core;
    background;
    commits;
    constructor(core, background, commits) {
        this.core = core;
        this.background = background;
        this.commits = commits;
    }
    /**
     * Before-LLM decision of the segment profile (11.5, 11.9, 2.6), at the first
     * request and mid-turn alike. Under the hard line the request is sent as it
     * is. Over the hard line but within the input limit it is sent too, and the
     * segment is rebuilt in the background. Only a request over the input limit
     * waits for a rebuild, with a bounded wait.
     */
    async beforeLlm(sessionId, turnId, input, hooks) {
        const route = routeFromHook(input, hooks.sharedPrefixAllowed);
        const snapshot = { systemPrompt: input.systemPrompt ?? '', tools: input.tools ?? [] };
        const budget = this.core.budget(route, snapshot);
        const decision = { sessionId, turnId, input, route, snapshot, budget, hooks };
        const tokens = this.core.measure(input.model, input.messages, snapshot);
        if (tokens <= budget.hardLine)
            return { kind: 'continue' };
        const trigger = input.phase === 'iteration' ? 'mid_turn_hard_line' : 'hard_line';
        if (tokens <= budget.providerInputLimit)
            return this.overHardLine(decision, trigger);
        return this.overInputLimit(decision, trigger);
    }
    /**
     * The provider rejected the last request (too many images, too large) and
     * the Turn repeats it once. Resending the same history would fail the Turn,
     * so the default compaction recovers it, as when the profile is off (10.5):
     * it moves every image out of the history and checkpoints. A pending
     * background result is discarded, as a synchronous rebuild discards it (11.8).
     * While the emergency rebuild is on, that compaction shows nothing: the
     * Turn it recovers may still end in an emergency rebuild (spec 11.1).
     */
    handOverRecovery(sessionId, turnId, recoveryReason, quiet) {
        this.background.discardPending(sessionId, 'provider_recovery', turnId);
        traceSegmentCompaction(this.core.ports.trace, sessionId, turnId, {
            trigger: 'provider_recovery',
            outcome: 'delegated',
            reason: recoveryReason,
            background: false,
        });
        return { kind: 'default', reason: 'provider_recovery', ...(quiet ? { quiet: true } : {}) };
    }
    /**
     * Over the hard line, within the input limit: the request is sent while the
     * segment is rebuilt in the background. A ready result that fits is
     * committed here; one that no longer fits gives way to a new rebuild.
     */
    async overHardLine(decision, trigger) {
        const { sessionId, turnId, input } = decision;
        const state = this.core.state(sessionId);
        if (input.phase === 'initial' && state.turnStartReplacedTurnId === turnId) {
            // This Turn start already replaced the history once; it is sent while it fits.
            traceSegmentCompaction(this.core.ports.trace, sessionId, turnId, {
                trigger,
                outcome: 'skipped',
                reason: 'turn_start_replaced',
                background: false,
            });
            return { kind: 'continue' };
        }
        if (state.ready) {
            const committed = await this.commitReadyInTurn(decision);
            if (typeof committed === 'object')
                return committed;
            this.dropReady(sessionId, 'superseded_over_hard_line', turnId, committed);
        }
        this.background.startBackground(sessionId, {
            turnId,
            trigger,
            route: this.jobRoute(decision),
            coverBefore: turnId,
        });
        return { kind: 'continue' };
    }
    /**
     * Over the input limit the request cannot be sent: the Turn waits for a
     * rebuild, at most `foregroundWaitMs`, then the default ladder gets what is
     * left of `foregroundLimitMs`. The rebuild is not tied to the Turn: when the
     * user stops it or the wait runs out, the rebuild goes on and its result is
     * committed at a later Turn start.
     */
    async overInputLimit(decision, trigger) {
        const { sessionId, turnId, input } = decision;
        const state = this.core.state(sessionId);
        const startedAtMs = this.core.now();
        await decision.hooks.onRebuildStarted();
        if (state.ready) {
            const committed = await this.commitReadyInTurn(decision);
            if (typeof committed === 'object')
                return committed;
        }
        if (state.ready || state.replacePending) {
            const merged = await this.mergeReadyIntoHardLine(decision, trigger, startedAtMs);
            if (merged)
                return merged;
        }
        this.background.startBackground(sessionId, {
            turnId,
            trigger,
            route: this.jobRoute(decision),
            coverBefore: turnId,
            force: true,
        });
        await this.waitForRebuild(state, input.signal, this.waitLeft(startedAtMs));
        if (state.ready) {
            const committed = await this.commitReadyInTurn(decision);
            if (typeof committed === 'object')
                return committed;
            this.dropReady(sessionId, 'over_hard_line', turnId, committed);
            return this.handOverAfterWait(decision, trigger, startedAtMs, 'over_hard_line');
        }
        return this.handOverAfterWait(decision, trigger, startedAtMs, state.inFlight ? 'wait_timeout' : 'rebuild_failed');
    }
    /** Background route for a rebuild that may outlive the running Turn. */
    jobRoute(decision) {
        return decision.hooks.backgroundRoute?.() ?? decision.route;
    }
    waitLeft(startedAtMs) {
        const wait = this.core.options.foregroundWaitMs ?? FOREGROUND_WAIT_MS;
        return Math.max(0, wait - (this.core.now() - startedAtMs));
    }
    /** A ready result the request cannot use: one that failed its checks counts as a failure. */
    dropReady(sessionId, reason, turnId, committed) {
        if (committed === 'rejected')
            this.background.rejectPending(sessionId, reason, turnId);
        else
            this.background.discardPending(sessionId, reason, turnId);
    }
    /**
     * The segment rebuild did not land in time: the default ladder runs on the
     * rest of the limit. A Turn the user stopped has nothing left to do.
     */
    handOverAfterWait(decision, trigger, startedAtMs, reason) {
        const { sessionId, turnId, input } = decision;
        const elapsedMs = Math.max(0, this.core.now() - startedAtMs);
        const stopped = input.signal?.aborted === true;
        traceSegmentCompaction(this.core.ports.trace, sessionId, turnId, {
            trigger,
            outcome: 'failed',
            reason: stopped ? 'aborted' : reason,
            background: false,
            durationMs: elapsedMs,
        });
        if (stopped)
            return { kind: 'default', reason: 'aborted' };
        const limit = this.core.options.foregroundLimitMs ?? FOREGROUND_LIMIT_MS;
        return { kind: 'default', reason, timeLimitMs: Math.max(0, limit - elapsedMs) };
    }
    /**
     * 11.5: a pending background result over the input limit. The result is
     * applied first (its ledger delta is written), the segment is rebuilt over
     * what it leaves, and both reach the history as one replacement. Undefined
     * when the result no longer matches the history: a fresh rebuild follows.
     */
    async mergeReadyIntoHardLine(decision, trigger, startedAtMs) {
        const { sessionId, turnId, input } = decision;
        const state = this.core.state(sessionId);
        const pending = state.replacePending ?? { generated: state.ready, external: undefined };
        const current = await this.core.ports.history.readSegment(sessionId);
        const activeTailStart = this.core.turnTailStart(sessionId, current, turnId);
        if (!mergeable(pending.generated, current, input.canonicalMessages.length, activeTailStart)) {
            this.background.rejectPending(sessionId, 'hard_line_rebuild', turnId);
            return undefined;
        }
        state.ready = undefined;
        state.replacePending = undefined;
        const generation = state.generation;
        const deadline = AbortSignal.timeout(Math.max(1, this.waitLeft(startedAtMs)));
        const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
        try {
            return await this.mergedRebuild(decision, { ...pending, current, activeTailStart }, signal);
        }
        catch (error) {
            // A stop puts the result back for a later Turn start; the merge itself is lost.
            if (input.signal?.aborted && state.generation === generation && !state.inFlight) {
                restorePending(state, pending);
            }
            return this.handOverAfterWait(decision, trigger, startedAtMs, deadline.aborted ? 'wait_timeout' : failureReason(error));
        }
    }
    async mergedRebuild(decision, pending, signal) {
        const { sessionId, turnId, input, route, snapshot } = decision;
        const { current, generated: ready } = pending;
        if (!pending.external)
            await writeExternalState({ ports: this.core.ports, sessionId, generated: ready });
        const before = this.core.footprint(route.model, current.records.map((record) => record.message), snapshot);
        const applied = await buildCommitCandidate({
            ports: this.core.ports,
            sessionId,
            generated: ready,
            active: current.records,
            budget: decision.budget,
            counter: this.core.counter,
            tokensBefore: before.inputTokens,
            nowMs: this.core.now(),
            formatTime: (ms) => this.core.formatTime(ms),
            runningTurnId: turnId,
        });
        const base = mergedRebuildBase(applied, current.records, ready.compactionId);
        const generated = await generateRebuild({
            ports: this.core.ports,
            sessionId,
            compactionId: `bunny_${randomUUID()}`,
            trigger: 'hard_line',
            segmentId: current.segmentId,
            records: base.records,
            coveredCount: currentTurnStart(base.records, turnId),
            ...this.core.rebuildOptions(sessionId, route, sharedSnapshot(input, snapshot), signal),
        });
        const prepared = await this.commits.prepareCommit({
            sessionId,
            turnId,
            generated,
            active: base.records,
            route,
            snapshot,
            background: false,
            limit: decision.budget.hardLine,
            currentTokens: before.inputTokens,
        });
        if (prepared.kind !== 'ready')
            throw new Error(notReadyReason(prepared));
        const commit = mapMergedCommit({
            commit: prepared.commit,
            base,
            active: current.records,
            activeTailStart: pending.activeTailStart,
            segmentId: current.segmentId,
            before,
            afterCommit: async () => {
                await prepared.commit.afterCommit();
                await this.commits.storeMedia(sessionId, ready);
                traceSegmentCompaction(this.core.ports.trace, sessionId, turnId, {
                    ...generatedFields(ready),
                    outcome: 'merged',
                    reason: 'hard_line',
                    background: true,
                    ledgerDeltaCount: ready.references.ledger.length,
                    mediaCount: ready.references.media.length,
                });
            },
        });
        return { kind: 'replace', commit };
    }
    /** Until the running rebuild settles, the Turn is stopped, or `ms` pass. */
    async waitForRebuild(state, signal, ms) {
        const inFlight = state.inFlight;
        if (!inFlight || signal?.aborted)
            return;
        let timer;
        let onAbort;
        await Promise.race([
            inFlight.promise,
            new Promise((resolve) => {
                timer = setTimeout(resolve, ms);
                onAbort = () => resolve();
                signal?.addEventListener('abort', onAbort, { once: true });
            }),
        ]);
        if (timer)
            clearTimeout(timer);
        if (onAbort)
            signal?.removeEventListener('abort', onAbort);
    }
    /**
     * A ready result committed inside the Turn when it leaves the request under
     * the hard line; `rejected` when it failed the prefix or size check, undefined
     * when there is none or the request is not the history yet.
     */
    async commitReadyInTurn(decision) {
        const { sessionId, turnId, input } = decision;
        const state = this.core.state(sessionId);
        const generated = state.ready;
        if (!generated)
            return undefined;
        const current = await this.core.ports.history.readSegment(sessionId);
        if (current.records.length !== input.canonicalMessages.length)
            return undefined;
        if (prefixConflict(generated, current))
            return 'rejected';
        const prepared = await this.commits.prepareCommit({
            sessionId,
            turnId,
            generated,
            active: current.records,
            route: decision.route,
            snapshot: decision.snapshot,
            background: true,
            limit: decision.budget.hardLine,
        });
        if (prepared.kind !== 'ready')
            return 'rejected';
        state.ready = undefined;
        state.replacePending = { generated, external: prepared.external };
        return { kind: 'replace', commit: prepared.commit };
    }
}
/** A ready result can be merged when the history still starts with what it covers. */
function mergeable(generated, current, requestLength, activeTailStart) {
    return (prefixConflict(generated, current) === undefined &&
        current.records.length === requestLength &&
        activeTailStart >= generated.coveredCount);
}
function restorePending(state, pending) {
    if (pending.external) {
        state.replacePending = { generated: pending.generated, external: pending.external };
    }
    else {
        state.ready = pending.generated;
    }
}
//# sourceMappingURL=request-decision.js.map