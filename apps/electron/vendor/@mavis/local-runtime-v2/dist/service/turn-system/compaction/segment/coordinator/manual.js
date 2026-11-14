import { randomUUID } from 'node:crypto';
import { failureReason, generateRebuild } from '../rebuild-pipeline.js';
import { traceSegmentCompaction } from '../trace.js';
/** Manual `/compact` on the segment profile: the whole active segment, rebuilt at once. */
export class SegmentManualCompaction {
    core;
    background;
    commits;
    constructor(core, background, commits) {
        this.core = core;
        this.background = background;
        this.commits = commits;
    }
    async compactManual(input) {
        if (!this.core.profileEnabled(input.sessionId))
            return undefined;
        this.background.discardPending(input.sessionId, 'manual_compact', input.turnId);
        try {
            const current = await this.core.ports.history.readSegment(input.sessionId);
            if (current.records.length === 0 || current.records.length !== input.expectedMessageCount) {
                return undefined;
            }
            await input.onStarted?.();
            const snapshot = this.manualSnapshot(input);
            const generated = await generateRebuild({
                ports: this.core.ports,
                sessionId: input.sessionId,
                compactionId: `bunny_${randomUUID()}`,
                trigger: 'manual',
                segmentId: current.segmentId,
                records: current.records,
                coveredCount: current.records.length,
                ...this.core.rebuildOptions(input.sessionId, input.route, snapshot, input.signal),
            });
            const prepared = await this.commits.prepareCommit({
                sessionId: input.sessionId,
                turnId: input.turnId,
                generated,
                active: current.records,
                route: input.route,
                snapshot,
                background: false,
                limit: Number.MAX_SAFE_INTEGER,
            });
            return prepared.kind === 'ready' ? prepared.commit : undefined;
        }
        catch (error) {
            traceSegmentCompaction(this.core.ports.trace, input.sessionId, input.turnId, {
                trigger: 'manual',
                outcome: 'failed',
                reason: failureReason(error),
                background: false,
            });
            return undefined;
        }
    }
    /** The request the manual rebuild shares its prefix with: this one, else the last main one. */
    manualSnapshot(input) {
        if (input.systemPrompt === undefined)
            return this.core.prefixes.get(input.sessionId);
        return { systemPrompt: input.systemPrompt, tools: input.tools ?? [] };
    }
}
//# sourceMappingURL=manual.js.map