import { EmergencyRebuilds } from '../emergency/session.js';
import { endIdleTrace } from '../idle-trace.js';
import { fingerprintRequest } from '../request-fingerprint.js';
import { SegmentBackgroundCompaction } from './background.js';
import { SegmentCommits } from './commit.js';
import { SegmentCoordinatorCore, } from './core.js';
import { SegmentManualCompaction } from './manual.js';
import { SegmentRequestDecision } from './request-decision.js';
import { SegmentContextReset } from './reset.js';
/**
 * The segment compaction profile (spec 10, 11, 12): background segment rebuilds,
 * prefix-replacement commits at Turn start, a bounded wait for a rebuild only
 * over the input limit, and manual `/compact`. Every piece of state is
 * process memory; a restart drops pending results (11.7).
 */
export class SegmentCompactionCoordinator {
    core;
    background;
    commits;
    decisions;
    manual;
    emergencies;
    resets;
    afterTurns = new Map();
    constructor(options) {
        const core = new SegmentCoordinatorCore(options);
        this.core = core;
        this.background = new SegmentBackgroundCompaction(core);
        this.commits = new SegmentCommits(core, this.background);
        this.decisions = new SegmentRequestDecision(core, this.background, this.commits);
        this.manual = new SegmentManualCompaction(core, this.background, this.commits);
        this.emergencies = new EmergencyRebuilds({
            ports: core.ports,
            counter: core.counter,
            budget: (route, snapshot) => core.budget(route, snapshot),
            footprint: (model, messages, snapshot) => core.footprint(model, messages, snapshot),
            now: () => core.now(),
            formatTime: (ms) => core.formatTime(ms),
            prepare: (sessionId, turnId, current) => {
                this.background.discardPending(sessionId, 'emergency_rebuild', turnId);
                core.refreshSegment(core.state(sessionId), current.segmentId);
                return core.turnTailStart(sessionId, current, turnId);
            },
            startSegment: (sessionId, committed) => this.commits.startSegment(sessionId, { ...committed, rebuildReason: 'emergency_rebuild' }),
        });
        this.resets = new SegmentContextReset(core, this.background, this.commits, this.emergencies);
    }
    /** Test and diagnostics view of one Session's in-memory state. */
    inspect(sessionId) {
        const state = this.core.sessions.get(sessionId);
        return {
            failures: state?.failures ?? 0,
            retryAtMs: state?.retryAtMs,
            inFlight: state?.inFlight !== undefined,
            ready: state?.ready !== undefined,
            replacePending: state?.replacePending !== undefined,
            hasMainRequestSnapshot: this.core.prefixes.has(sessionId),
        };
    }
    /**
     * How many records at the head of the active history the last checkpoint
     * wrote (header and retained text): 0 before any checkpoint, undefined
     * while unknown (no Turn seen yet, or a restart inside a rebuilt segment).
     */
    segmentPrefixLength(sessionId) {
        return this.core.sessions.get(sessionId)?.segmentPrefixLength;
    }
    /** Waits for the in-flight background compaction, if any. */
    async settled(sessionId) {
        await this.core.sessions.get(sessionId)?.inFlight?.promise;
        await this.emergencies.drained(sessionId);
    }
    /** Drops the main-request snapshot, as an application restart does. */
    forgetMainRequest(sessionId) {
        this.core.prefixes.delete(sessionId);
        this.core.mainRequests.delete(sessionId);
    }
    /**
     * The main request's prefix (11.2), and the digests of the body it sends,
     * which a compaction request is compared with when it reads little cache.
     */
    observeMainRequest(input) {
        if (input.scope !== 'agent' || !this.core.sessions.has(input.sessionId))
            return undefined;
        const { sessionId } = input;
        this.core.prefixes.set(sessionId, {
            systemPrompt: input.systemPrompt,
            tools: input.tools,
            capturedAtMs: this.core.now(),
        });
        return {
            onPayload: (payload) => {
                const sent = fingerprintRequest(payload);
                if (sent)
                    this.core.mainRequests.set(sessionId, sent);
                else
                    this.core.mainRequests.delete(sessionId);
            },
        };
    }
    async beginTurn(input) {
        const profile = this.core.profile(input.sessionId);
        if (!profile)
            return undefined;
        const { sessionId, turnId } = input;
        const state = this.core.state(sessionId);
        endIdleTrace(this.core.ports.trace, sessionId, state, this.core.now());
        try {
            await this.commits.commitReadyAtTurnStart(input);
        }
        catch {
            // A failed commit point never fails the Turn; the result stays pending.
        }
        // Spec 13.2: with the switch off nothing of the emergency rebuild runs.
        const emergency = profile.emergencyRebuild
            ? this.emergencies.begin(sessionId, turnId)
            : undefined;
        const scope = emergency ? { sessionId, turnId, emergency } : undefined;
        const providerSessionId = scope && (await this.emergencies.providerSessionId(sessionId));
        return {
            beforeLlm: async (hookInput, hooks) => {
                emergency?.requestStarted(hookInput.recovery !== undefined);
                if (hookInput.recovery) {
                    return this.recoverRequest(scope ?? { sessionId, turnId }, hookInput, hooks);
                }
                const repaired = scope && (await this.emergencies.afterRepair(scope, hookInput, hooks));
                return repaired ?? this.decisions.beforeLlm(sessionId, turnId, hookInput, hooks);
            },
            ...(scope
                ? {
                    onTurnFailing: scope.emergency.onTurnFailing,
                    repairPreparation: (error) => this.emergencies.repairPreparation(scope, error),
                    ...(providerSessionId ? { providerSessionId } : {}),
                }
                : {}),
            finish: (settlement) => {
                if (emergency)
                    this.emergencies.finish(sessionId, emergency, settlement);
            },
        };
    }
    /**
     * A request that repeats a failed one. A Turn the emergency rebuild
     * recovers repeats it unchanged, or over the segment that rebuild makes
     * (spec 3.4, 4); a request the provider rejected is never sent unchanged:
     * the default compaction recovers it.
     */
    async recoverRequest(turn, input, hooks) {
        const { sessionId, turnId, emergency } = turn;
        const recovered = emergency
            ? await this.emergencies.recover({ sessionId, turnId, emergency }, input, hooks)
            : undefined;
        return (recovered ??
            this.decisions.handOverRecovery(sessionId, turnId, input.recovery?.reason ?? '', emergency !== undefined));
    }
    /** The session identifier of model requests outside a Turn (spec 9.1); none with the switch off. */
    async providerSessionId(sessionId) {
        try {
            const profile = this.core.profile(sessionId);
            return profile?.emergencyRebuild
                ? await this.emergencies.providerSessionId(sessionId)
                : undefined;
        }
        catch {
            return undefined;
        }
    }
    endTurn(input) {
        // Kept per Session so the detached work is owned; it never throws.
        this.afterTurns.set(input.sessionId, this.background.afterTurnSafely(input));
    }
    /** Starts one background compaction over the current active history (11.1, 11.3). */
    startBackground(sessionId, start) {
        this.background.startBackground(sessionId, start);
    }
    /** Drops in-flight and ready results; a written ledger delta stays (11.7). */
    discardPending(sessionId, reason, turnId) {
        this.background.discardPending(sessionId, reason, turnId);
    }
    /**
     * The user's context reset (context reset spec 4 to 7). It runs whatever
     * the context switch says (2.5); undefined only when the runtime offers no
     * reset. Never throws.
     */
    async resetContext(input) {
        const port = this.core.ports.contextReset;
        if (!port)
            return undefined;
        try {
            return await this.resets.reset(port, input);
        }
        catch (error) {
            return { status: 'failed', category: 'other', error };
        }
    }
    /** Manual `/compact`: rebuilds the whole active segment; undefined leaves it to the default. */
    compactManual(input) {
        return this.manual.compactManual(input);
    }
}
//# sourceMappingURL=coordinator.js.map