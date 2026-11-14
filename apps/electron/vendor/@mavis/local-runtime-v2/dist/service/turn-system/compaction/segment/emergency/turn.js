/** Recovery reasons the emergency rebuild asks agent-core for. */
export const EMERGENCY_RESEND_REASON = 'bunny_resend';
export const EMERGENCY_REBUILD_REASON = 'bunny_emergency_rebuild';
/** Longest excerpt of a failure's words in the incident note (spec 5.1). */
const EXCERPT_CHARS = 200;
/** The result of a handling still open when the Turn settles (12.1). */
const SETTLED_RESULTS = {
    completed: 'recovered',
    aborted: 'stopped',
    failed: 'retry_failed',
};
/** A configuration rewrite makes no rebuild (spec 8). */
const CONFIG_REWRITE = { category: 'builtin_config_corrupted', level: 'none' };
/**
 * The emergency rebuild of one Turn (spec 3): at most one resend and one
 * rebuild, a stop always wins, and each handling is traced once with its
 * result, at the latest when the Turn settles.
 */
export class EmergencyTurn {
    ports;
    phase = 'idle';
    resendUsed = false;
    /** The Turn's one rebuild (3.5) was asked for, refused at the limit, or followed a repair. */
    rebuildUsed = false;
    open = [];
    pending;
    settled = false;
    constructor(ports) {
        this.ports = ports;
    }
    /** The rebuild the current recovery asks for, when it is one. */
    get pendingRebuild() {
        return this.phase === 'rebuilding' ? this.pending : undefined;
    }
    onTurnFailing = async (input) => {
        if (this.settled || input.signal?.aborted)
            return { type: 'continue' };
        const afterRebuild = this.afterRebuild();
        if (afterRebuild)
            return afterRebuild;
        // No request started since the resend: it is the resent request that failed.
        if (this.phase === 'resending') {
            this.close('resend', 'retry_failed');
            this.phase = 'idle';
        }
        // A recovery the runner would refuse is never asked for, so nothing is traced.
        if (!input.recoverable)
            return { type: 'continue' };
        const classification = this.ports.classify(input.failure);
        if (!classification)
            return { type: 'continue' };
        if (classification.resendFirst && !this.resendUsed) {
            this.resendUsed = true;
            this.phase = 'resending';
            this.openRecord('resend', classification);
            return { type: 'recover', reason: EMERGENCY_RESEND_REASON, replay: true };
        }
        return this.rebuild(classification, input.signal);
    };
    /**
     * A request of the Turn starts. One that repeats no failed request follows
     * an answered one: when the resend was pending, it recovered (12.1).
     */
    requestStarted(repeatsFailure) {
        if (this.phase !== 'resending' || repeatsFailure)
            return;
        this.close('resend', 'recovered');
        this.phase = 'idle';
    }
    /** A failure once the Turn's rebuild was asked for; undefined before that. */
    afterRebuild() {
        if (this.phase === 'rebuilding' || this.phase === 'unmade') {
            // The rebuild itself failed: the Turn reports the failure it replaced (2.3, 3.7).
            if (this.phase === 'rebuilding')
                this.close('rebuild', 'rebuild_failed', 'commit_failed');
            this.phase = 'rebuilt';
            return { type: 'restore' };
        }
        // One rebuild per Turn; its retry failing ends the Turn (3.5, 3.6).
        return this.phase === 'rebuilt' ? { type: 'continue' } : undefined;
    }
    async rebuild(classification, signal) {
        if (this.rebuildUsed)
            return { type: 'continue' };
        if (await this.ports.segmentLimitReached()) {
            this.rebuildUsed = true;
            this.openRecord('rebuild', classification);
            this.close('rebuild', 'limit_reached');
            return { type: 'continue' };
        }
        if (signal?.aborted)
            return { type: 'continue' };
        this.rebuildUsed = true;
        this.phase = 'rebuilding';
        this.pending = { classification, failedAtMs: this.ports.nowMs() };
        this.openRecord('rebuild', classification);
        return { type: 'recover', reason: EMERGENCY_REBUILD_REASON };
    }
    /**
     * The Turn's preparation repaired its history (spec 6.2). The repair is
     * never limited; the rebuild that follows it is this Turn's one rebuild,
     * made at its first request unless the segment limit holds (3.5). It
     * replaces no failure, so the resend stays the Turn's as in any other.
     */
    async historyRepaired(repair) {
        if (this.settled || this.phase !== 'idle')
            return;
        const classification = historyClassification(repair.reason);
        this.openRecord('history_repair', classification, repair.backupFile);
        this.openRecord('rebuild', classification);
        this.rebuildUsed = true;
        if (await this.ports.segmentLimitReached()) {
            this.close('rebuild', 'limit_reached');
            return;
        }
        this.phase = 'rebuilding';
        this.pending = { classification, failedAtMs: this.ports.nowMs(), repair };
    }
    /**
     * The Turn's preparation rewrote Bunny's corrupt built-in configuration
     * (spec 8); the handling takes the Turn's result when it settles.
     */
    configRewritten(backupFile) {
        if (this.settled)
            return;
        this.openRecord('config_rewrite', CONFIG_REWRITE, backupFile);
    }
    /** The configuration was corrupt and could not be rewritten: the Turn fails as it does today. */
    configRewriteFailed() {
        if (this.settled)
            return;
        this.openRecord('config_rewrite', CONFIG_REWRITE);
        this.close('config_rewrite', 'rebuild_failed', 'config_rewrite_failed');
    }
    /** The Turn's history was corrupt and could not be repaired: it fails as it does today (3.7). */
    historyRepairFailed() {
        if (this.settled)
            return;
        this.openRecord('history_repair', historyClassification(''));
        this.close('history_repair', 'rebuild_failed', 'history_repair_failed');
    }
    /**
     * The rebuild could not be made. A rebuild asked for by a failure fails its
     * request with this result, and the Turn reports the failure it replaced
     * (2.3, 3.7); one after a history repair leaves the request as it is.
     */
    rebuildNotMade(failure) {
        if (this.phase !== 'rebuilding')
            return;
        this.close('rebuild', failure.result, 'reason' in failure ? failure.reason : undefined);
        this.phase = this.pending?.repair ? 'idle' : 'unmade';
        this.pending = undefined;
    }
    /** The rebuilt segment is durable; the retry follows (3.2). */
    rebuildCommitted(details) {
        const record = this.open.find((item) => item.action === 'rebuild');
        if (record) {
            record.made = true;
            record.replaced = details.replaced;
            record.affinityRotated = details.affinityRotated;
            if (details.backupFile)
                record.backupFile = details.backupFile;
        }
        // The first request after a repair retries no failure (3.6 does not apply).
        this.phase = this.pending?.repair ? 'idle' : 'rebuilt';
        this.pending = undefined;
    }
    /** The Turn settled: every open handling takes its result from the outcome (12.1). */
    async finish(settlement) {
        if (this.settled)
            return;
        this.settled = true;
        const result = SETTLED_RESULTS[settlement.status];
        for (const record of [...this.open]) {
            // A rebuild the Turn never got to make stopped or failed before it existed.
            const made = record.action !== 'rebuild' || record.made === true;
            if (made || result === 'stopped')
                this.close(record.action, result);
            else
                this.close(record.action, 'rebuild_failed', 'turn_ended');
        }
        if (settlement.status === 'completed')
            await this.ports.turnSucceeded();
    }
    openRecord(action, classification, backupFile) {
        this.open.push({
            action,
            classification,
            startedAtMs: this.ports.nowMs(),
            replaced: {},
            affinityRotated: false,
            ...(backupFile ? { backupFile } : {}),
        });
    }
    close(action, result, failureReason) {
        const index = this.open.findIndex((item) => item.action === action);
        const [record] = index < 0 ? [] : this.open.splice(index, 1);
        if (!record)
            return;
        const { classification } = record;
        this.ports.report({
            turnId: this.ports.turnId,
            action,
            category: classification.category,
            level: classification.level,
            ...(classification.errorCode === undefined ? {} : { errorCode: classification.errorCode }),
            startedAtMs: record.startedAtMs,
            replaced: record.replaced,
            affinityRotated: record.affinityRotated,
            ...(record.backupFile ? { backupFile: record.backupFile } : {}),
            result,
            ...(failureReason ? { failureReason } : {}),
            durationMs: Math.max(0, this.ports.nowMs() - record.startedAtMs),
        });
    }
}
/** A corrupt history is rebuilt at the standard level (spec 2.4), its read error as the excerpt. */
function historyClassification(reason) {
    return {
        category: 'history_corrupted',
        level: 'standard',
        resendFirst: false,
        excerpt: Array.from(reason.trim()).slice(0, EXCERPT_CHARS).join(''),
    };
}
//# sourceMappingURL=turn.js.map