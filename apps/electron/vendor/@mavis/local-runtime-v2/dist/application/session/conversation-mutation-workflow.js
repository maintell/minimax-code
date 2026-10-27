import { isConversationMutationEligibleSession } from '../../service/session-system/index.js';
import { HistoryMutationError } from '../../service/turn-system/index.js';
import { publishBestEffort } from '../events.js';
import { materializeLocalAttachmentInputs, } from '../conversation/attachment-registration.js';
import { ApplicationError } from '../conversation/errors.js';
import { ForkService, ForkServiceError, recoverPendingForkOperations, suggestForkTitle, } from './conversation-fork.js';
import { CONVERSATION_MUTATION_BUSY, CONVERSATION_MUTATION_NOT_SUPPORTED, CONVERSATION_MUTATION_REQUEST_CONFLICT, EDIT_RESTART_NEEDS_NEW_OPERATION, EDIT_RESTART_NEEDS_RESUBMIT, FORK_COPY_FAILED, FORK_RECOVERY_FAILED, FORK_WORKTREE_SOURCE_CHANGED, FORK_WORKTREE_UNAVAILABLE, HISTORY_CHAIN_CORRUPT, HISTORY_IDENTITY_CONFLICT, MESSAGE_BOUNDARY_INVALID, MESSAGE_BOUNDARY_NOT_FOUND, } from './conversation-mutation-errors.js';
import { RewindEditService, RewindEditServiceError, } from './conversation-rewind-edit-service.js';
import { toSessionInfoView } from './wire.js';
export const unavailableForkWorktree = {
    isEligible: async () => false,
    prepare: async () => {
        throw new Error('Fork worktree infrastructure is unavailable');
    },
    cleanup: async () => undefined,
};
/** Application owns complete Fork/Rewind/Edit sequencing; owner capabilities stay narrow. */
export function createProductionConversationMutationWorkflow(input) {
    const operations = createForkOperationPort(input.operations);
    const fork = createForkService(input, operations);
    const rewindEdit = createRewindEditService(input);
    return {
        recoverPendingForks: () => recoverPending(input, fork, operations, rewindEdit),
        getSessionForkOptions: (_ctx, request) => getForkOptions(request, fork, input),
        createSideSession: (request) => fork.forkSideSession(request),
        forkSession: (_ctx, request) => mapFork(request, fork, input),
        getSessionRewindPreview: (_ctx, request) => mapRewindPreview(request, input),
        rewindSession: (_ctx, request) => mapRewind(request, rewindEdit, input.sessionFork, input.mutationPlanState),
        editSessionMessage: (_ctx, request) => mapEdit(request, rewindEdit, input.sessionFork, input.mutationPlanState),
    };
}
async function mapRewindPreview(request, input) {
    await requirePlanInactive(request.id, input.mutationPlanState);
    await requireMutationEligibleSession(request.id, input.sessionFork);
    const plan = await input.sessionRewind.planInclusive({
        sessionId: request.id,
        fromMessageId: request.userMessageId,
    });
    if (plan.targetIsQuestionnaireResponse && !plan.targetQuestionnaireResponseRewindEligible) {
        throw toApplicationError(MESSAGE_BOUNDARY_INVALID, 'Questionnaire responses cannot be rewound or edited');
    }
    const preview = await input.rewindPreview.preview({
        sessionId: request.id,
        turnIds: plan.affectedTurnIds,
        partiallyRetainedTurnIds: plan.partiallyRetainedTurnIds ?? [],
    });
    return {
        turns: preview.turns.map((turn) => ({
            turnId: turn.turnId,
            files: turn.files.map((file) => ({
                filePath: file.file,
                action: file.action,
                skipped: file.status === 'skipped',
            })),
        })),
    };
}
function createForkService(input, operations) {
    return new ForkService({
        boundary: input.sessionFork.boundary,
        sessions: input.sessionFork.sessions,
        display: input.sessionFork.display,
        assets: input.sessionFork.assets,
        state: input.forkState,
        operations,
        worktree: input.worktree,
        sessionDataVersion: input.sessionFork.sessionDataVersion,
        history: {
            fork: async (request) => {
                const result = await input.turn.fork(request);
                return { historyRevision: result.historyRevision };
            },
            ...(input.turn.inspectForkBoundary
                ? { inspectBoundary: input.turn.inspectForkBoundary.bind(input.turn) }
                : {}),
        },
    });
}
function createRewindEditService(input) {
    return new RewindEditService({
        operations: createRewindEditOperationPort(input.operations),
        turn: input.turn,
        session: input.sessionRewind,
        questionnaires: input.questionnaires,
        projection: {
            project: async ({ sessionId, operationId, rewoundMessageIds, deletedMessageIds }) => {
                input.stream.write({
                    identity: `conversation-mutation:${operationId}`,
                    sessionId,
                    turnId: operationId,
                    kind: 'runtime-event',
                    data: { type: 'message.rewind', operationId, rewoundMessageIds, deletedMessageIds },
                });
            },
        },
        events: {
            publish: async ({ sessionId }) => {
                input.publishGlobalEvent({
                    type: 'message.rewind',
                    payload: { sessionId, contextReset: true },
                });
            },
        },
        submit: {
            submit: async ({ sessionId, operationId, content, attachments }) => {
                const materialized = await materializeLocalAttachmentInputs(input.attachmentRegistration, {
                    sessionId,
                    turnId: operationId,
                    attachments: attachments.map(toAttachmentInput),
                });
                try {
                    const admitted = await input.trustedEditSubmission.submit({
                        sessionId,
                        operationId,
                        content,
                        attachments: materialized.executionAttachments,
                        displayAttachments: materialized.displayAttachments,
                    });
                    if (!admitted.accepted && admitted.reason !== 'duplicate') {
                        throw new Error(`Edited message was not admitted: ${admitted.reason}`);
                    }
                    return { turnId: admitted.turnId, userMessageId: admitted.userMessageId };
                }
                catch (error) {
                    await materialized.discardCreated();
                    throw error;
                }
            },
        },
    });
}
async function recoverPending(input, fork, operations, rewindEdit) {
    await recoverPendingForkOperations({
        operations,
        sessions: { delete: (sessionId) => input.sessionFork.sessions.delete(sessionId) },
        display: { deleteSession: (sessionId) => input.sessionFork.display.deleteSession(sessionId) },
        assets: { compensate: (request) => input.sessionFork.assets.compensate(request) },
        state: { compensate: (request) => input.forkState.compensate(request) },
        worktree: { cleanup: (request) => input.worktree.cleanup(request) },
        resume: ({ manifest, stage, advance }) => fork.resume({ manifest, stage, advance }),
    });
    await rewindEdit.recoverPending();
}
function createForkOperationPort(repository) {
    return {
        get: async (operationId, request) => {
            const row = await repository.read({ operationId, kind: 'session-fork' });
            if (!row)
                return undefined;
            if (row.status === 'failed') {
                throw new ForkServiceError('recovery-failed', 'This Fork did not complete; retry with a new operation ID');
            }
            const manifest = asForkManifest(row.intent);
            if (request && (!manifest || !sameForkRequest(manifest.request, request))) {
                throw new ForkServiceError('request-conflict', 'Operation ID was already used for a different Fork request');
            }
            return row.result;
        },
        getPending: async (operationId) => {
            const row = await repository.read({ operationId, kind: 'session-fork' });
            if (!row || row.status === 'completed' || row.status === 'failed')
                return undefined;
            if (row.claimOwner) {
                throw new ForkServiceError('busy', 'Fork operation is owned by recovery');
            }
            return { status: row.status, stage: row.stage, intent: asForkManifest(row.intent) };
        },
        listPending: async () => (await repository.listPending('session-fork')).map((row) => ({
            ...row,
            intent: asForkManifest(row.intent),
        })),
        claim: async ({ operationId, owner, leaseMs }) => {
            const row = await repository.claim({ operationId, kind: 'session-fork', owner, leaseMs });
            return row ? { ...row, intent: asForkManifest(row.intent) } : undefined;
        },
        advance: async ({ operationId, status, stage, intent }) => {
            if (!intent)
                throw new Error(`Fork intent is required: ${operationId}`);
            await repository.advance({
                operationId,
                clientRequestId: operationId,
                sessionId: intent.source.sessionId,
                kind: 'session-fork',
                status,
                stage,
                intent,
            });
        },
        advanceClaimed: async (claim) => {
            const row = await repository.advanceClaimed({
                ...claim,
                kind: 'session-fork',
            });
            return row ? { revision: row.revision } : undefined;
        },
        failRecovery: async ({ operationId, stage, intent, error }) => {
            const row = await repository.read({ operationId, kind: 'session-fork' });
            if (!row)
                throw new Error(`Fork recovery intent is missing: ${operationId}`);
            const terminal = await repository.advance({
                operationId,
                clientRequestId: row.clientRequestId,
                sessionId: row.sessionId,
                kind: 'session-fork',
                status: 'failed',
                stage,
                ...(intent ? { intent } : {}),
                error,
            });
            if (terminal.status !== 'failed' && terminal.status !== 'completed') {
                throw new Error(`Fork recovery did not reach a terminal state: ${operationId}`);
            }
        },
        put: async (operationId, result) => {
            const row = await repository.read({ operationId, kind: 'session-fork' });
            if (!row)
                throw new Error(`Fork intent is missing: ${operationId}`);
            await repository.put({
                operationId,
                clientRequestId: operationId,
                sessionId: row.sessionId,
                kind: 'session-fork',
                result,
            });
        },
    };
}
function createRewindEditOperationPort(repository) {
    return {
        listPending: async (kind) => (await repository.listPending(kind)).map((row) => toRewindEditOperation(row, kind)),
        read: async ({ operationId, kind }) => {
            const row = await repository.read({ operationId, kind });
            return row ? toRewindEditOperation(row, kind) : undefined;
        },
        advance: async (operation) => toRewindEditOperation(await repository.advance({
            ...operation,
            clientRequestId: operation.operationId,
        }), operation.kind),
        complete: async ({ operationId, sessionId, kind, result }) => {
            await repository.put({
                operationId,
                clientRequestId: operationId,
                sessionId,
                kind,
                result,
            });
        },
        fail: async ({ operationId, sessionId, kind, stage, intent, error }) => {
            await repository.advance({
                operationId,
                clientRequestId: operationId,
                sessionId,
                kind,
                status: 'failed',
                stage,
                ...(intent ? { intent } : {}),
                error,
            });
        },
    };
}
function toRewindEditOperation(row, kind) {
    return {
        operationId: row.operationId,
        sessionId: row.sessionId,
        kind,
        status: row.status,
        stage: row.stage,
        intent: asRewindEditIntent(row.intent),
        result: asRewindEditResult(row.result),
        ...(row.lastError ? { error: row.lastError } : {}),
    };
}
async function getForkOptions(request, historyPreflight, input) {
    const capability = input.sessionFork;
    const source = await capability.sessions.get(request.id);
    if (!source)
        return missingForkSourceOptions();
    if (!isSupportedForkSource(source, capability.sessionDataVersion)) {
        return {
            canFork: false,
            unavailableReason: 'conversation-mutation-not-supported',
            worktreeVisible: false,
            worktreeEligible: false,
        };
    }
    const boundary = await capability.boundary.resolve({
        sessionId: request.id,
        ...(request.assistantMessageId === undefined
            ? {}
            : { assistantDisplayMessageId: request.assistantMessageId }),
    });
    const planState = await input.mutationPlanState?.readPlanState(request.id);
    const boundaryAvailability = await confirmForkHistoryBoundary(forkBoundaryAvailability(boundary, source.status, planState?.active), request.id, boundary, historyPreflight);
    const suggestion = await suggestForkTitle(source, capability.sessions);
    const worktreeEligible = source.appMode === 'coding' && (await input.worktree.isEligible(source));
    return {
        ...boundaryAvailability,
        suggestedTitle: suggestion.title,
        nextForkOrdinal: suggestion.ordinal,
        sourceTitle: source.title ?? source.sessionId,
        worktreeVisible: worktreeEligible,
        worktreeEligible,
    };
}
function missingForkSourceOptions() {
    return {
        canFork: false,
        unavailableReason: 'source-not-found',
        worktreeVisible: false,
        worktreeEligible: false,
    };
}
function isSupportedForkSource(source, minimumVersion) {
    return Boolean(source && isConversationMutationEligibleSession(source, minimumVersion));
}
function forkBoundaryAvailability(boundary, sourceStatus, planActive = false) {
    if (!boundary)
        return { canFork: false, unavailableReason: 'message-boundary-not-found' };
    if (boundary.assistant.role !== 'assistant' || isInvalidForkBoundary(boundary)) {
        return { canFork: false, unavailableReason: 'message-boundary-invalid' };
    }
    if (isCanonicalForkBoundaryMissing(boundary)) {
        return { canFork: false, unavailableReason: 'message-boundary-not-found' };
    }
    if (isForkBoundaryAvailable(boundary, sourceStatus, planActive))
        return { canFork: true };
    return { canFork: false, unavailableReason: 'message-boundary-invalid' };
}
function isCanonicalForkBoundaryMissing(boundary) {
    return !boundary.canonicalBoundaryReachable;
}
/** Downgrades an available boundary that `history.fork` would reject, e.g. a split tool call. */
async function confirmForkHistoryBoundary(availability, sessionId, boundary, historyPreflight) {
    if (!availability.canFork || !boundary)
        return availability;
    try {
        if (await historyPreflight.isHistoryBoundarySettled(sessionId, boundary))
            return availability;
        return { canFork: false, unavailableReason: 'message-boundary-invalid' };
    }
    catch (error) {
        if (!(error instanceof HistoryMutationError))
            throw error;
        return {
            canFork: false,
            unavailableReason: error.code === 'boundary-not-found'
                ? 'message-boundary-not-found'
                : 'message-boundary-invalid',
        };
    }
}
function isForkBoundaryAvailable(boundary, sourceStatus, planActive) {
    if (!planActive) {
        return hasCanonicalForkBoundary(boundary) || boundary.isLatestConversationMessage;
    }
    return (boundary.isLatestConversationMessage &&
        sourceStatus === 'idle' &&
        !isUnsettledForkBoundary(boundary));
}
function hasCanonicalForkBoundary(boundary) {
    return Boolean(boundary.assistantCanonicalMessageId ?? boundary.beforeUserMessageId);
}
function isUnsettledForkBoundary(boundary) {
    return ['streaming', 'optimistic', 'error'].includes(boundary.assistant.source ?? '');
}
function isInvalidForkBoundary(boundary) {
    return ['optimistic', 'error'].includes(boundary.assistant.source ?? '');
}
async function mapFork(request, service, input) {
    try {
        const planState = await input.mutationPlanState?.readPlanState(request.id);
        const result = await service.fork(toForkRequest(request, planState));
        publishBestEffort(input.publishGlobalEvent, {
            type: 'session.created',
            payload: {
                sessionId: result.child.sessionId,
                agentName: result.child.agentName,
                sessionType: result.child.sessionType,
                sessionKind: result.child.sessionKind,
                visibility: result.child.visibility ?? 'visible',
                ...(result.child.title === undefined ? {} : { title: result.child.title }),
                ...(result.child.parentSessionId === undefined
                    ? {}
                    : { parentSessionId: result.child.parentSessionId }),
            },
        });
        const sourceDisplayMessageId = result.sourceDisplayMessageId ?? request.assistantMessageId;
        return {
            session: toSessionInfoView(result.child),
            ...(sourceDisplayMessageId ? { sourceDisplayMessageId } : {}),
            displayRevision: String(await input.sessionFork.display.latestRevision(result.child.sessionId)),
            ...(result.historyRevision ? { historyRevision: result.historyRevision } : {}),
        };
    }
    catch (error) {
        throw mapForkError(error);
    }
}
function toForkRequest(request, planState) {
    return {
        operationId: request.clientRequestId,
        sourceSessionId: request.id,
        ...(request.assistantMessageId === undefined
            ? {}
            : { assistantDisplayMessageId: request.assistantMessageId }),
        useSuggestedTitle: request.useSuggestedTitle,
        ...(request.title ? { title: request.title } : {}),
        ...(request.createIsolatedWorktree ? { isolatedWorktree: true } : {}),
        ...(planState?.active
            ? {
                planState: {
                    interactionMode: planState.interactionMode === 'plan' ? 'plan' : 'default',
                },
            }
            : {}),
    };
}
async function mapRewind(request, service, capability, planStateReader) {
    try {
        await requirePlanInactive(request.id, planStateReader);
        await requireMutationEligibleSession(request.id, capability);
        const result = await service.rewind({
            sessionId: request.id,
            userMessageId: request.userMessageId,
            clientRequestId: request.clientRequestId,
            ...(request.rewindTurnDiff === true ? { rewindTurnDiff: true } : {}),
        });
        return {
            rewound: true,
            displayRevision: String(result.displayRevision),
            historyRevision: result.historyRevision,
            deletedMessageIds: [...result.deletedMessageIds],
            turnDiffRewind: {
                status: result.turnDiffRewind.status,
                ...('revertedTurnIds' in result.turnDiffRewind
                    ? { revertedTurnIds: [...result.turnDiffRewind.revertedTurnIds] }
                    : {}),
                ...('errorCode' in result.turnDiffRewind
                    ? { errorCode: result.turnDiffRewind.errorCode }
                    : {}),
            },
        };
    }
    catch (error) {
        throw mapMutationError(error);
    }
}
async function mapEdit(request, service, capability, planStateReader) {
    try {
        await requirePlanInactive(request.id, planStateReader);
        await requireMutationEligibleSession(request.id, capability);
        const result = await service.edit({
            sessionId: request.id,
            userMessageId: request.userMessageId,
            clientRequestId: request.clientRequestId,
            content: request.content,
            attachments: (request.attachments ?? []).map(toAgentHostAttachment),
            ...(request.rewindTurnDiff === true ? { rewindTurnDiff: true } : {}),
        });
        return {
            rewound: true,
            turnId: result.turnId,
            userMessageId: result.userMessageId,
            displayRevision: String(result.displayRevision),
            historyRevision: result.historyRevision,
            deletedMessageIds: [...result.deletedMessageIds],
        };
    }
    catch (error) {
        throw mapMutationError(error);
    }
}
async function requireMutationEligibleSession(sessionId, capability) {
    const session = await capability.sessions.get(sessionId);
    if (session && isConversationMutationEligibleSession(session, capability.sessionDataVersion)) {
        return;
    }
    throw toApplicationError(CONVERSATION_MUTATION_NOT_SUPPORTED, 'Fork, Rewind, and Edit require a top-level primary conversation or cron Session');
}
async function requirePlanInactive(sessionId, planStateReader) {
    const state = await planStateReader?.readPlanState(sessionId);
    if (!state?.active)
        return;
    throw toApplicationError(CONVERSATION_MUTATION_BUSY, 'Rewind and Edit are unavailable while Plan Mode or Plan lifecycle is active');
}
function asForkManifest(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const candidate = value;
    if (candidate.schemaVersion !== 1 ||
        !candidate.request ||
        typeof candidate.request.operationId !== 'string' ||
        typeof candidate.request.assistantDisplayMessageId !== 'string' ||
        !candidate.source ||
        typeof candidate.source.sessionId !== 'string' ||
        typeof candidate.source.assistantDisplayMessageId !== 'string') {
        return undefined;
    }
    return candidate;
}
function sameForkRequest(left, right) {
    return (left.operationId === right.operationId &&
        left.sourceSessionId === right.sourceSessionId &&
        sameForkAssistantSelector(left.assistantDisplayMessageId, right.assistantDisplayMessageId) &&
        (left.title ?? null) === (right.title ?? null) &&
        Boolean(left.useSuggestedTitle) === Boolean(right.useSuggestedTitle) &&
        Boolean(left.isolatedWorktree) === Boolean(right.isolatedWorktree) &&
        sameForkPlanState(left.planState, right.planState));
}
function sameForkAssistantSelector(persisted, requested) {
    return requested === undefined || persisted === requested;
}
function sameForkPlanState(left, right) {
    return (left?.interactionMode ?? null) === (right?.interactionMode ?? null);
}
function asRewindEditIntent(value) {
    if (!isRecord(value))
        return undefined;
    if (value.schemaVersion === 1) {
        return asLegacyRewindEditIntent(value);
    }
    return isModernRewindEditIntent(value) ? value : undefined;
}
const REWIND_EDIT_INTENT_STRING_FIELDS = [
    'operationId',
    'sessionId',
    'userMessageId',
    'requestFingerprint',
];
function isModernRewindEditIntent(value) {
    if (!isRecord(value))
        return false;
    return (value.schemaVersion === 2 &&
        isRewindEditKind(value.kind) &&
        REWIND_EDIT_INTENT_STRING_FIELDS.every((field) => typeof value[field] === 'string') &&
        typeof value.rewindTurnDiff === 'boolean' &&
        isStringArray(value.deletedDisplayMessageIds) &&
        isStringArray(value.displayAffectedTurnIds) &&
        hasValidDisplayOnlyRewindBoundary(value) &&
        (value.unresolvedQuestionnaireRequestIds === undefined ||
            isStringArray(value.unresolvedQuestionnaireRequestIds)));
}
function hasValidDisplayOnlyRewindBoundary(value) {
    return (value.displayOnlyBoundary === undefined ||
        isDisplayOnlyRewindBoundary(value.displayOnlyBoundary));
}
function isDisplayOnlyRewindBoundary(value) {
    return (isRecord(value) &&
        typeof value.turnId === 'string' &&
        value.turnId.length > 0 &&
        isStringArray(value.subsequentUserMessageIds) &&
        value.subsequentUserMessageIds.every((id) => id.startsWith('msg-user-v1-')) &&
        isStringArray(value.affectedTurnIds));
}
function isRewindEditKind(value) {
    return value === 'session-rewind' || value === 'session-edit';
}
function asLegacyRewindEditIntent(candidate) {
    if ((candidate.kind !== 'session-rewind' && candidate.kind !== 'session-edit') ||
        typeof candidate.operationId !== 'string' ||
        typeof candidate.sessionId !== 'string' ||
        typeof candidate.userMessageId !== 'string' ||
        typeof candidate.requestFingerprint !== 'string' ||
        typeof candidate.targetRevision !== 'string' ||
        !isStringArray(candidate.deletedMessageIds)) {
        return undefined;
    }
    return candidate;
}
function asRewindEditResult(value) {
    if (!isRecord(value))
        return undefined;
    const candidate = value;
    if (!hasRewindResultFields(candidate) || !hasValidAdmissionFields(candidate))
        return undefined;
    return candidate;
}
function hasRewindResultFields(value) {
    return (isStringArray(value.rewoundMessageIds) &&
        isStringArray(value.deletedMessageIds) &&
        typeof value.historyRevision === 'string' &&
        typeof value.displayRevision === 'number' &&
        isRecord(value.turnDiffRewind));
}
function hasValidAdmissionFields(value) {
    if (!('admitted' in value))
        return true;
    if (value.admitted !== true)
        return false;
    return typeof value.turnId === 'string' && typeof value.userMessageId === 'string';
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function toAttachmentInput(attachment) {
    return {
        meta: {
            attachmentType: attachment.type === 'image' ? 'image' : 'file',
            ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
            ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        },
        local: {
            ...(attachment.filePath ? { filePath: attachment.filePath } : {}),
            ...(attachment.dataUrl ? { dataUrl: attachment.dataUrl } : {}),
            ...(attachment.assetId ? { assetId: attachment.assetId } : {}),
        },
    };
}
function toAgentHostAttachment(attachment) {
    const meta = attachment.meta ?? {};
    return {
        type: meta.attachmentType,
        ...(meta.fileName ? { fileName: meta.fileName } : {}),
        ...(meta.mimeType ? { mimeType: meta.mimeType } : {}),
        ...(attachment.local?.filePath ? { filePath: attachment.local.filePath } : {}),
        ...(attachment.local?.dataUrl ? { dataUrl: attachment.local.dataUrl } : {}),
        ...(attachment.local?.assetId ? { assetId: attachment.local.assetId } : {}),
    };
}
function mapMutationError(error) {
    if (error instanceof RewindEditServiceError) {
        return toApplicationError(error.code, error.message);
    }
    if (error instanceof HistoryMutationError)
        return mapHistoryMutationError(error);
    return error;
}
function mapForkError(error) {
    const history = findCause(error, HistoryMutationError);
    if (history?.code === 'boundary-not-found') {
        return toApplicationError(CONVERSATION_MUTATION_REQUEST_CONFLICT, 'Fork source history changed; reopen Fork options and try again');
    }
    if (history)
        return mapHistoryMutationError(history);
    if (!(error instanceof ForkServiceError))
        return error;
    return toApplicationError(forkApplicationErrorCode(error), error.message);
}
function forkApplicationErrorCode(error) {
    if (error.code === 'request-conflict')
        return CONVERSATION_MUTATION_REQUEST_CONFLICT;
    if (error.code === 'busy')
        return CONVERSATION_MUTATION_BUSY;
    return FORK_ERROR_CODES[error.code] ?? FORK_COPY_FAILED;
}
const FORK_ERROR_CODES = {
    'source-not-found': MESSAGE_BOUNDARY_NOT_FOUND,
    'assistant-not-found': MESSAGE_BOUNDARY_NOT_FOUND,
    'assistant-not-settled': MESSAGE_BOUNDARY_INVALID,
    'invalid-boundary': MESSAGE_BOUNDARY_INVALID,
    'unsupported-session': CONVERSATION_MUTATION_NOT_SUPPORTED,
    'worktree-unavailable': FORK_WORKTREE_UNAVAILABLE,
    'worktree-source-changed': FORK_WORKTREE_SOURCE_CHANGED,
    'recovery-failed': FORK_RECOVERY_FAILED,
};
function mapHistoryMutationError(error) {
    if (error.code === 'boundary-not-found') {
        return toApplicationError(MESSAGE_BOUNDARY_NOT_FOUND, error.message);
    }
    if (error.code === 'boundary-invalid') {
        return toApplicationError(MESSAGE_BOUNDARY_INVALID, error.message);
    }
    if (error.code === 'identity-conflict') {
        return toApplicationError(HISTORY_IDENTITY_CONFLICT, error.message);
    }
    return toApplicationError(HISTORY_CHAIN_CORRUPT, error.message);
}
function toApplicationError(code, message) {
    return new ApplicationError(APPLICATION_STATUS_BY_CODE[code] ?? 409, code, message);
}
const APPLICATION_STATUS_BY_CODE = {
    [MESSAGE_BOUNDARY_NOT_FOUND]: 404,
    [MESSAGE_BOUNDARY_INVALID]: 400,
    [HISTORY_CHAIN_CORRUPT]: 500,
    [FORK_COPY_FAILED]: 500,
    [CONVERSATION_MUTATION_NOT_SUPPORTED]: 501,
    EDIT_SUBMIT_FAILED_AFTER_REWIND: 503,
    [EDIT_RESTART_NEEDS_NEW_OPERATION]: 409,
    [EDIT_RESTART_NEEDS_RESUBMIT]: 409,
    [FORK_RECOVERY_FAILED]: 409,
};
function findCause(error, constructor) {
    let current = error;
    const seen = new Set();
    while (current instanceof Error && !seen.has(current)) {
        if (current instanceof constructor)
            return current;
        seen.add(current);
        current = current.cause;
    }
    return undefined;
}
//# sourceMappingURL=conversation-mutation-workflow.js.map