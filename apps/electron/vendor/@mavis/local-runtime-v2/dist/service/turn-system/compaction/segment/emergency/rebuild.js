import { randomUUID } from 'node:crypto';
import { hasThinkingPrefixBinding, } from '@mavis/agent-core/pi-turn-runner';
import { segmentPrefixDigestOf } from '../algorithm/segment-rebuild.js';
import { failureReason, gatherHeaderMaterial, resolveSegmentFacts, segmentCommitResult, } from '../rebuild-pipeline.js';
import { assembleEmergencySegment, planEmergencyEntries } from './compose.js';
import { applyRebuildLevel } from './content.js';
import { fitSoftLine } from './fit.js';
import { readCarriedHandoff, renderIncident } from './handoff.js';
/**
 * Spec 4: the segment an emergency rebuild opens, built without a model
 * call over the whole active history and committed in one replacement,
 * shown nowhere. The level replaces what the failure points at (4.4), and
 * the request is fitted under the soft line (4.3, 4.5). A fixed prefix over
 * the input limit is not rebuilt (2.3); a rebuild that cannot be made fails
 * the request, and the Turn reports the failure it replaced (3.7).
 */
export async function emergencyRebuild(host, input) {
    const { sessionId, turnId, request, emergency } = input;
    const pending = emergency.pendingRebuild;
    if (!pending)
        return { kind: 'fail', reason: 'bunny_emergency_rebuild_not_requested' };
    const snapshot = { systemPrompt: request.systemPrompt ?? '', tools: request.tools ?? [] };
    const { model } = request;
    // The step a failure is put down to; the segment limit's write is the last one.
    let step = 'build';
    try {
        const budget = host.budget(routeOf(request), snapshot);
        if (host.footprint(model, [], snapshot).inputTokens > budget.providerInputLimit) {
            emergency.rebuildNotMade({ result: 'fixed_prefix_over_limit' });
            return { kind: 'fail', reason: 'bunny_fixed_prefix_over_limit' };
        }
        await input.hooks.onEmergencyRebuildStarted();
        const current = await host.ports.history.readSegment(sessionId);
        if (current.records.length !== request.canonicalMessages.length) {
            throw new Error('history_not_aligned');
        }
        const tailStart = host.prepare(sessionId, turnId, current);
        const nowMs = host.now();
        const { formatTime, counter } = host;
        const { level } = pending.classification;
        const files = host.ports.emergencyFiles;
        const before = host.footprint(model, current.records.map((record) => record.message), snapshot);
        const facts = await resolveSegmentFacts(host.ports, sessionId, current.records);
        const descriptions = await describedAssets(host, sessionId);
        const levelled = await applyRebuildLevel({
            level,
            entries: planEmergencyEntries({
                records: current.records,
                tailStart,
                turnId,
                facts,
                level,
                shares: budget.shares,
                counter,
                descriptions,
                dropThinking: hasThinkingPrefixBinding(model),
                timestamp: nowMs,
            }),
            sessionId,
            facts,
            descriptions,
            files,
        });
        const carried = readCarriedHandoff(current.records);
        const material = await gatherHeaderMaterial(host.ports, sessionId, current.records.slice(0, tailStart), { nowMs, shares: budget.shares, counter, formatTime });
        const incident = incidentOf(pending, turnId);
        const assemble = (entries, replaced) => assembleEmergencySegment({
            entries,
            level,
            carried,
            incident: renderIncident({ ...incident, replaced: replaced.counts, affected: replaced.affected }, formatTime, counter),
            material,
            shares: budget.shares,
            counter,
            tokensBefore: before.inputTokens,
            timestamp: nowMs,
            formatTime,
        });
        const fitted = await fitSoftLine({
            entries: levelled.entries,
            replaced: levelled.replaced,
            softLine: budget.softLine,
            sessionId,
            facts,
            counter,
            files,
            timestamp: nowMs,
            measure: (entries, replaced) => host.footprint(model, assemble(entries, replaced).messages, snapshot).inputTokens,
        });
        const segment = assemble(fitted, levelled.replaced);
        const after = host.footprint(model, segment.messages, snapshot);
        // 4.6: the rebuilt request must fit the soft line.
        if (after.inputTokens > budget.softLine)
            throw new Error('over_soft_line');
        if (request.signal?.aborted)
            return { kind: 'fail', reason: 'stopped' };
        // A rebuild whose limit and identifier cannot be kept is not made (3.5, 3.7, 9.1).
        step = 'state';
        await host.rebuildCommitting(sessionId, current.segmentId);
        const commit = {
            result: segmentCommitResult({
                compactionId: `bunny_emergency_${randomUUID()}`,
                summary: segment.header.summary,
                messages: segment.messages,
                messagesBefore: current.records.length,
                before,
                after,
                segment: {
                    sourceIndexes: segment.sourceIndexes,
                    coveredCount: current.records.length,
                    prefixDigest: segmentPrefixDigestOf(current.records),
                    expectedSegmentId: current.segmentId,
                    background: true,
                    hidden: true,
                },
            }),
            afterCommit: async () => {
                const segmentId = await host.startSegment(sessionId, {
                    headerLedgerIds: segment.header.ledgerShownIds,
                    prefixLength: segment.turnStart,
                });
                await host.rebuildCommitted(sessionId, segmentId ?? undefined);
                const backupFile = await host.latestBackup(sessionId);
                emergency.rebuildCommitted({
                    replaced: { ...levelled.replaced.counts },
                    affinityRotated: true,
                    ...(backupFile ? { backupFile } : {}),
                });
            },
        };
        return { kind: 'replace', commit };
    }
    catch (error) {
        emergency.rebuildNotMade({
            result: 'rebuild_failed',
            reason: rebuildFailureReason(step, error),
        });
        return { kind: 'fail', reason: `bunny_emergency_rebuild_failed:${failureReason(error)}` };
    }
}
/** Why a rebuild that threw was not made (dogfood fixes spec 5.5). */
function rebuildFailureReason(step, error) {
    if (step === 'state')
        return 'state_write_failed';
    const message = error instanceof Error ? error.message : '';
    if (message === 'history_not_aligned' || message === 'over_soft_line')
        return message;
    // A Node file-system error names its code (ENOSPC, EACCES, ...).
    const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
    return typeof code === 'string' && /^E[A-Z]+$/u.test(code) ? 'file_write_failed' : 'build_failed';
}
/** Stored media descriptions (4.2); none when they cannot be read. */
async function describedAssets(host, sessionId) {
    try {
        return (await host.ports.mediaDescriptions?.describedAssets?.(sessionId)) ?? new Map();
    }
    catch {
        return new Map();
    }
}
function routeOf(request) {
    return {
        model: request.model,
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    };
}
/** The note this rebuild adds to the incident section (spec 5.1). */
function incidentOf(pending, turnId) {
    const { classification } = pending;
    return {
        occurredAtMs: pending.failedAtMs,
        turnId,
        category: classification.category,
        ...(classification.errorCode === undefined ? {} : { errorCode: classification.errorCode }),
        excerpt: classification.excerpt,
        level: classification.level,
        replaced: {},
        ...(pending.repair ? { repair: pending.repair } : {}),
    };
}
//# sourceMappingURL=rebuild.js.map