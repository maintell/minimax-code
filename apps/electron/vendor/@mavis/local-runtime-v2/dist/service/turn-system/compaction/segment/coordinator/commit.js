import { buildCommitCandidate, failureReason, generatedFields, segmentCommitResult, writeExternalState, } from '../rebuild-pipeline.js';
import { externalGrowth, overSoftLineOnlyByTail, prefixConflict, rebuiltPrefixLength, sizeVerdict, } from '../segment-checks.js';
import { traceSegmentCompaction, traceSegmentChange, } from '../trace.js';
/**
 * Commits of a rebuilt segment (11.5 to 11.7): the checks that it still fits and matches the
 * history, the ledger delta written before the replacement, and what follows a committed one.
 */
export class SegmentCommits {
    core;
    background;
    constructor(core, background) {
        this.core = core;
        this.background = background;
    }
    /**
     * Turn-start commit point (11.5): the prefix and segment must be unchanged
     * (11.6), the result must fit, then the ledger delta is written before the
     * history replacement (11.7). A history failure keeps the validated result
     * so the next Turn retries only the replacement.
     */
    async commitReadyAtTurnStart(input) {
        const { sessionId, turnId, commit } = input;
        const state = this.core.state(sessionId);
        const generated = state.replacePending?.generated ?? state.ready;
        const route = state.lastRoute;
        if (!generated || !route)
            return;
        const current = await this.core.ports.history.readSegment(sessionId);
        const conflict = prefixConflict(generated, current);
        if (conflict) {
            this.background.rejectPending(sessionId, conflict, turnId);
            return;
        }
        const snapshot = this.core.prefixes.get(sessionId);
        const prepared = await this.prepareCommit({
            sessionId,
            turnId,
            generated,
            active: current.records,
            route,
            snapshot,
            background: true,
            external: state.replacePending?.external,
            // This Turn's own input still has to fit under the hard line afterwards.
            expectedExtraTokens: this.core.counter.countText(input.pendingInputText ?? ''),
            // A tail of whole Turns grew while the result waited; it would not shrink by waiting (8.5).
            commitTailOverSoftLine: true,
        });
        if (prepared.kind === 'deferred') {
            // The first request commits it, or merges it into a rebuild over the input limit (11.9).
            traceSegmentCompaction(this.core.ports.trace, sessionId, turnId, {
                ...generatedFields(generated),
                outcome: 'deferred',
                reason: 'hard_line_expected',
                background: true,
            });
            return;
        }
        if (prepared.kind === 'rejected') {
            state.ready = undefined;
            state.replacePending = undefined;
            this.core.recordFailure(state);
            traceSegmentCompaction(this.core.ports.trace, sessionId, turnId, {
                ...generatedFields(generated),
                outcome: 'failed',
                reason: prepared.reason,
                background: true,
                failureCount: state.failures,
                ...(prepared.sizeTokens ? { sizeTokens: prepared.sizeTokens } : {}),
            });
            return;
        }
        state.ready = undefined;
        state.replacePending = { generated, external: prepared.external };
        try {
            await commit(prepared.commit);
        }
        catch (error) {
            traceSegmentCompaction(this.core.ports.trace, sessionId, turnId, {
                ...generatedFields(generated),
                outcome: 'deferred',
                reason: `history_replace_failed:${failureReason(error)}`,
                background: true,
            });
            return;
        }
        state.turnStartReplacedTurnId = turnId;
        await prepared.commit.afterCommit();
    }
    async prepareCommit(input) {
        const { sessionId, generated, route, snapshot } = input;
        const budget = this.core.budget(route, snapshot);
        const before = this.core.footprint(route.model, input.active.map((record) => record.message), snapshot);
        const build = (nowMs) => buildCommitCandidate({
            ports: this.core.ports,
            sessionId,
            generated,
            active: input.active,
            budget,
            counter: this.core.counter,
            tokensBefore: before.inputTokens,
            nowMs,
            formatTime: (ms) => this.core.formatTime(ms),
            ...(input.turnId === undefined ? {} : { runningTurnId: input.turnId }),
        });
        const nowMs = this.core.now();
        const currentTokens = input.currentTokens ?? before.inputTokens;
        let candidate = await build(nowMs);
        let growth = input.external ? 0 : externalGrowth(candidate, generated, budget.shares);
        // Checked as it will be committed: with the header grown by the delta not written yet.
        const checkSize = (total) => {
            const verdict = sizeVerdict({
                afterTokens: total,
                currentTokens,
                softLine: budget.softLine,
                limit: input.limit,
            });
            if (verdict !== 'over_soft_line')
                return { verdict };
            const sizes = this.sizeTokensOf({ candidate, total, growth, route, snapshot, budget });
            const tailOnly = input.commitTailOverSoftLine === true &&
                overSoftLineOnlyByTail({
                    prefixTokens: sizes.total - sizes.tail,
                    totalTokens: total,
                    currentTokens,
                    softLine: budget.softLine,
                });
            return { verdict: tailOnly ? 'fits' : verdict, sizes };
        };
        const projected = this.core.footprint(route.model, candidate.messages, snapshot).inputTokens + growth;
        const first = checkSize(projected);
        if (first.verdict !== 'fits') {
            return { kind: 'rejected', reason: first.verdict, ...sizesField(first.sizes) };
        }
        if (projected + (input.expectedExtraTokens ?? 0) > budget.hardLine) {
            return { kind: 'deferred' };
        }
        let external = input.external;
        if (!external) {
            external = await writeExternalState({ ports: this.core.ports, sessionId, generated });
            // The header lists the ledger as the delta just left it.
            candidate = await build(nowMs);
            growth = 0;
        }
        const after = this.core.footprint(route.model, candidate.messages, snapshot);
        // Only a ledger that renders past its share gets here; its entries stay written-not-in-header.
        const final = checkSize(after.inputTokens);
        if (final.verdict !== 'fits') {
            return { kind: 'rejected', reason: final.verdict, ...sizesField(final.sizes) };
        }
        const written = external;
        const committedCandidate = candidate;
        return {
            kind: 'ready',
            external: written,
            commit: {
                result: segmentCommitResult({
                    compactionId: generated.compactionId,
                    summary: candidate.prefix.header.summary,
                    messages: candidate.messages,
                    messagesBefore: input.active.length,
                    before,
                    after,
                    segment: {
                        sourceIndexes: candidate.sourceIndexes,
                        coveredCount: generated.coveredCount,
                        prefixDigest: generated.prefixDigest,
                        expectedSegmentId: generated.segmentId,
                        background: input.background,
                    },
                }),
                afterCommit: () => this.afterSegmentCommitted(sessionId, {
                    generated,
                    candidate: committedCandidate,
                    external: written,
                    background: input.background,
                    ...(final.sizes ? { overLine: final.sizes } : {}),
                }),
            },
        };
    }
    /**
     * What a candidate of `total` tokens weighs by part: the system layer, the rebuilt prefix
     * (header grown by `growth`, then the retained text) and the uncovered tail after it.
     */
    sizeTokensOf(input) {
        const { candidate, route, snapshot } = input;
        const { sectionTokens } = candidate.prefix.header;
        const system = this.core.footprint(route.model, [], snapshot).inputTokens;
        const prefix = this.core.footprint(route.model, candidate.prefix.messages, snapshot).inputTokens +
            input.growth;
        return {
            summary: sectionTokens.summary,
            ledger: sectionTokens.ledger,
            spaces: sectionTokens.spaces,
            status: sectionTokens.status,
            // The header is the prefix's first message; the retained text follows it.
            retained: this.core.counter.countMessages(candidate.prefix.messages.slice(1)),
            system,
            tail: Math.max(0, input.total - prefix),
            total: input.total,
            softLine: input.budget.softLine,
        };
    }
    async afterSegmentCommitted(sessionId, committed) {
        const { generated, candidate, external, background, overLine } = committed;
        const state = this.core.state(sessionId);
        if (state.replacePending?.generated === generated)
            state.replacePending = undefined;
        const ledgerSkips = external.ledger.skipped.length;
        traceSegmentCompaction(this.core.ports.trace, sessionId, undefined, {
            ...generatedFields(generated),
            outcome: 'committed',
            background,
            // Failures counted in the segment this result replaces; the new segment starts at 0.
            failureCount: state.failures,
            ledgerDeltaCount: generated.references.ledger.length,
            ledgerDroppedCount: generated.references.droppedLedger + ledgerSkips,
            ...(external.ledger.revisionChanged ? { ledgerRevalidatedSkipCount: ledgerSkips } : {}),
            mediaCount: generated.references.media.length,
            ...(overLine ? { tailOverSoftLine: true, sizeTokens: overLine } : {}),
        });
        await this.startSegment(sessionId, {
            headerLedgerIds: candidate.headerLedgerIds,
            prefixLength: rebuiltPrefixLength(candidate.sourceIndexes, generated.coveredCount),
            rebuildReason: generated.trigger,
            generated,
        });
    }
    /** A rebuilt segment is durable: the Session starts it with no failures (4.8, 11.8). */
    async startSegment(sessionId, committed) {
        const { headerLedgerIds, generated } = committed;
        const state = this.core.state(sessionId);
        const previousSegmentId = state.segmentId ?? null;
        const turns = state.turnsInSegment;
        this.core.clearFailures(state);
        state.turnsInSegment = 0;
        state.segmentId = undefined;
        await Promise.all([
            generated ? this.storeMedia(sessionId, generated) : undefined,
            headerLedgerIds.length > 0
                ? settle(() => this.core.ports.ledger.markInHeader(sessionId, headerLedgerIds))
                : undefined,
        ]);
        const segment = await settle(() => this.core.ports.history.readSegment(sessionId));
        const segmentId = segment?.segmentId ?? null;
        state.segmentId = segmentId;
        state.segmentPrefixLength = committed.prefixLength;
        if (segmentId) {
            traceSegmentChange(this.core.ports.trace, sessionId, undefined, {
                previousSegmentId,
                segmentId,
                turnCount: turns,
                rebuildReason: committed.rebuildReason,
            });
        }
        return segmentId;
    }
    /** Media descriptions of a committed result: the stored descriptions, then the search index. */
    async storeMedia(sessionId, generated) {
        const media = generated.references.media;
        if (media.length === 0)
            return;
        await settle(() => this.core.ports.mediaDescriptions?.upsert(sessionId, media, generated.compactionId));
        await settle(() => this.core.ports.searchIndex?.writeMediaDescriptions(sessionId, media));
    }
}
function sizesField(sizes) {
    return sizes ? { sizeTokens: sizes } : {};
}
async function settle(run) {
    try {
        return await run();
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=commit.js.map