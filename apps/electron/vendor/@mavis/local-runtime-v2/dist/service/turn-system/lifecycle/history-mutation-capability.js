import { createHash } from 'node:crypto';
import { canonicalActiveHistoryRevision, inspectCanonicalHistorySequence, createSideChatModeMessage, isSideChatModeMessage, } from '../../session-system/index.js';
import { forgetToolSearchAnnouncements } from '@mavis/agent-tools/mcp-disclosure';
import { forgetSkillCatalogAnnouncements } from '@mavis/agent-tools/skill-catalog-window';
import { BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE, createHiddenContextBoundaryRecord, historyMutationErrorOf, HistoryMutationError, isRecallPointersMessage, isStateDeltaMessage, WAKE_LINE_CUSTOM_TYPE, withoutSourceBackgroundReminders, } from '@mavis/harness';
export { HistoryMutationError };
const DEFAULT_BOUNDARY_WAIT_TIMEOUT_MS = 5_000;
export function createHistoryMutationCapability(options) {
    return {
        prepareSideChat: (input) => prepareSideChat(options, input),
        fork: (input) => fork(options, input),
        inspectForkBoundary: (input) => inspectForkBoundary(options, input),
        rewind: (input) => rewind(options, input),
    };
}
async function prepareSideChat(options, input) {
    const frozen = await options.sessions.readFrozen(input.sourceSessionId, async (source, snapshots) => {
        const inspection = inspectCanonicalHistorySequence(source.active);
        const prefix = withoutSourceBackgroundReminders(source.active.slice(0, inspection.status === 'settled' ? source.active.length : inspection.settledPrefixLength));
        const sourceMessageId = prefix.at(-1)?.message_id;
        const snapshot = {
            active: prefix,
            snapshots: source.snapshots,
            historyRevision: canonicalActiveHistoryRevision(prefix),
            ...(sourceMessageId ? { sourceMessageId } : {}),
            forEachSnapshotRecord: snapshots.forEach,
        };
        const captured = await input.captureDisplay(snapshot);
        return {
            active: prefix,
            snapshots: source.snapshots,
            historyRevision: snapshot.historyRevision,
            ...(sourceMessageId ? { sourceMessageId } : {}),
            generation: source.activeGeneration,
            ...captured,
        };
    }, input.signal);
    input.signal?.throwIfAborted();
    const boundary = createHiddenContextBoundaryRecord(`sidechat:${input.target.sessionId}`, {
        kind: 'sidechat_context_boundary',
        content: '<system-reminder>Messages above this boundary are a frozen copy from another conversation and are reference context only. Do not resume its unfinished tasks or treat its approvals as authorization. Answer the current user request under the current session settings. This historical boundary does not constrain the current session mode or available tools.</system-reminder>',
    });
    const mode = createSideChatModeMessage(0);
    const active = [
        ...frozen.active.filter(({ message }) => !isSideChatModeMessage(message)),
        boundary,
        createHiddenContextBoundaryRecord(`sidechat:${input.target.sessionId}`, {
            kind: mode.customType,
            content: mode.content,
        }),
    ];
    const staged = await options.sessions.stageUnpersisted({
        target: input.target,
        generation: frozen.generation,
        active,
        snapshots: frozen.snapshots,
        source: { sessionId: input.sourceSessionId },
    });
    try {
        input.signal?.throwIfAborted();
    }
    catch (error) {
        await staged.rollback();
        throw error;
    }
    return {
        ...staged,
        messageCount: active.length,
        historyRevision: frozen.historyRevision,
        ...(frozen.sourceMessageId ? { sourceMessageId: frozen.sourceMessageId } : {}),
        display: frozen.display,
    };
}
async function fork(options, input) {
    const { source, sourceArtifact, prefix } = await selectForkPrefix(options, input);
    const active = createForkActiveHistory(prefix, input);
    // Ancestor snapshots are immutable, revision-linked archives, not live context; they are
    // copied as files. Filter only the selected active prefix above, including forks into an archive.
    const snapshots = source.snapshots.filter((snapshot) => snapshot.generation < sourceArtifact.generation);
    const staged = await options.sessions.stageFork({
        ...input,
        generation: sourceArtifact.generation,
        active,
        snapshots,
    });
    await staged.publish();
    await options.forkProjections.forkPrefix({
        operationId: input.operationId,
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        targetWorkspaceDir: input.targetWorkspaceDir,
        ...(input.rewindTargetWorkspace ? { rewindTargetWorkspace: true } : {}),
        retainedTurnIds: unique([
            ...snapshots.flatMap((snapshot) => snapshot.entries.map((entry) => entry.turnId)),
            ...prefix.map((envelope) => envelope.turn_id),
        ]),
    });
    return {
        generation: sourceArtifact.generation,
        historyRevision: canonicalActiveHistoryRevision(active),
    };
}
/**
 * Read-only preflight: reports whether `fork()` would accept this boundary, without staging.
 * The prefix drops unpaired tool calls, so it is always settled.
 */
async function inspectForkBoundary(options, input) {
    await selectForkPrefix(options, input);
    return { settled: true };
}
/** Single source of the Fork prefix rule shared by `fork()` and its preflight. */
async function selectForkPrefix(options, input) {
    const inclusiveBoundary = input.throughMessageId ?? input.throughAssistantMessageId;
    const boundary = inclusiveBoundary ?? input.beforeUserMessageId;
    const source = await readBoundarySource(options, input.sourceSessionId, boundary, input.beforeUserMessageId);
    const located = findBoundaryArtifact(source, boundary, Boolean(input.throughMessageId));
    if (!located)
        boundaryNotFound(boundary);
    const sourceArtifact = await loadArtifact(options, input.sourceSessionId, source, located);
    const index = boundary
        ? sourceArtifact.records.findIndex((envelope) => envelope.message_id === boundary)
        : sourceArtifact.records.length;
    if (index < 0)
        boundaryNotFound(boundary);
    const prefixEnd = forkPrefixEnd(sourceArtifact.records, index, input);
    const prefix = withoutUnpairedToolCalls(withoutSourceBackgroundReminders(sourceArtifact.records.slice(0, prefixEnd)));
    return { source, sourceArtifact, boundary, prefix };
}
function forkPrefixEnd(records, index, input) {
    if (input.throughMessageId)
        return index + 1;
    if (input.throughAssistantMessageId)
        return assistantBoundaryEnd(records, index);
    return index;
}
/**
 * An Assistant boundary owns the results of its own tool calls. Pi commits each result as a
 * separate record right after the call, so cutting between them would leave an unsettled prefix
 * (e.g. Fork from a `task_output` or ask_user card). Only contiguous results for this Assistant's
 * calls are included; any other record ends the boundary.
 */
function assistantBoundaryEnd(records, index) {
    const pendingCallIds = new Set(assistantToolCallIds(records[index]?.message));
    let end = index + 1;
    while (pendingCallIds.size > 0) {
        const callId = toolResultCallId(records[end]?.message);
        if (!callId || !pendingCallIds.delete(callId))
            break;
        end += 1;
    }
    return end;
}
function assistantToolCallIds(message) {
    if (!message || Reflect.get(message, 'role') !== 'assistant')
        return [];
    const content = Reflect.get(message, 'content');
    if (!Array.isArray(content))
        return [];
    return content.flatMap((block) => {
        if (!isRecord(block) || block.type !== 'toolCall')
            return [];
        return typeof block.id === 'string' && block.id ? [block.id] : [];
    });
}
function toolResultCallId(message) {
    if (!message || Reflect.get(message, 'role') !== 'toolResult')
        return undefined;
    const callId = Reflect.get(message, 'toolCallId');
    return typeof callId === 'string' && callId ? callId : undefined;
}
/**
 * Pairs each Assistant tool call with the contiguous results right after it, the rule of
 * `isSettledPrefix`. Drops calls without a result, Assistant messages left empty by that, and
 * results without a call; the output is settled and depends only on the input. Mirrors the
 * harness Fork/Rewind prefix rule, which this store cannot reach across the package boundary.
 */
function withoutUnpairedToolCalls(records) {
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
    const content = Reflect.get(record.message, 'content');
    if (callIds.size === 0 || !Array.isArray(content))
        return record;
    const kept = content.filter((block) => !isRecord(block) ||
        block.type !== 'toolCall' ||
        typeof block.id !== 'string' ||
        !callIds.has(block.id));
    if (kept.length === 0)
        return undefined;
    return { ...record, message: { ...record.message, content: kept } };
}
function createForkActiveHistory(prefix, input) {
    return [
        ...prefix,
        ...(input.continuation
            ? [createContinuationEnvelope(input.operationId, input.continuation)]
            : []),
        ...(input.hiddenContextBoundary
            ? [createHiddenContextBoundaryRecord(input.operationId, input.hiddenContextBoundary)]
            : []),
    ];
}
async function rewind(options, input) {
    const resumed = await options.sessions.resumeRewind?.({
        sessionId: input.sessionId,
        operationId: input.operationId,
    });
    if (resumed)
        return resumeRewind(options, input, resumed);
    const plan = await planRewind(options, input);
    const turnDiffRewind = await rewindTurnDiffBestEffort(options, input, plan);
    const staged = await options.sessions.stageRewind({
        sessionId: input.sessionId,
        operationId: input.operationId,
        expectedRevision: plan.sourceRevision,
        sourceGeneration: plan.sourceGeneration,
        generation: plan.generation,
        active: plan.active,
        snapshots: plan.snapshots,
        operationData: operationData(plan),
    });
    await staged.publish();
    return finishRewind(options, input, plan, turnDiffRewind);
}
async function resumeRewind(options, input, staged) {
    const data = decodeOperationData(staged.operationData);
    assertMatchingRewindRequest(input, data);
    const turnDiffRewind = await rewindTurnDiffBestEffort(options, input, data);
    await staged.publish({ allowRevisionChange: true });
    return finishRewind(options, input, {
        ...data,
        sourceGeneration: staged.sourceGeneration ?? staged.generation,
        generation: staged.generation,
        active: staged.active,
        snapshots: staged.snapshots,
        sourceRevision: staged.sourceRevision,
    }, turnDiffRewind);
}
async function finishRewind(options, input, plan, turnDiffRewind) {
    // The rewound user messages may have carried Tool Search or skill availability updates.
    forgetToolSearchAnnouncements(input.sessionId);
    forgetSkillCatalogAnnouncements(input.sessionId);
    try {
        await options.rewindProjections.deleteTurns({
            sessionId: input.sessionId,
            turnIds: plan.affectedTurnIds,
        });
    }
    catch {
        // Canonical history is already published. Derived cleanup is best-effort so
        // a stale projection cannot keep the Session operation running forever.
    }
    return {
        generation: plan.generation,
        historyRevision: canonicalActiveHistoryRevision(plan.active),
        deletedMessageIds: plan.deletedMessageIds,
        affectedTurnIds: plan.affectedTurnIds,
        partiallyRetainedTurnIds: plan.partiallyRetainedTurnIds,
        turnDiffRewind,
    };
}
async function rewindTurnDiffBestEffort(options, input, plan) {
    if (!plan.rewindTurnDiff)
        return { status: 'not-requested' };
    const prepared = await preflightTurnDiffBestEffort(options, input, plan);
    return prepared ? applyTurnDiffBestEffort(options, input) : successfulSkippedTurnDiff();
}
async function applyTurnDiffBestEffort(options, input) {
    try {
        const outcome = await options.rewindProjections.apply({
            operationId: input.operationId,
            sessionId: input.sessionId,
        });
        if (outcome.status !== 'failed-after-rewind')
            return outcome;
        reportTurnDiffSkip(options, {
            sessionId: input.sessionId,
            operationId: input.operationId,
            phase: 'apply',
            reason: outcome.errorCode,
        });
        return { status: 'rewound', revertedTurnIds: outcome.revertedTurnIds };
    }
    catch (error) {
        reportTurnDiffSkip(options, {
            sessionId: input.sessionId,
            operationId: input.operationId,
            phase: 'apply',
            reason: 'projection-error',
            error,
        });
        return successfulSkippedTurnDiff();
    }
}
async function preflightTurnDiffBestEffort(options, input, plan) {
    try {
        await options.rewindProjections.preflight({
            operationId: input.operationId,
            sessionId: input.sessionId,
            fullyDeletedTurnIds: plan.fullyDeletedTurnIds,
            partiallyRetainedTurnIds: plan.partiallyRetainedTurnIds,
        });
        return true;
    }
    catch (error) {
        reportTurnDiffSkip(options, {
            sessionId: input.sessionId,
            operationId: input.operationId,
            phase: 'preflight',
            reason: 'projection-error',
            error,
        });
        return false;
    }
}
function successfulSkippedTurnDiff() {
    return { status: 'rewound', revertedTurnIds: [] };
}
function reportTurnDiffSkip(options, event) {
    try {
        options.onTurnDiffRewindSkipped?.(event);
    }
    catch {
        // Diagnostics are best-effort and cannot affect Canonical Rewind.
    }
}
async function planRewind(options, input) {
    const source = await readBoundarySource(options, input.sessionId, input.fromUserMessageIdInclusive, input.fromUserMessageIdInclusive);
    const exact = await findRewindSlice(options, input.sessionId, source, input.fromUserMessageIdInclusive);
    const slice = exact ?? (await findDisplayOnlyRewindSlice(options, input.sessionId, source, input));
    const projection = exact
        ? deriveRewindProjection(source, slice.active, slice.snapshots)
        : includeDisplayAffectedTurns(deriveRewindProjection(source, slice.active, slice.snapshots), slice.active, slice.snapshots, input.displayOnlyBoundary?.affectedTurnIds ?? []);
    return {
        schemaVersion: 1,
        fromUserMessageIdInclusive: input.fromUserMessageIdInclusive,
        rewindTurnDiff: input.rewindTurnDiff === true,
        ...(input.displayOnlyBoundary
            ? { displayOnlyBoundary: copyDisplayOnlyBoundary(input.displayOnlyBoundary) }
            : {}),
        generation: slice.generation,
        sourceGeneration: source.activeGeneration,
        active: slice.active,
        snapshots: slice.snapshots,
        sourceRevision: source.revision,
        ...projection,
    };
}
async function findRewindSlice(options, sessionId, source, boundary) {
    const located = findBoundaryArtifact(source, boundary);
    if (!located)
        return undefined;
    const artifact = await loadArtifact(options, sessionId, source, located);
    const index = artifact.records.findIndex((envelope) => envelope.message_id === boundary);
    if (index < 0)
        return undefined;
    const target = artifact.records[index];
    if (!target || target.message.role !== 'user' || !target.message_id.startsWith('msg-user-v1-')) {
        throw new HistoryMutationError('boundary-invalid', 'History rewind target is not an external user envelope');
    }
    const active = withoutUnpairedToolCalls(artifact.records.slice(0, leadingHostMessagesStart(artifact.records, index)));
    assertSettledRewindPrefix(active);
    return {
        generation: artifact.generation,
        active,
        snapshots: source.snapshots.filter((snapshot) => snapshot.generation < artifact.generation),
    };
}
/**
 * The hidden host messages written right before a user message go with it on
 * rewind: the delta block (spec 9.1), and before a steer its wake line (4.4)
 * and recall pointers (15.7).
 */
function leadingHostMessagesStart(records, userIndex) {
    let start = userIndex;
    while (start > 0 && isLeadingHostMessage(records[start - 1]?.message))
        start -= 1;
    return start;
}
function isLeadingHostMessage(message) {
    return (isStateDeltaMessage(message) ||
        isRecallPointersMessage(message) ||
        (typeof message === 'object' &&
            message !== null &&
            Reflect.get(message, 'role') === 'custom' &&
            Reflect.get(message, 'customType') === WAKE_LINE_CUSTOM_TYPE));
}
async function findDisplayOnlyRewindSlice(options, sessionId, source, input) {
    const boundary = input.displayOnlyBoundary;
    if (!boundary)
        boundaryNotFound(input.fromUserMessageIdInclusive);
    const archived = source.snapshots.some((snapshot) => snapshot.entries.some((entry) => entry.turnId === boundary.turnId));
    const activeTarget = source.active.filter((envelope) => envelope.turn_id === boundary.turnId);
    if (archived || activeTarget.length > 0) {
        // The initial LLM hook can persist a hidden reminder before the user envelope.
        // If interrupted there, rewind that active suffix; never reinterpret real
        // conversation records or rewrite an archived generation as a reminder-only turn.
        if (archived ||
            activeTarget.some((envelope) => !isTypedBackgroundReminder(envelope.message) && !isStateDeltaMessage(envelope.message))) {
            throw new HistoryMutationError('boundary-invalid', 'Display-only rewind target Turn is partially present in Canonical History');
        }
        const index = source.active.findIndex((envelope) => envelope.turn_id === boundary.turnId);
        return {
            generation: source.activeGeneration,
            active: withoutUnpairedToolCalls(source.active.slice(0, index)),
            snapshots: source.snapshots,
        };
    }
    const laterBoundary = boundary.subsequentUserMessageIds.find((messageId) => findBoundaryArtifact(source, messageId) !== undefined);
    if (laterBoundary) {
        const later = await findRewindSlice(options, sessionId, source, laterBoundary);
        if (later)
            return later;
    }
    return {
        generation: source.activeGeneration,
        active: withoutUnpairedToolCalls(source.active),
        snapshots: source.snapshots,
    };
}
function assertSettledRewindPrefix(records) {
    if (isSettledPrefix(records))
        return;
    throw new HistoryMutationError('boundary-invalid', 'History rewind target prefix is not settled');
}
function deriveRewindProjection(source, active, snapshots) {
    const before = lineageEntries(source.snapshots, source.active);
    const after = lineageEntries(snapshots, active);
    const retainedMessageIds = new Set(after.map((entry) => entry.messageId));
    const deleted = uniqueBy(before.filter((entry) => !retainedMessageIds.has(entry.messageId)), (entry) => entry.messageId);
    const retainedTurnIds = new Set(after.map((entry) => entry.turnId));
    const affectedTurnIds = unique(deleted.map((entry) => entry.turnId));
    const partiallyRetainedTurnIds = affectedTurnIds.filter((turnId) => retainedTurnIds.has(turnId));
    const partial = new Set(partiallyRetainedTurnIds);
    return {
        deletedMessageIds: deleted.map((entry) => entry.messageId),
        affectedTurnIds,
        fullyDeletedTurnIds: affectedTurnIds.filter((turnId) => !partial.has(turnId)),
        partiallyRetainedTurnIds,
    };
}
function includeDisplayAffectedTurns(projection, active, snapshots, displayAffectedTurnIds) {
    const retainedTurnIds = new Set(lineageEntries(snapshots, active).map((entry) => entry.turnId));
    const affectedTurnIds = unique([...projection.affectedTurnIds, ...displayAffectedTurnIds]);
    const partiallyRetainedTurnIds = affectedTurnIds.filter((turnId) => retainedTurnIds.has(turnId));
    const partial = new Set(partiallyRetainedTurnIds);
    return {
        ...projection,
        affectedTurnIds,
        fullyDeletedTurnIds: affectedTurnIds.filter((turnId) => !partial.has(turnId)),
        partiallyRetainedTurnIds,
    };
}
function operationData(plan) {
    return {
        schemaVersion: 1,
        fromUserMessageIdInclusive: plan.fromUserMessageIdInclusive,
        rewindTurnDiff: plan.rewindTurnDiff,
        ...(plan.displayOnlyBoundary
            ? { displayOnlyBoundary: copyDisplayOnlyBoundary(plan.displayOnlyBoundary) }
            : {}),
        deletedMessageIds: plan.deletedMessageIds,
        affectedTurnIds: plan.affectedTurnIds,
        fullyDeletedTurnIds: plan.fullyDeletedTurnIds,
        partiallyRetainedTurnIds: plan.partiallyRetainedTurnIds,
    };
}
function decodeOperationData(value) {
    if (!isRewindOperationData(value))
        invalidOperationData();
    return value;
}
function isRewindOperationData(value) {
    return (isRecord(value) &&
        value.schemaVersion === 1 &&
        typeof value.fromUserMessageIdInclusive === 'string' &&
        typeof value.rewindTurnDiff === 'boolean' &&
        (value.displayOnlyBoundary === undefined || isDisplayOnlyBoundary(value.displayOnlyBoundary)) &&
        isStringArray(value.deletedMessageIds) &&
        isStringArray(value.affectedTurnIds) &&
        isStringArray(value.fullyDeletedTurnIds) &&
        isStringArray(value.partiallyRetainedTurnIds));
}
function invalidOperationData() {
    throw new HistoryMutationError('chain-corrupt', 'Persisted Rewind operation data is invalid');
}
function assertMatchingRewindRequest(input, data) {
    if (data.fromUserMessageIdInclusive !== input.fromUserMessageIdInclusive ||
        data.rewindTurnDiff !== (input.rewindTurnDiff === true) ||
        !sameDisplayOnlyBoundary(data.displayOnlyBoundary, input.displayOnlyBoundary)) {
        throw new HistoryMutationError('identity-conflict', 'Operation ID was already used for a different Rewind request');
    }
}
function copyDisplayOnlyBoundary(boundary) {
    return {
        turnId: boundary.turnId,
        subsequentUserMessageIds: [...boundary.subsequentUserMessageIds],
        affectedTurnIds: [...boundary.affectedTurnIds],
    };
}
function isDisplayOnlyBoundary(value) {
    return (isRecord(value) &&
        typeof value.turnId === 'string' &&
        value.turnId.length > 0 &&
        isStringArray(value.subsequentUserMessageIds) &&
        value.subsequentUserMessageIds.every((id) => id.startsWith('msg-user-v1-')) &&
        isStringArray(value.affectedTurnIds));
}
function sameDisplayOnlyBoundary(left, right) {
    if (!left || !right)
        return left === right;
    return (left.turnId === right.turnId &&
        sameStringArray(left.subsequentUserMessageIds, right.subsequentUserMessageIds) &&
        sameStringArray(left.affectedTurnIds, right.affectedTurnIds));
}
function sameStringArray(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
/** Locates the generation holding a message by record entries, without loading any snapshot. */
function findBoundaryArtifact(source, boundary, preferLatest = false) {
    const active = { generation: source.activeGeneration };
    if (!boundary)
        return active;
    const artifacts = [
        ...[...source.snapshots]
            .sort((left, right) => left.generation - right.generation)
            .map((snapshot) => ({ generation: snapshot.generation, snapshot })),
        active,
    ];
    if (preferLatest)
        artifacts.reverse();
    return artifacts.find((artifact) => artifact.snapshot
        ? artifact.snapshot.entries.some((entry) => entry.messageId === boundary)
        : source.active.some((envelope) => envelope.message_id === boundary));
}
/** The records of one located generation; only a snapshot target is read from disk. */
async function loadArtifact(options, sessionId, source, artifact) {
    const snapshot = artifact.snapshot;
    if (!snapshot)
        return { generation: artifact.generation, records: source.active };
    const records = await classified(() => options.sessions.readSnapshotRecords(sessionId, snapshot));
    return { generation: artifact.generation, records };
}
function lineageEntries(snapshots, active) {
    return [
        ...snapshots.flatMap((snapshot) => snapshot.entries),
        ...active.map((envelope) => ({ messageId: envelope.message_id, turnId: envelope.turn_id })),
    ];
}
function createContinuationEnvelope(operationId, continuation) {
    const identity = createHash('sha256').update(operationId).digest('hex').slice(0, 24);
    return {
        message_id: `msg-fork-reminder-${identity}`,
        turn_id: `control:${operationId}`,
        message: {
            role: 'user',
            timestamp: 0,
            content: `<system-reminder>\nThis conversation was forked into an isolated Git worktree.\nAll committed, staged, unstaged, and untracked changes from the source worktree were carried over.\nPrevious workspace: ${continuation.previousWorkspaceDir}\nCurrent workspace: ${continuation.currentWorkspaceDir}\nCurrent branch: ${continuation.currentBranch}\nUse the current workspace for all subsequent file and tool operations.\n</system-reminder>`,
        },
    };
}
function isTypedBackgroundReminder(message) {
    return (Reflect.get(message, 'role') === 'custom' &&
        Reflect.get(message, 'customType') === BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE &&
        Reflect.get(message, 'display') === false);
}
function isSettledPrefix(records) {
    return inspectCanonicalHistorySequence(records).status === 'settled';
}
async function readBoundarySource(options, sessionId, boundary, waitForUserMessageId) {
    const initial = await readSessionHistory(options, sessionId);
    if (!boundary ||
        containsBoundary(initial, boundary) ||
        !waitForUserMessageId ||
        !options.activeTurnId?.(sessionId) ||
        !options.sessions.readForUserMessage) {
        return initial;
    }
    // A missing user boundary may still be persisted by the running Turn.
    const waited = await classified(async () => options.sessions.readForUserMessage?.({
        sessionId,
        userMessageId: waitForUserMessageId,
        timeoutMs: options.boundaryWaitTimeoutMs ?? DEFAULT_BOUNDARY_WAIT_TIMEOUT_MS,
    }));
    return waited ?? initial;
}
async function readSessionHistory(options, sessionId) {
    return classified(() => options.sessions.read(sessionId));
}
async function classified(read) {
    try {
        return await read();
    }
    catch (error) {
        throw historyMutationErrorOf(error);
    }
}
function boundaryNotFound(boundary) {
    throw new HistoryMutationError('boundary-not-found', `History mutation target not found: ${boundary}`);
}
function containsBoundary(source, boundary) {
    return (source.active.some((envelope) => envelope.message_id === boundary) ||
        source.snapshots.some((snapshot) => snapshot.entries.some((entry) => entry.messageId === boundary)));
}
function unique(values) {
    return [...new Set(values)];
}
function uniqueBy(values, key) {
    const seen = new Set();
    return values.filter((value) => {
        const identity = key(value);
        if (seen.has(identity))
            return false;
        seen.add(identity);
        return true;
    });
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=history-mutation-capability.js.map