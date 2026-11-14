import { hasThinkingPrefixBinding, } from '@mavis/agent-core/pi-turn-runner';
import { createDefaultTokenEstimator, } from '@mavis/context-manager';
import { HANDOFF_LEDGER_UNREAD } from '../../../coordinator-text/index.js';
import { requestSegmentCheckpoint } from './checkpoint-request.js';
import { renderSpacesSection, renderStatusSection } from './algorithm/handoff-header.js';
import { parseSegmentCheckpoint } from './algorithm/output-parser.js';
import { buildSegmentPrefix, composeSegmentReplacement, listCoveredAssets, resolveCheckpointReferences, resolveSummaryReferences, } from './algorithm/segment-rebuild.js';
import { buildMessageIndex, readTimestamp, withSegmentRecordFacts, } from './algorithm/transcript.js';
import { segmentPrefixDigestOf } from './algorithm/segment-rebuild.js';
export function createTokenCounter() {
    const estimator = createDefaultTokenEstimator();
    return {
        countText: (text) => estimator.estimateTextTokens(text),
        countMessages: (messages) => estimator.estimateMessages([...messages]),
    };
}
/**
 * Runs the compaction model call over the first `coveredCount` active records
 * and parses the result strictly. Nothing outside memory is written here.
 */
export async function generateRebuild(input) {
    const { ports, sessionId } = input;
    const startedAtMs = input.nowMs();
    const covered = input.records.slice(0, input.coveredCount);
    const facts = await resolveSegmentFacts(ports, sessionId, covered);
    const index = buildMessageIndex(covered, facts);
    const assets = listCoveredAssets(covered, index, facts);
    const ledgerRevision = await ports.ledger.readRevision(sessionId);
    const [entries, writtenNotInHeader, spaces] = await Promise.all([
        ports.ledger.listEntries(sessionId),
        ports.ledger.listWrittenNotInHeader(sessionId),
        settle(() => ports.spaces.listSpaces(), []),
    ]);
    const response = await requestSegmentCheckpoint({
        model: input.route.model,
        streamFn: input.route.streamFn,
        thinkingLevel: input.route.thinkingLevel,
        maxOutputTokens: input.maxOutputTokens,
        ...(input.route.apiKey === undefined ? {} : { apiKey: input.route.apiKey }),
        ...(input.route.headers === undefined ? {} : { headers: input.route.headers }),
        ...(input.route.payloadTransform === undefined
            ? {}
            : { payloadTransform: input.route.payloadTransform }),
        ...(input.sharedPrefix ? { sharedPrefix: input.sharedPrefix } : {}),
        ...(input.mainRequest ? { mainRequest: input.mainRequest } : {}),
        records: covered,
        facts,
        control: {
            index,
            activeLedger: entries.filter((entry) => entry.status === 'active'),
            // Only entries that are still injected: active, or closed within the window.
            writtenNotInHeader: writtenNotInHeader.filter((entry) => isStillInjected(entry, startedAtMs)),
            assets,
            spaces: spaces.map((space) => ({ spaceId: space.spaceId, name: space.name })),
            summaryBudgetTokens: input.summaryBudgetTokens,
        },
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    const parsed = resolveSummaryReferences(parseSegmentCheckpoint(response.text), index);
    return {
        compactionId: input.compactionId,
        trigger: input.trigger,
        segmentId: input.segmentId,
        coveredCount: input.coveredCount,
        prefixDigest: segmentPrefixDigestOf(covered),
        covered,
        parsed,
        references: resolveCheckpointReferences(parsed, index, assets),
        facts,
        ledgerRevision,
        response,
        startedAtMs,
        durationMs: Math.max(0, input.nowMs() - startedAtMs),
        dropThinking: hasThinkingPrefixBinding(input.route.model),
    };
}
/** Strategy version every segment rebuild commits under. */
const SEGMENT_STRATEGY_VERSION = 'bunny-segment-v1';
/** 13.3: closed entries stay injected for 7 days. */
const CLOSED_ENTRY_INJECTION_MS = 7 * 24 * 60 * 60 * 1_000;
function isStillInjected(entry, nowMs) {
    return (entry.status === 'active' ||
        nowMs - (entry.closedAtMs ?? entry.createdAtMs) <= CLOSED_ENTRY_INJECTION_MS);
}
/** Host facts of `records`, each part best effort: what cannot be resolved keeps its default. */
export async function resolveSegmentFacts(ports, sessionId, records) {
    let resolved = {};
    try {
        resolved = (await ports.recordFacts?.resolve(sessionId, records)) ?? {};
    }
    catch {
        resolved = {};
    }
    return withSegmentRecordFacts({
        isDeltaBlock: (message) => ports.deltaBlocks.isDeltaBlock(message),
        ...resolved,
    });
}
/**
 * The ledger could not render its section this time. The header says so rather
 * than claiming the ledger is empty, and carries no entry IDs, so the entries
 * stay on the written-not-in-header list and the next header lists them.
 */
const LEDGER_UNREAD = {
    text: HANDOFF_LEDGER_UNREAD,
    entryIds: [],
    truncated: 0,
};
/**
 * Header material, each part best effort. A part that cannot be read is
 * listed in `unread`: an emergency rebuild's header says so in that section
 * (emergency rebuild spec 7.3), a compaction's renders it as empty.
 */
export async function gatherHeaderMaterial(ports, sessionId, covered, options) {
    const { nowMs, shares, counter, formatTime } = options;
    const unread = [];
    const [status, spaces] = await Promise.all([
        settle(() => ports.status.readSnapshot(sessionId), undefined, () => unread.push('status')),
        settle(() => ports.spaces.listSpaces(), [], () => unread.push('spaces')),
    ]);
    const lastTurnAtMs = [...covered]
        .reverse()
        .map((record) => readTimestamp(record.message))
        .find((value) => value !== undefined);
    const material = {
        ...(status ? { status } : {}),
        spaces,
        segmentStartedAtMs: nowMs,
        ...(lastTurnAtMs === undefined ? {} : { lastTurnAtMs }),
    };
    let spare = 0;
    try {
        spare = spareShare(material, shares, counter, formatTime);
    }
    catch {
        // A section the header cannot measure leaves the ledger its own share only.
    }
    const ledgerSection = await settle(() => ports.ledger.renderHeader(sessionId, shares.ledger + spare), LEDGER_UNREAD, () => unread.push('ledger'));
    return { ...material, ledgerSection, ...(unread.length > 0 ? { unread } : {}) };
}
/**
 * What the status and space sections do not need, which the ledger may use (12.9). Both
 * get a fixed part of B, and a conversation with no open tasks and no spaces leaves them
 * at one line each; without this the ledger drops standing rules while that room goes
 * unused. The total still fits the sum of the shares, because this only hands on what
 * those two sections measured under their own.
 */
function spareShare(material, shares, counter, formatTime) {
    const status = renderStatusSection(material, shares.status, counter, formatTime);
    const spaces = renderSpacesSection(material.spaces, shares.spaces, counter);
    return Math.max(0, shares.status - status.tokens) + Math.max(0, shares.spaces - spaces.tokens);
}
async function settle(read, fallback, failed) {
    try {
        return await read();
    }
    catch {
        failed?.();
        return fallback;
    }
}
/** Builds the full replacement from the current active records; no writes. */
export async function buildCommitCandidate(input) {
    const { generated } = input;
    const material = await gatherHeaderMaterial(input.ports, input.sessionId, generated.covered, {
        nowMs: input.nowMs,
        shares: input.budget.shares,
        counter: input.counter,
        formatTime: input.formatTime,
    });
    const prefix = buildSegmentPrefix({
        coveredRecords: generated.covered,
        checkpoint: generated.parsed,
        material,
        media: generated.references.media,
        shares: input.budget.shares,
        facts: generated.facts,
        counter: input.counter,
        dropThinking: generated.dropThinking,
        tokensBefore: input.tokensBefore,
        timestamp: input.nowMs,
        formatTime: input.formatTime,
    });
    const composed = composeSegmentReplacement(prefix, input.active, generated.coveredCount, (record) => generated.facts.isDeltaBlock(record.message) && !inTurn(record.turnId, input.runningTurnId));
    return {
        prefix,
        messages: composed.messages,
        sourceIndexes: composed.sourceIndexes,
        headerLedgerIds: prefix.header.ledgerShownIds,
    };
}
/** The completed result of a segment rebuild that replaces `messagesBefore` records. */
export function segmentCommitResult(input) {
    return {
        status: 'completed',
        compactionId: input.compactionId,
        strategyVersion: SEGMENT_STRATEGY_VERSION,
        method: 'llm_segment_checkpoint',
        summary: input.summary,
        replacementMessages: input.messages,
        messagesBefore: input.messagesBefore,
        messagesAfter: input.messages.length,
        tokensBefore: input.before.inputTokens,
        tokensAfter: input.after.inputTokens,
        serializedBytesBefore: input.before.serializedBytes,
        serializedBytesAfter: input.after.serializedBytes,
        segment: input.segment,
    };
}
/**
 * Writes the ledger delta in one transaction; runs only after every history
 * check passed (11.7). Each operation carries
 * `<batch>:<n>` so a replay after a failed history replacement is a no-op.
 */
export async function writeExternalState(input) {
    const { ports, sessionId, generated } = input;
    const ledger = await ports.ledger.applyCompactorDelta({
        sessionId,
        batchId: generated.compactionId,
        expectedRevision: generated.ledgerRevision,
        coveredMessageIds: [
            ...new Set(generated.covered.map((record) => generated.facts.displayMessageId(record))),
        ],
        operations: generated.references.ledger.map((operation, index) => ({
            ...operation,
            operationId: `${generated.compactionId}:${String(index + 1)}`,
        })),
    });
    return { ledger };
}
function inTurn(recordTurnId, turnId) {
    return turnId !== undefined && (recordTurnId === turnId || recordTurnId.startsWith(`${turnId}:`));
}
/** The main request's prefix, when the hook's request can share it. */
export function sharedSnapshot(input, snapshot) {
    return input.systemPrompt === undefined ? undefined : snapshot;
}
/** The rebuild route: the model, transport and payload transform of the Turn's own request. */
export function routeFromHook(input, sharedPrefixAllowed) {
    if (!input.streamFn)
        throw new TypeError('Bunny compaction requires the Host stream function.');
    return {
        model: input.model,
        streamFn: input.streamFn,
        thinkingLevel: input.thinkingLevel,
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        ...((input.auxiliaryPayloadTransform ?? input.payloadTransform)
            ? { payloadTransform: input.auxiliaryPayloadTransform ?? input.payloadTransform }
            : {}),
        sharedPrefixAllowed,
    };
}
/** Archived tool results can be read back only when the Turn has the `read` tool. */
/** Trace fields of a generated rebuild. */
export function generatedFields(generated) {
    return {
        trigger: generated.trigger,
        requestShape: generated.response.shape,
        segmentId: generated.segmentId,
        coveredCount: generated.coveredCount,
        durationMs: generated.durationMs,
        cacheReadTokens: generated.response.cacheReadTokens,
        cacheWriteTokens: generated.response.cacheWriteTokens,
        inputTokens: generated.response.inputTokens,
        outputTokens: generated.response.outputTokens,
        ...lowCacheDifference(generated.response),
    };
}
/**
 * Below half of the input read from cache, the trace says where the
 * compaction request first left the last main request's prefix (dogfood
 * fixes spec 8.2).
 */
function lowCacheDifference(response) {
    const { prefixDifference, cacheReadTokens, cacheWriteTokens, inputTokens } = response;
    const total = inputTokens + cacheReadTokens + cacheWriteTokens;
    if (!prefixDifference || total === 0 || cacheReadTokens * 2 >= total)
        return {};
    return { prefixDifference };
}
/** The rebuild request hit its own timeout. */
export function isTimeout(error) {
    return error instanceof Error && Reflect.get(error, 'reason') === 'timeout';
}
/** Short trace reason for a failed rebuild. */
export function failureReason(error) {
    if (error instanceof Error) {
        const reason = Reflect.get(error, 'reason');
        if (typeof reason === 'string')
            return reason;
        if (error.name === 'SegmentCheckpointFormatError')
            return 'invalid_format';
        return error.message.slice(0, 120) || error.name;
    }
    return 'unknown';
}
//# sourceMappingURL=rebuild-pipeline.js.map