import { createHash } from 'node:crypto';
import { canonicalActiveHistoryRevision, canonicalHistoryRevision, inspectCanonicalHistorySequence, createSideChatModeMessage, isSideChatModeMessage, } from '../../session-system/index.js';
import { readBackgroundTaskOriginMetadata } from '../agent-host/history/background/host-metadata.js';
import { BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE } from '../agent-host/history/background/reminder-protocol.js';
import { isBackgroundTaskReadSettlement } from '../agent-host/history/background/task-read-settlement.js';
import { appendCompactionState, readCompactionCompatibility } from '../compaction/compat.js';
const DEFAULT_BOUNDARY_WAIT_TIMEOUT_MS = 5_000;
export class HistoryMutationError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = 'HistoryMutationError';
    }
}
export function createHistoryMutationCapability(options) {
    return {
        prepareSideChat: (input) => prepareSideChat(options, input),
        fork: (input) => fork(options, input),
        inspectForkBoundary: (input) => inspectForkBoundary(options, input),
        rewind: (input) => rewind(options, input),
    };
}
async function prepareSideChat(options, input) {
    const frozen = await options.sessions.readFrozen(input.sourceSessionId, async (source) => {
        const inspection = inspectCanonicalHistorySequence(source.active);
        const prefix = withoutSourceBackgroundReminders(source.active.slice(0, inspection.status === 'settled' ? source.active.length : inspection.settledPrefixLength));
        const sourceMessageId = prefix.at(-1)?.message_id;
        const snapshot = {
            active: prefix,
            snapshots: source.snapshots.map(copySnapshot),
            historyRevision: canonicalActiveHistoryRevision(prefix),
            ...(sourceMessageId ? { sourceMessageId } : {}),
        };
        return {
            ...snapshot,
            generation: source.activeGeneration,
            ...(await input.captureDisplay(snapshot)),
        };
    }, input.signal);
    input.signal?.throwIfAborted();
    const copied = rewriteSideChatAssets(frozen, frozen.replacements);
    const boundary = createHiddenContextBoundaryEnvelope(`sidechat:${input.target.sessionId}`, {
        kind: 'sidechat_context_boundary',
        content: '<system-reminder>Messages above this boundary are a frozen copy from another conversation and are reference context only. Do not resume its unfinished tasks or treat its approvals as authorization. Answer the current user request under the current session settings. This historical boundary does not constrain the current session mode or available tools.</system-reminder>',
    });
    const mode = createSideChatModeMessage(0);
    const active = [
        ...copied.active.filter(({ message }) => !isSideChatModeMessage(message)),
        boundary,
        createHiddenContextBoundaryEnvelope(`sidechat:${input.target.sessionId}`, {
            kind: mode.customType,
            content: mode.content,
        }),
    ];
    const staged = await options.sessions.stageUnpersisted({
        target: input.target,
        generation: frozen.generation,
        active,
        snapshots: copied.snapshots,
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
        targetRevision: canonicalActiveHistoryRevision(active),
        messageCount: active.length,
        historyRevision: frozen.historyRevision,
        ...(frozen.sourceMessageId ? { sourceMessageId: frozen.sourceMessageId } : {}),
        display: frozen.display,
    };
}
function rewriteSideChatAssets(frozen, replacements) {
    if (!replacements?.size)
        return frozen;
    const revisions = new Map();
    const rewrite = (records) => records.map((record, index) => {
        const message = JSON.parse(JSON.stringify(record.message, (_key, value) => typeof value === 'string' ? (replacements.get(value) ?? value) : value));
        const copied = { ...record, message };
        if (index !== 0)
            return copied;
        if (copied.history_artifact) {
            const parent = copied.history_artifact.parentSnapshot;
            copied.history_artifact = {
                ...copied.history_artifact,
                parentSnapshot: {
                    ...parent,
                    revision: revisions.get(parent.revision) ?? parent.revision,
                },
            };
        }
        const marker = message.archonCompaction;
        if (isRecord(marker) &&
            isRecord(marker.parentSnapshot) &&
            typeof marker.parentSnapshot.revision === 'string') {
            const parent = marker.parentSnapshot;
            copied.message = {
                ...message,
                archonCompaction: {
                    ...marker,
                    parentSnapshot: {
                        ...parent,
                        revision: revisions.get(parent.revision) ?? parent.revision,
                    },
                },
            };
        }
        return copied;
    });
    const snapshots = frozen.snapshots.map((snapshot) => {
        const records = rewrite(snapshot.records);
        const revision = canonicalHistoryRevision(records);
        revisions.set(snapshot.revision, revision);
        return { ...snapshot, records, revision };
    });
    return { active: rewrite(frozen.active), snapshots };
}
async function fork(options, input) {
    const { source, sourceArtifact, boundary, prefix } = await selectForkPrefix(options, input);
    if (boundary && !isSettledPrefix(prefix)) {
        throw new HistoryMutationError('boundary-invalid', 'History fork target prefix is not settled');
    }
    const active = createForkActiveHistory(prefix, input);
    const snapshots = source.snapshots
        .filter((snapshot) => snapshot.generation < sourceArtifact.generation)
        // Ancestor snapshots are immutable, revision-linked archives, not live context.
        // Filter only the selected active prefix above, including forks into an archive.
        .map(copySnapshot);
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
        retainedTurnIds: unique([...snapshots.flatMap((snapshot) => snapshot.records), ...prefix].map((envelope) => envelope.turn_id)),
    });
    return {
        generation: sourceArtifact.generation,
        historyRevision: canonicalActiveHistoryRevision(active),
    };
}
/** Read-only preflight: reports whether `fork()` would accept this boundary, without staging. */
async function inspectForkBoundary(options, input) {
    const { boundary, prefix } = await selectForkPrefix(options, input);
    return { settled: !boundary || isSettledPrefix(prefix) };
}
/** Single source of the Fork prefix rule shared by `fork()` and its preflight. */
async function selectForkPrefix(options, input) {
    const inclusiveBoundary = input.throughMessageId ?? input.throughAssistantMessageId;
    const boundary = inclusiveBoundary ?? input.beforeUserMessageId;
    const source = await readBoundarySource(options, input.sourceSessionId, boundary, input.beforeUserMessageId);
    const sourceArtifact = findForkArtifact(source, boundary, Boolean(input.throughMessageId));
    if (!sourceArtifact)
        boundaryNotFound(boundary);
    const index = boundary
        ? sourceArtifact.records.findIndex((envelope) => envelope.message_id === boundary)
        : sourceArtifact.records.length;
    if (index < 0)
        boundaryNotFound(boundary);
    const prefixEnd = forkPrefixEnd(sourceArtifact.records, index, input);
    const prefix = withoutSourceBackgroundReminders(sourceArtifact.records.slice(0, prefixEnd));
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
function createForkActiveHistory(prefix, input) {
    return [
        ...prefix,
        ...(input.continuation
            ? [createContinuationEnvelope(input.operationId, input.continuation)]
            : []),
        ...(input.hiddenContextBoundary
            ? [createHiddenContextBoundaryEnvelope(input.operationId, input.hiddenContextBoundary)]
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
    const exact = findRewindSlice(source, input.fromUserMessageIdInclusive);
    const slice = exact ?? findDisplayOnlyRewindSlice(source, input);
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
function findRewindSlice(source, boundary) {
    const artifact = findForkArtifact(source, boundary);
    if (!artifact)
        return undefined;
    const index = artifact.records.findIndex((envelope) => envelope.message_id === boundary);
    if (index < 0)
        return undefined;
    const target = artifact.records[index];
    if (!target || target.message.role !== 'user' || !target.message_id.startsWith('msg-user-v1-')) {
        throw new HistoryMutationError('boundary-invalid', 'History rewind target is not an external user envelope');
    }
    const active = artifact.records.slice(0, index);
    assertSettledRewindPrefix(active);
    return {
        generation: artifact.generation,
        active,
        snapshots: source.snapshots
            .filter((snapshot) => snapshot.generation < artifact.generation)
            .map(copySnapshot),
    };
}
function findDisplayOnlyRewindSlice(source, input) {
    const boundary = input.displayOnlyBoundary;
    if (!boundary)
        boundaryNotFound(input.fromUserMessageIdInclusive);
    const canonical = [...source.snapshots.flatMap((snapshot) => snapshot.records), ...source.active];
    const targetRecords = canonical.filter((envelope) => envelope.turn_id === boundary.turnId);
    if (targetRecords.length > 0) {
        // The initial LLM hook can persist a hidden reminder before the user envelope.
        // If interrupted there, rewind that active suffix; never reinterpret real
        // conversation records or rewrite an archived generation as a reminder-only turn.
        if (targetRecords.some((envelope) => !isTypedBackgroundReminder(envelope.message)) ||
            source.snapshots.some((snapshot) => snapshot.records.some((envelope) => envelope.turn_id === boundary.turnId))) {
            throw new HistoryMutationError('boundary-invalid', 'Display-only rewind target Turn is partially present in Canonical History');
        }
        const index = source.active.findIndex((envelope) => envelope.turn_id === boundary.turnId);
        const active = source.active.slice(0, index);
        assertSettledRewindPrefix(active);
        return {
            generation: source.activeGeneration,
            active,
            snapshots: source.snapshots.map(copySnapshot),
        };
    }
    const laterBoundary = boundary.subsequentUserMessageIds.find((messageId) => findForkArtifact(source, messageId) !== undefined);
    if (laterBoundary) {
        const later = findRewindSlice(source, laterBoundary);
        if (later)
            return later;
    }
    assertSettledRewindPrefix(source.active);
    return {
        generation: source.activeGeneration,
        active: source.active,
        snapshots: source.snapshots.map(copySnapshot),
    };
}
function assertSettledRewindPrefix(records) {
    if (isSettledPrefix(records))
        return;
    throw new HistoryMutationError('boundary-invalid', 'History rewind target prefix is not settled');
}
function deriveRewindProjection(source, active, snapshots) {
    const before = [...source.snapshots.flatMap((snapshot) => snapshot.records), ...source.active];
    const after = [...snapshots.flatMap((snapshot) => snapshot.records), ...active];
    const retainedMessageIds = new Set(after.map((envelope) => envelope.message_id));
    const deleted = uniqueBy(before.filter((entry) => !retainedMessageIds.has(entry.message_id)), (entry) => entry.message_id);
    const retainedTurnIds = new Set(after.map((envelope) => envelope.turn_id));
    const affectedTurnIds = unique(deleted.map((envelope) => envelope.turn_id));
    const partiallyRetainedTurnIds = affectedTurnIds.filter((turnId) => retainedTurnIds.has(turnId));
    const partial = new Set(partiallyRetainedTurnIds);
    return {
        deletedMessageIds: deleted.map((envelope) => envelope.message_id),
        affectedTurnIds,
        fullyDeletedTurnIds: affectedTurnIds.filter((turnId) => !partial.has(turnId)),
        partiallyRetainedTurnIds,
    };
}
function includeDisplayAffectedTurns(projection, active, snapshots, displayAffectedTurnIds) {
    const retainedTurnIds = new Set([...snapshots.flatMap((snapshot) => snapshot.records), ...active].map((envelope) => envelope.turn_id));
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
function findForkArtifact(source, boundary, preferLatest = false) {
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
    return artifacts.find((artifact) => artifact.records.some((envelope) => envelope.message_id === boundary));
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
function createHiddenContextBoundaryEnvelope(operationId, boundary) {
    const identity = createHash('sha256')
        .update(`${operationId}:${boundary.kind}:${boundary.content}`)
        .digest('hex')
        .slice(0, 24);
    return {
        message_id: `msg-hidden-context-boundary-${identity}`,
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
function copySnapshot(snapshot) {
    return { ...snapshot, records: snapshot.records };
}
function withoutSourceBackgroundReminders(records) {
    const retained = [];
    const suppressedTurnIds = new Set();
    for (const envelope of records) {
        if (suppressedTurnIds.has(envelope.turn_id))
            continue;
        if (isTypedBackgroundReminder(envelope.message) ||
            isBackgroundTaskReadSettlement(envelope.message)) {
            continue;
        }
        if (!isAutomaticBackgroundReminder(envelope.message)) {
            retained.push(withoutSourceBackgroundCheckpoint(envelope));
            continue;
        }
        while (retained.at(-1)?.turn_id === envelope.turn_id && !isSettledPrefix(retained)) {
            retained.pop();
        }
        suppressedTurnIds.add(envelope.turn_id);
    }
    return retained;
}
function isTypedBackgroundReminder(message) {
    return (Reflect.get(message, 'role') === 'custom' &&
        Reflect.get(message, 'customType') === BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE &&
        Reflect.get(message, 'display') === false);
}
function withoutSourceBackgroundCheckpoint(envelope) {
    if (Reflect.get(envelope.message, 'role') !== 'compactionSummary')
        return envelope;
    const compatibility = readCompactionCompatibility(envelope.message);
    if (!compatibility?.backgroundCadence)
        return envelope;
    const retainedCompatibility = { ...compatibility };
    Reflect.deleteProperty(retainedCompatibility, 'backgroundCadence');
    const { summary, ...retained } = retainedCompatibility;
    return {
        ...envelope,
        message: {
            ...envelope.message,
            summary: appendCompactionState(summary, retained),
        },
    };
}
function isAutomaticBackgroundReminder(message) {
    return (Reflect.get(message, 'role') === 'user' &&
        readBackgroundTaskOriginMetadata(message) !== undefined);
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
    try {
        return await options.sessions.readForUserMessage({
            sessionId,
            userMessageId: waitForUserMessageId,
            timeoutMs: options.boundaryWaitTimeoutMs ?? DEFAULT_BOUNDARY_WAIT_TIMEOUT_MS,
        });
    }
    catch (error) {
        throw classifySessionHistoryError(error);
    }
}
async function readSessionHistory(options, sessionId) {
    try {
        return await options.sessions.read(sessionId);
    }
    catch (error) {
        throw classifySessionHistoryError(error);
    }
}
function classifySessionHistoryError(error) {
    if (error instanceof HistoryMutationError)
        return error;
    const code = readErrorCode(error);
    if (code === 'duplicate-external-user-id' || code === 'external-user-lineage-conflict') {
        return new HistoryMutationError('identity-conflict', 'Canonical history contains a duplicate external user identity', { cause: error });
    }
    if ([
        'artifact-revision-mismatch',
        'parent-mismatch',
        'parent-snapshot-missing',
        'invalid-generation-marker',
        'malformed-jsonl',
        'sequence-corruption',
        'unsafe-artifact',
    ].includes(String(code))) {
        return new HistoryMutationError('chain-corrupt', 'Canonical history chain is corrupt', {
            cause: error,
        });
    }
    return error;
}
function boundaryNotFound(boundary) {
    throw new HistoryMutationError('boundary-not-found', `History mutation target not found: ${boundary}`);
}
function readErrorCode(error) {
    return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
}
function containsBoundary(source, boundary) {
    return (source.active.some((envelope) => envelope.message_id === boundary) ||
        source.snapshots.some((snapshot) => snapshot.records.some((envelope) => envelope.message_id === boundary)));
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