import { createHash } from 'node:crypto';
import { buildHeaderMessage, renderHandoffHeader, } from './handoff-header.js';
import { planRetention } from './retention.js';
/**
 * Maps message numbers back to display message IDs (12.3). An entry whose
 * source is not a numbered message of the covered range is dropped on its
 * own; the rest of the result stays valid (11.10).
 */
export function resolveCheckpointReferences(parsed, index, assets) {
    const byNumber = new Map(index.map((entry) => [entry.number, entry]));
    const ledger = [];
    let droppedLedger = 0;
    for (const operation of parsed.ledger) {
        if (operation.source === undefined) {
            ledger.push(operation);
            continue;
        }
        const entry = byNumber.get(operation.source);
        if (!entry) {
            droppedLedger += 1;
            continue;
        }
        ledger.push({
            ...operation,
            sourceMessageId: entry.displayMessageId,
            ...(entry.timestamp === undefined ? {} : { sourceAtMs: entry.timestamp }),
        });
    }
    const assetsById = new Map(assets.map((asset) => [asset.assetId, asset]));
    const media = [];
    let droppedMedia = 0;
    const described = new Set();
    for (const item of parsed.media) {
        const asset = assetsById.get(item.assetId);
        if (!asset || described.has(item.assetId)) {
            droppedMedia += 1;
            continue;
        }
        described.add(item.assetId);
        media.push({
            assetId: item.assetId,
            messageId: asset.messageId,
            description: item.description,
            seen: item.seen,
        });
    }
    return { ledger, media, droppedLedger, droppedMedia };
}
/** "消息 12", "消息 3–5、9", "message #7": a message word, then numbers, ranges and lists. */
const SUMMARY_MESSAGE_REFERENCE = /(?:消息|messages?)\s*#?\d+(?:\s*[–—~\-至到、,，]\s*#?\d+)*/giu;
/**
 * Message numbers in free text are valid only for this compaction's index, so
 * they become display message IDs, which `conversation_read` opens and later
 * compactions carry over unchanged (12.2). Covers the summary sections and the
 * text and closing notes of ledger operations, which outlive this segment in the ledger. A
 * number outside the index stays as written.
 */
export function resolveSummaryReferences(parsed, index) {
    const byNumber = new Map(index.map((entry) => [entry.number, entry.displayMessageId]));
    const resolve = (reference) => reference.replace(/#?(\d+)/gu, (number, digits) => {
        const id = byNumber.get(Number(digits));
        return id === undefined ? number : `[${id}]`;
    });
    const resolveText = (text) => text.replace(SUMMARY_MESSAGE_REFERENCE, resolve);
    return {
        ...parsed,
        sections: parsed.sections.map((section) => ({
            ...section,
            body: resolveText(section.body),
        })),
        ledger: parsed.ledger.map((operation) => {
            if ('text' in operation)
                return { ...operation, text: resolveText(operation.text) };
            return operation.note === undefined
                ? operation
                : { ...operation, note: resolveText(operation.note) };
        }),
    };
}
/** Every attachment of a numbered user message in the covered range. */
export function listCoveredAssets(records, index, facts) {
    const seen = new Set();
    return index.flatMap((entry) => {
        if (entry.role !== 'user' || seen.has(entry.recordIndex))
            return [];
        seen.add(entry.recordIndex);
        const record = records[entry.recordIndex];
        if (!record)
            return [];
        return facts.assetsOf(record).map((asset) => ({
            ...asset,
            source: entry.number,
            messageId: entry.displayMessageId,
        }));
    });
}
/** Builds the replacement of the covered range: handoff header and retained text (11.4). */
export function buildSegmentPrefix(input) {
    const header = renderHandoffHeader({
        checkpoint: input.checkpoint,
        material: input.material,
        shares: input.shares,
        counter: input.counter,
        formatTime: input.formatTime,
    });
    const retention = planRetention({
        records: input.coveredRecords,
        facts: input.facts,
        counter: input.counter,
        recentTurnsTokens: input.shares.recentTurns,
        userWordsTokens: input.shares.userWords,
        mediaDescriptions: new Map(input.media.map((item) => [item.assetId, item.description])),
        dropThinking: input.dropThinking,
        timestamp: input.timestamp,
    });
    return {
        messages: [
            buildHeaderMessage(header.summary, input.tokensBefore, input.timestamp),
            ...retention.items.map((item) => item.message),
        ],
        sourceIndexes: [
            null,
            ...retention.items.map((item) => (item.kind === 'source' ? item.index : null)),
        ],
        header,
        retention,
    };
}
/**
 * The full replacement at commit time: the rebuilt prefix followed by every
 * active record after the covered range, unchanged and in order (11.3), less
 * the old delta blocks `dropAfter` names: a kept Turn loses its delta block,
 * only the running Turn keeps its own (9.1, 11.4).
 */
export function composeSegmentReplacement(prefix, active, coveredCount, dropAfter = () => false) {
    const after = active
        .slice(coveredCount)
        .map((record, offset) => ({ record, index: coveredCount + offset }))
        .filter(({ record }) => !dropAfter(record));
    return {
        messages: [...prefix.messages, ...after.map(({ record }) => record.message)],
        sourceIndexes: [...prefix.sourceIndexes, ...after.map(({ index }) => index)],
    };
}
/** 11.6: the result must fit 80% of the soft line and must not grow the request. */
export function checkSegmentSize(input) {
    if (input.afterTokens > Math.floor(input.softLine * 0.8))
        return 'over_soft_line';
    if (input.afterTokens > input.currentTokens)
        return 'not_smaller';
    return 'fits';
}
/**
 * sha256 of the covered records, byte-for-byte the digest the history lane
 * recomputes at commit (`segment-prefix.ts` in the session system): any edit,
 * rewind or replacement inside the range changes it.
 */
export function segmentPrefixDigestOf(records) {
    const hash = createHash('sha256');
    for (const record of records) {
        hash.update(JSON.stringify([record.messageId, record.turnId, record.message]));
        hash.update('\n');
    }
    return `sha256:${hash.digest('hex')}`;
}
//# sourceMappingURL=segment-rebuild.js.map