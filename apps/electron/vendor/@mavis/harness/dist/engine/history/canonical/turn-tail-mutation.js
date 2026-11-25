import { isSettledHistoryPrefix, unsettledToolRecordKeys } from '../history-records.js';
import { sameJson } from './canonical-record.js';
/** Plans the abort/network/safety/reply tail fold against the latest active records. */
export function planSettleTurnTail(active, input, rules = {}) {
    assertMutationIdentity(input);
    if (input.mode === 'safety')
        return planSafetyTurnTail(active, input, rules);
    if (input.mode === 'reply')
        return planReplyTurnTail(active, input, rules);
    const last = active.at(-1);
    if (!last || last.turn_id !== input.turnId || last.message.role !== 'assistant') {
        return unchangedSettle(active);
    }
    if (input.mode === 'abort' && containsToolCall(last.message['content'])) {
        return unchangedSettle(active);
    }
    const next = [...active];
    const approvedContent = input.approvedContent;
    const deletedMessageIds = [];
    if (!approvedContent.trim()) {
        next.pop();
        deletedMessageIds.push(last.message_id);
    }
    else {
        next[next.length - 1] = {
            ...last,
            message: {
                ...last.message,
                content: [{ type: 'text', text: approvedContent }],
            },
        };
    }
    if (sameJson(active, next))
        return unchangedSettle(active);
    assertSettled(next, active, 'Turn tail settlement', rules);
    return { status: 'committed', active: next, deletedMessageIds };
}
function planSafetyTurnTail(active, input, rules) {
    if (active.at(-1)?.turn_id !== input.turnId)
        return unchangedSettle(active);
    const sanitize = rules.sanitizeSafetyMessage;
    if (!sanitize)
        throw new Error('Safety Turn tail settlement requires a Host sanitizer');
    const deletedMessageIds = [];
    const next = active.flatMap((record) => {
        if (record.turn_id !== input.turnId)
            return [record];
        const message = sanitize(record.message);
        if (message)
            return [{ ...record, message }];
        deletedMessageIds.push(record.message_id);
        return [];
    });
    if (sameJson(active, next))
        return unchangedSettle(active);
    assertSettled(next, active, 'Safety Turn tail settlement', rules);
    return { status: 'committed', active: next, deletedMessageIds };
}
/**
 * 输出被拦只删被拦的那一条。agent-core 不会把被拦的回复写进历史，通常什么都不用删；它若作为
 * 本轮最后一条（出错结束的 assistant）留在历史里，就连同它带的、没执行过的工具调用一起删掉。
 * 不像 network 那样删本轮最后一条 assistant：那可能是正常结束的回复。
 */
function planReplyTurnTail(active, input, rules) {
    const last = active.at(-1);
    if (!last || last.turn_id !== input.turnId || !isFailedAssistantReply(last.message)) {
        return unchangedSettle(active);
    }
    const next = active.slice(0, -1);
    assertSettled(next, active, 'Withdrawn reply settlement', rules);
    return { status: 'committed', active: next, deletedMessageIds: [last.message_id] };
}
function isFailedAssistantReply(message) {
    return message.role === 'assistant' && Reflect.get(message, 'stopReason') === 'error';
}
/** Plans a target-Turn suffix removal across the reachable compaction lineage. */
export function planRetractTurn(history, input, rules = {}) {
    validateRetractTurnInput(input);
    const artifacts = [
        ...history.snapshots.map(({ generation, records }) => ({ generation, records })),
        { generation: history.activeGeneration, records: history.active },
    ];
    const artifactIndex = artifacts.findIndex(({ records }) => records.some(({ turn_id }) => turn_id === input.turnId));
    if (artifactIndex < 0) {
        if (containsCompactionMarker(artifacts, input.turnId)) {
            throw new Error('Retracted Turn source boundary is missing from canonical history');
        }
        return {
            status: 'already-retracted',
            generation: history.activeGeneration,
            active: history.active,
            snapshots: history.snapshots,
            deletedMessageIds: [],
        };
    }
    const target = artifacts[artifactIndex];
    if (!target)
        throw new Error('Retracted Turn source boundary is missing from canonical history');
    const firstTargetIndex = target.records.findIndex(({ turn_id }) => turn_id === input.turnId);
    const targetSuffix = target.records.slice(firstTargetIndex);
    if (targetSuffix.some(({ turn_id }) => turn_id !== input.turnId)) {
        throw new Error('Retracted Turn is not the canonical history tail');
    }
    const active = target.records.slice(0, firstTargetIndex);
    assertTargetIsCurrentTail(history.active, input.turnId, active);
    assertSettled(active, target.records, 'Turn retraction prefix', rules);
    if (target.generation > 0 && active.length === 0) {
        throw new Error('Turn retraction cannot preserve a non-zero generation without its marker');
    }
    return {
        status: 'committed',
        generation: target.generation,
        active,
        snapshots: history.snapshots.slice(0, Math.min(artifactIndex, history.snapshots.length)),
        deletedMessageIds: deletedTurnMessageIds(artifacts.slice(artifactIndex).flatMap(({ records }) => records), input.turnId, active),
    };
}
export function validateRetractTurnInput(input) {
    assertMutationIdentity(input);
    assertRetractReason(input.reason);
}
function assertMutationIdentity(input) {
    if (!input.sessionId.trim() || !input.turnId.trim() || !input.operationId.trim()) {
        throw new TypeError('Turn history mutation identity is required');
    }
}
function assertRetractReason(reason) {
    if (reason.kind === 'output-attempt-recall' &&
        (!Number.isSafeInteger(reason.attempt) || reason.attempt < 1)) {
        throw new TypeError('Output recall attempt must be a positive safe integer');
    }
}
function unchangedSettle(active) {
    return { status: 'unchanged', active, deletedMessageIds: [] };
}
function containsToolCall(content) {
    return (Array.isArray(content) &&
        content.some((block) => typeof block === 'object' &&
            block !== null &&
            !Array.isArray(block) &&
            Reflect.get(block, 'type') === 'toolCall'));
}
function containsCompactionMarker(artifacts, turnId) {
    const markerTurnId = `${turnId}:compaction`;
    return artifacts.some(({ records }) => records.some(({ turn_id }) => turn_id === markerTurnId));
}
/**
 * No later Turn follows the target in the active history. A compaction in the
 * target Turn, including a segment commit at its start, writes its records
 * under `<turnId>:compaction` and carries earlier records over verbatim; those
 * carried records stay after the retraction and do not end the Turn's tail.
 */
function assertTargetIsCurrentTail(active, turnId, retained) {
    const markerTurnId = `${turnId}:compaction`;
    const retainedIds = new Set(retained.map(({ message_id }) => message_id));
    const boundary = active.findIndex(({ turn_id }) => turn_id === turnId || turn_id === markerTurnId);
    if (boundary < 0 ||
        active
            .slice(boundary)
            .some(({ turn_id, message_id }) => turn_id !== turnId && turn_id !== markerTurnId && !retainedIds.has(message_id))) {
        throw new Error('Retracted Turn is not the canonical history tail');
    }
}
/** The Turn's own records; a compaction record the retraction keeps is not deleted. */
function deletedTurnMessageIds(records, turnId, retained) {
    const markerTurnId = `${turnId}:compaction`;
    const retainedIds = new Set(retained.map(({ message_id }) => message_id));
    return [
        ...new Set(records
            .filter(({ turn_id, message_id }) => (turn_id === turnId || turn_id === markerTurnId) && !retainedIds.has(message_id))
            .map(({ message_id }) => message_id)),
    ];
}
/**
 * A mutation must not unpair tool calls and results. Pairing violations already in `before`
 * (legacy v1 records, interrupted turns) stay as they are instead of blocking the mutation; a Host
 * rule stays strict.
 */
function assertSettled(records, before, operation, rules) {
    if (rules.isSettled ? rules.isSettled(records) : !addsPairingViolation(records, before))
        return;
    throw new Error(`${operation} must produce settled canonical history`);
}
function addsPairingViolation(records, before) {
    if (isSettledHistoryPrefix(records))
        return false;
    const after = unsettledToolRecordKeys(records);
    const existing = new Set(unsettledToolRecordKeys(before));
    return after.some((key) => !existing.has(key));
}
//# sourceMappingURL=turn-tail-mutation.js.map