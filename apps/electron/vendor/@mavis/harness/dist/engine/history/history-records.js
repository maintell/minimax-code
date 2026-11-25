import { BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE, isBackgroundTaskReadSettlement, isStateDeltaMessage, readBackgroundTaskOriginMetadata, } from '../../agent-host/contracts.js';
import { IncrementalSha256 } from '../../agent-host/history/incremental-sha256.js';
import { appendCompactionState, readCompactionCompatibility } from '../../compaction/index.js';
/**
 * True when every Assistant tool call is followed by its results. Hosts validate
 * record format on read; a pairing violation in a derived prefix fails closed.
 */
export function isSettledHistoryPrefix(records) {
    return unsettledToolRecordKeys(records).length === 0;
}
/**
 * Each tool pairing violation, named by the record that carries it: a result without its call,
 * or a call of an Assistant record left without its result. Empty exactly when the records are
 * settled, so a mutation can tell the violations it would add from the ones its input already
 * had. Settled records produce no keys.
 */
export function unsettledToolRecordKeys(records) {
    const keys = [];
    let owner = '';
    let pending = new Set();
    const unanswered = () => {
        pending.forEach((callId) => keys.push(JSON.stringify(['call', owner, callId])));
    };
    for (const { message_id, message } of records) {
        if (message.role === 'toolResult') {
            const callId = toolResultCallId(message);
            if (!callId || !pending.delete(callId))
                keys.push(JSON.stringify(['result', message_id]));
            continue;
        }
        unanswered();
        owner = message_id;
        pending = new Set(assistantToolCallIds(message));
    }
    unanswered();
    return keys;
}
export function assistantToolCallIds(message) {
    if (message?.role !== 'assistant')
        return [];
    const content = message['content'];
    if (!Array.isArray(content))
        return [];
    return content.flatMap((block) => {
        if (!isRecord(block) || block['type'] !== 'toolCall')
            return [];
        const id = block['id'];
        return typeof id === 'string' && id ? [id] : [];
    });
}
export function toolResultCallId(message) {
    if (message?.role !== 'toolResult')
        return undefined;
    const callId = message['toolCallId'];
    return typeof callId === 'string' && callId ? callId : undefined;
}
/**
 * Pairs each Assistant tool call with the contiguous results right after it, the rule of
 * `isSettledHistoryPrefix`. Drops calls without a result, Assistant messages left empty by
 * that, and results without a call; the output is settled and depends only on the input.
 * Compaction's `settleToolRoundHistory` (compaction/algorithm/history-reduction.ts) is stricter on
 * purpose: it follows `parseToolRounds`, which also needs a call name and unique call ids.
 */
export function withoutUnpairedToolCalls(records) {
    const retained = [];
    let start = 0;
    while (start < records.length) {
        let end = start + 1;
        while (records[end]?.message.role === 'toolResult')
            end += 1;
        retained.push(...pairedToolGroup(records[start], records.slice(start + 1, end)));
        start = end;
    }
    return retained;
}
/** `results` are the toolResult records directly after `head`. */
function pairedToolGroup(head, results) {
    if (!head || head.message.role === 'toolResult')
        return [];
    const unanswered = new Set(assistantToolCallIds(head.message));
    const paired = results.filter((result) => {
        const callId = toolResultCallId(result.message);
        return callId !== undefined && unanswered.delete(callId);
    });
    const kept = withoutToolCalls(head, unanswered);
    return kept ? [kept, ...paired] : [];
}
function withoutToolCalls(record, callIds) {
    const content = record.message['content'];
    if (callIds.size === 0 || !Array.isArray(content))
        return record;
    const kept = content.filter((block) => !isRecord(block) ||
        block['type'] !== 'toolCall' ||
        typeof block['id'] !== 'string' ||
        !callIds.has(block['id']));
    return kept.length > 0 ? { ...record, message: { ...record.message, content: kept } } : undefined;
}
/**
 * Drops source-only Background state: typed cadence reminders, read settlements,
 * automatic Background Turns (back to the last settled record) and the cadence
 * checkpoint inside a compaction summary. A copy is not Bunny's main
 * conversation, so it also drops the delta blocks (spec 9.4).
 */
export function withoutSourceBackgroundReminders(records) {
    const retained = [];
    const suppressedTurnIds = new Set();
    for (const record of records) {
        if (suppressedTurnIds.has(record.turn_id))
            continue;
        if (isTypedBackgroundReminder(record.message) ||
            isBackgroundTaskReadSettlement(record.message) ||
            isStateDeltaMessage(record.message)) {
            continue;
        }
        if (!isAutomaticBackgroundReminder(record.message)) {
            retained.push(withoutSourceBackgroundCheckpoint(record));
            continue;
        }
        while (retained.at(-1)?.turn_id === record.turn_id && !isSettledHistoryPrefix(retained)) {
            retained.pop();
        }
        suppressedTurnIds.add(record.turn_id);
    }
    return retained;
}
export function isTypedBackgroundReminder(message) {
    return (message.role === 'custom' &&
        message['customType'] === BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE &&
        message['display'] === false);
}
function isAutomaticBackgroundReminder(message) {
    return message.role === 'user' && readBackgroundTaskOriginMetadata(message) !== undefined;
}
function withoutSourceBackgroundCheckpoint(record) {
    if (record.message.role !== 'compactionSummary')
        return record;
    const compatibility = readCompactionCompatibility(record.message);
    if (!compatibility?.backgroundCadence)
        return record;
    const retainedCompatibility = { ...compatibility };
    Reflect.deleteProperty(retainedCompatibility, 'backgroundCadence');
    const { summary, ...retained } = retainedCompatibility;
    return {
        ...record,
        message: { ...record.message, summary: appendCompactionState(summary, retained) },
    };
}
/**
 * Archives oldest first, then the active history; `preferLatest` searches newest
 * first. Without a boundary the active history is the artifact.
 */
export function findHistoryArtifact(source, boundary, preferLatest = false) {
    if (!boundary)
        return { generation: source.activeGeneration, records: source.active };
    const artifacts = [
        ...[...source.snapshots]
            .sort((left, right) => left.generation - right.generation)
            .map(({ generation, records }) => ({ generation, records })),
        { generation: source.activeGeneration, records: source.active },
    ];
    if (preferLatest)
        artifacts.reverse();
    return artifacts.find((artifact) => artifact.records.some((record) => record.message_id === boundary));
}
export function containsHistoryMessage(source, messageId) {
    return (source.active.some((record) => record.message_id === messageId) ||
        source.snapshots.some((snapshot) => snapshot.records.some((record) => record.message_id === messageId)));
}
export function snapshotsBefore(source, generation) {
    // Ancestor snapshots are immutable, revision-linked archives, not live context.
    return source.snapshots.filter((snapshot) => snapshot.generation < generation).map(copySnapshot);
}
export function copySnapshot(snapshot) {
    return { ...snapshot, records: snapshot.records };
}
export function historyRecords(snapshots, active) {
    return [...snapshots.flatMap((snapshot) => snapshot.records), ...active];
}
export function createContinuationRecord(operationId, continuation) {
    return {
        message_id: `msg-fork-reminder-${sha256Prefix(operationId)}`,
        turn_id: `control:${operationId}`,
        message: {
            role: 'user',
            timestamp: 0,
            content: `<system-reminder>\nThis conversation was forked into an isolated Git worktree.\nAll committed, staged, unstaged, and untracked changes from the source worktree were carried over.\nPrevious workspace: ${continuation.previousWorkspaceDir}\nCurrent workspace: ${continuation.currentWorkspaceDir}\nCurrent branch: ${continuation.currentBranch}\nUse the current workspace for all subsequent file and tool operations.\n</system-reminder>`,
        },
    };
}
/** Durable hidden boundary; identity is stable for the same operation and content. */
export function createHiddenContextBoundaryRecord(operationId, boundary) {
    return {
        message_id: `msg-hidden-context-boundary-${sha256Prefix(`${operationId}:${boundary.kind}:${boundary.content}`)}`,
        turn_id: `control:${operationId}`,
        message: {
            role: 'custom',
            timestamp: 0,
            customType: boundary.kind,
            display: false,
            content: boundary.content,
        },
    };
}
function sha256Prefix(value) {
    const hash = new IncrementalSha256();
    hash.update(value);
    return hash.digestHex().slice(0, 24);
}
export function unique(values) {
    return [...new Set(values)];
}
export function isStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=history-records.js.map