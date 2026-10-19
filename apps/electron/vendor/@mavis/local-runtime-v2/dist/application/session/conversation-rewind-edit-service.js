import { createHash } from 'node:crypto';
import { CONVERSATION_MUTATION_NOT_SUPPORTED, CONVERSATION_MUTATION_REQUEST_CONFLICT, EDIT_RESTART_NEEDS_NEW_OPERATION, EDIT_RESTART_NEEDS_RESUBMIT, EDIT_SUBMIT_FAILED_AFTER_REWIND, HISTORY_CHAIN_CORRUPT, MESSAGE_BOUNDARY_INVALID, REWIND_DISPLAY_COMMIT_FAILED, TURN_ABORT_TIMEOUT, } from './conversation-mutation-errors.js';
export class RewindEditServiceError extends Error {
    code;
    rewound;
    constructor(code, message, rewound = false, options) {
        super(message, options);
        this.code = code;
        this.rewound = rewound;
        this.name = 'RewindEditServiceError';
    }
}
export class RewindEditService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async rewind(input) {
        this.validate(input);
        const result = await this.execute(input, 'session-rewind');
        if (isEditResult(result) || isNeedsResubmit(result))
            incompleteMutation();
        return result;
    }
    async edit(input) {
        this.validate(input);
        if (!input.content.trim()) {
            throw new RewindEditServiceError(MESSAGE_BOUNDARY_INVALID, 'content must not be empty');
        }
        const result = await this.execute(input, 'session-edit');
        if (isNeedsResubmit(result)) {
            throw new RewindEditServiceError(EDIT_RESTART_NEEDS_RESUBMIT, 'History was rewound before restart; submit the preserved draft as a new message', true);
        }
        if (!isEditResult(result))
            incompleteMutation();
        return result;
    }
    /** Recovery leaves post-canonical publication failures blocked for an idempotent retry. */
    async recoverPending() {
        const ports = this.requirePorts('session-edit');
        for (const kind of ['session-rewind', 'session-edit']) {
            const records = await ports.operations.listPending(kind);
            for (const record of records) {
                await this.recoverRecord(ports, record);
            }
        }
    }
    async recoverRecord(ports, record) {
        try {
            const persisted = record.intent;
            if (persisted?.schemaVersion === 1) {
                await recoverLegacyOperation(ports, record, persisted);
                return;
            }
            const intent = requireIntent(record);
            if (record.kind === 'session-edit' &&
                (record.stage === 'requested' || record.stage === 'planned')) {
                throw new RewindEditServiceError(EDIT_RESTART_NEEDS_NEW_OPERATION, 'Restarted Edit has no request body to resume; start a new request');
            }
            await this.resume({
                input: {
                    sessionId: intent.sessionId,
                    userMessageId: intent.userMessageId,
                    clientRequestId: intent.operationId,
                    ...(intent.rewindTurnDiff ? { rewindTurnDiff: true } : {}),
                },
                kind: record.kind,
                fingerprint: intent.requestFingerprint,
                record,
                ports,
                recoverOnly: true,
            });
        }
        catch (error) {
            if (isRetryableSessionPublication(error))
                return;
            await terminalizeRecoveryFailure(ports.operations, record, error, {
                operationId: record.operationId,
                sessionId: record.sessionId,
                kind: record.kind,
            });
        }
    }
    async execute(input, kind) {
        const ports = this.requirePorts(kind);
        const fingerprint = requestFingerprint(input, kind);
        const previous = await ports.operations.read({
            operationId: input.clientRequestId,
            kind,
        });
        if (previous?.status === 'completed' && previous.result) {
            assertMatchingTarget(previous, input);
            return previous.result;
        }
        if (previous?.status === 'failed') {
            assertMatchingTarget(previous, input);
            if (previous.error?.code === EDIT_RESTART_NEEDS_NEW_OPERATION) {
                throw new RewindEditServiceError(EDIT_RESTART_NEEDS_NEW_OPERATION, previous.error.message);
            }
            throw new RewindEditServiceError(HISTORY_CHAIN_CORRUPT, previous.error?.message ??
                'This conversation mutation did not complete; start a new request');
        }
        if (previous)
            assertMatchingIntent(previous, input, fingerprint);
        try {
            return await this.resume({ input, kind, fingerprint, record: previous, ports });
        }
        catch (error) {
            if (shouldTerminalizeMutation(error, kind)) {
                const current = await ports.operations.read({
                    operationId: input.clientRequestId,
                    kind,
                });
                await terminalizeRecoveryFailure(ports.operations, current ?? previous, error, {
                    operationId: input.clientRequestId,
                    sessionId: input.sessionId,
                    kind,
                });
            }
            throw error;
        }
    }
    async resume(input) {
        let record = input.record;
        if (!record)
            record = await createRequestedMutation(input);
        assertMatchingIntent(record, input.input, input.fingerprint);
        if (record.status === 'completed' && record.result)
            return record.result;
        record = await abortAndPlanMutation(input, record);
        record = await publishTurnMutation(input, record);
        record = await publishSessionMutation(input, record);
        const sessionResult = await publishQuestionnaireMutation(input, record);
        await publishBestEffort(input.ports, input.input, sessionResult);
        return finishMutation(input, sessionResult);
    }
    validate(input) {
        if (!input.sessionId.trim() ||
            !input.clientRequestId.trim() ||
            !/^msg-user-v1-\S+$/u.test(input.userMessageId)) {
            throw new RewindEditServiceError(MESSAGE_BOUNDARY_INVALID, 'Rewind/Edit requires a committed msg-user-v1 user message');
        }
    }
    requirePorts(kind) {
        const deps = this.deps;
        if (!deps.operations ||
            !deps.turn ||
            !deps.session ||
            !deps.questionnaires ||
            !deps.projection ||
            !deps.events ||
            (kind === 'session-edit' && !deps.submit)) {
            throw new RewindEditServiceError(CONVERSATION_MUTATION_NOT_SUPPORTED, 'Conversation mutation workflow is not supported');
        }
        return deps;
    }
}
async function createRequestedMutation(input) {
    const intent = {
        schemaVersion: 2,
        kind: input.kind,
        operationId: input.input.clientRequestId,
        sessionId: input.input.sessionId,
        userMessageId: input.input.userMessageId,
        requestFingerprint: input.fingerprint,
        rewindTurnDiff: requestedTurnDiff(input.input),
        deletedDisplayMessageIds: [],
        displayAffectedTurnIds: [],
        unresolvedQuestionnaireRequestIds: [],
    };
    return input.ports.operations.advance({
        operationId: input.input.clientRequestId,
        sessionId: input.input.sessionId,
        kind: input.kind,
        status: 'running',
        stage: 'requested',
        intent,
    });
}
async function abortAndPlanMutation(input, record) {
    if (requireStage(record.stage) !== 'requested')
        return record;
    const abort = await input.ports.turn.abort({
        sessionId: input.input.sessionId,
        reason: 'conversation-mutation',
    });
    if (abort.status === 'abort-timeout') {
        throw new RewindEditServiceError(TURN_ABORT_TIMEOUT, 'Conversation abort timed out');
    }
    const display = await input.ports.session.planInclusive({
        sessionId: input.input.sessionId,
        fromMessageId: input.input.userMessageId,
    });
    if (display.targetIsQuestionnaireResponse &&
        (input.kind === 'session-edit' || !display.targetQuestionnaireResponseRewindEligible)) {
        throw new RewindEditServiceError(MESSAGE_BOUNDARY_INVALID, 'Questionnaire responses cannot be rewound or edited');
    }
    const unresolvedQuestionnaireRequestIds = await input.ports.questionnaires.snapshotUnresolvedForRewind(input.input.sessionId);
    const intent = {
        ...requireIntent(record),
        deletedDisplayMessageIds: display.deletedMessageIds,
        displayAffectedTurnIds: display.affectedTurnIds,
        ...(display.targetTurnId
            ? {
                displayOnlyBoundary: {
                    turnId: display.targetTurnId,
                    subsequentUserMessageIds: [...(display.subsequentUserMessageIds ?? [])],
                    affectedTurnIds: [...display.affectedTurnIds],
                },
            }
            : {}),
        unresolvedQuestionnaireRequestIds,
    };
    return input.ports.operations.advance({
        operationId: input.input.clientRequestId,
        sessionId: input.input.sessionId,
        kind: input.kind,
        status: 'running',
        stage: 'planned',
        intent,
    });
}
async function publishTurnMutation(input, record) {
    if (requireStage(record.stage) !== 'planned')
        return record;
    const intent = requireIntent(record);
    const turn = await input.ports.turn.rewind({
        sessionId: input.input.sessionId,
        fromUserMessageIdInclusive: input.input.userMessageId,
        operationId: input.input.clientRequestId,
        ...(intent.rewindTurnDiff ? { rewindTurnDiff: true } : {}),
        ...(intent.displayOnlyBoundary ? { displayOnlyBoundary: intent.displayOnlyBoundary } : {}),
    });
    const result = rewindResult(input.input.userMessageId, intent.deletedDisplayMessageIds, turn);
    return input.ports.operations.advance({
        operationId: input.input.clientRequestId,
        sessionId: input.input.sessionId,
        kind: input.kind,
        status: 'running',
        stage: 'turn-published',
        intent,
        result,
    });
}
async function publishSessionMutation(input, record) {
    const stage = requireStage(record.stage);
    if (stage === 'session-published' || stage === 'questionnaire-published')
        return record;
    const existing = record.result && isRewindResult(record.result) ? rewindOnly(record.result) : null;
    if (stage !== 'turn-published' || !existing)
        incompleteMutation();
    const intent = requireIntent(record);
    try {
        const display = await input.ports.session.commit({
            sessionId: input.input.sessionId,
            fromMessageId: input.input.userMessageId,
            expectedDeletedMessageIds: intent.deletedDisplayMessageIds,
            affectedTurnIds: turnAffectedIds(record.result) ?? intent.displayAffectedTurnIds,
        });
        const result = {
            ...existing,
            deletedMessageIds: display.deletedMessageIds,
            displayRevision: display.displayRevision,
        };
        return await input.ports.operations.advance({
            operationId: input.input.clientRequestId,
            sessionId: input.input.sessionId,
            kind: input.kind,
            status: 'running',
            stage: 'session-published',
            intent,
            result,
        });
    }
    catch (error) {
        throw new RewindEditServiceError(REWIND_DISPLAY_COMMIT_FAILED, 'Canonical history was committed but Session projections are pending retry', true, { cause: error });
    }
}
async function publishQuestionnaireMutation(input, record) {
    const stage = requireStage(record.stage);
    const existing = record.result && isRewindResult(record.result) ? rewindOnly(record.result) : undefined;
    if (stage === 'questionnaire-published' && existing)
        return existing;
    if (stage !== 'session-published' || !existing)
        incompleteMutation();
    const intent = requireIntent(record);
    try {
        const requestIds = intent.unresolvedQuestionnaireRequestIds ?? [];
        if (requestIds.length > 0) {
            await input.ports.questionnaires.cancelUnresolvedForRewind({
                sessionId: input.input.sessionId,
                requestIds,
            });
        }
        await input.ports.operations.advance({
            operationId: input.input.clientRequestId,
            sessionId: input.input.sessionId,
            kind: input.kind,
            status: 'running',
            stage: 'questionnaire-published',
            intent,
            result: existing,
        });
        return existing;
    }
    catch (error) {
        throw new RewindEditServiceError(REWIND_DISPLAY_COMMIT_FAILED, 'Canonical history was committed but Session projections are pending retry', true, { cause: error });
    }
}
function rewindResult(userMessageId, deletedMessageIds, turn) {
    return {
        rewoundMessageIds: [userMessageId],
        deletedMessageIds,
        historyRevision: turn.historyRevision,
        displayRevision: 0,
        turnDiffRewind: turn.turnDiffRewind,
        affectedTurnIds: turn.affectedTurnIds,
    };
}
async function finishMutation(input, result) {
    if (input.kind === 'session-rewind') {
        await completeMutation(input, result);
        return result;
    }
    if (input.recoverOnly) {
        const degraded = {
            ...result,
            rewound: true,
            needsResubmit: true,
        };
        await completeMutation(input, degraded);
        return degraded;
    }
    return submitEditedTurn(input, result);
}
async function submitEditedTurn(input, rewind) {
    const edit = requireEditRequest(input.input);
    try {
        const admitted = await input.ports.submit.submit({
            sessionId: edit.sessionId,
            operationId: edit.clientRequestId,
            content: edit.content,
            attachments: edit.attachments ?? [],
        });
        const result = { ...rewind, admitted: true, ...admitted };
        await completeMutation(input, result);
        return result;
    }
    catch (error) {
        throw new RewindEditServiceError(EDIT_SUBMIT_FAILED_AFTER_REWIND, 'Edit submission failed after rewind', true, { cause: error });
    }
}
async function completeMutation(input, result) {
    await input.ports.operations.complete({
        operationId: input.input.clientRequestId,
        sessionId: input.input.sessionId,
        kind: input.kind,
        result,
    });
}
async function terminalizeRecoveryFailure(operations, record, error, fallback) {
    const intent = record?.intent;
    const identity = intent
        ? { operationId: intent.operationId, sessionId: intent.sessionId, kind: intent.kind }
        : fallback;
    if (!identity)
        return;
    await operations.fail({
        ...identity,
        stage: record?.stage ?? 'recovery-failed',
        ...(intent ? { intent } : {}),
        error: {
            code: error instanceof RewindEditServiceError && error.code === EDIT_RESTART_NEEDS_NEW_OPERATION
                ? EDIT_RESTART_NEEDS_NEW_OPERATION
                : 'CONVERSATION_MUTATION_RECOVERY_FAILED',
            message: error instanceof Error
                ? error.message
                : 'Conversation mutation recovery failed; start a new request',
        },
    });
}
function requireEditRequest(input) {
    if ('content' in input)
        return input;
    incompleteMutation();
}
function requestFingerprint(input, kind) {
    const edit = kind === 'session-edit' ? input : undefined;
    return createHash('sha256')
        .update(stableJson({
        kind,
        sessionId: input.sessionId,
        userMessageId: input.userMessageId,
        rewindTurnDiff: requestedTurnDiff(input),
        ...(edit ? { content: edit.content, attachments: edit.attachments ?? [] } : {}),
    }))
        .digest('hex');
}
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
function requestedTurnDiff(input) {
    return input.rewindTurnDiff === true;
}
function assertMatchingIntent(record, input, fingerprint) {
    const intent = assertMatchingTarget(record, input);
    if (intent.schemaVersion !== 2)
        requestConflict();
    if (intent.requestFingerprint !== fingerprint)
        requestConflict();
}
function assertMatchingTarget(record, input) {
    const intent = record.intent;
    if (!intent ||
        intent.operationId !== input.clientRequestId ||
        intent.sessionId !== input.sessionId ||
        intent.userMessageId !== input.userMessageId ||
        intent.kind !== record.kind) {
        requestConflict();
    }
    return intent;
}
function requestConflict() {
    throw new RewindEditServiceError(CONVERSATION_MUTATION_REQUEST_CONFLICT, 'Operation ID was already used for a different mutation request');
}
function requireIntent(record) {
    if (!record.intent || record.intent.schemaVersion !== 2)
        incompleteMutation();
    return record.intent;
}
async function recoverLegacyOperation(ports, record, intent) {
    if (record.kind !== 'session-edit' ||
        (record.stage !== 'canonical-published' && record.stage !== 'display-published')) {
        incompleteMutation();
    }
    const affectedTurnIds = record.stage === 'canonical-published'
        ? (await ports.session.planInclusive({
            sessionId: intent.sessionId,
            fromMessageId: intent.userMessageId,
        })).affectedTurnIds
        : [];
    const display = await ports.session.commit({
        sessionId: intent.sessionId,
        fromMessageId: intent.userMessageId,
        expectedDeletedMessageIds: intent.deletedMessageIds,
        affectedTurnIds,
    });
    await ports.operations.complete({
        operationId: intent.operationId,
        sessionId: intent.sessionId,
        kind: intent.kind,
        result: {
            rewoundMessageIds: [intent.userMessageId],
            deletedMessageIds: display.deletedMessageIds,
            historyRevision: intent.targetRevision,
            displayRevision: display.displayRevision,
            turnDiffRewind: { status: 'not-requested' },
            rewound: true,
            needsResubmit: true,
        },
    });
}
function requireStage(stage) {
    if (stage === 'requested' ||
        stage === 'planned' ||
        stage === 'turn-published' ||
        stage === 'session-published' ||
        stage === 'questionnaire-published') {
        return stage;
    }
    incompleteMutation();
}
function incompleteMutation() {
    throw new RewindEditServiceError(HISTORY_CHAIN_CORRUPT, 'Conversation mutation state is incomplete');
}
function isRewindResult(value) {
    return (Array.isArray(value.rewoundMessageIds) &&
        Array.isArray(value.deletedMessageIds) &&
        typeof value.historyRevision === 'string' &&
        typeof value.displayRevision === 'number');
}
function rewindOnly(value) {
    return {
        rewoundMessageIds: value.rewoundMessageIds,
        deletedMessageIds: value.deletedMessageIds,
        historyRevision: value.historyRevision,
        displayRevision: value.displayRevision,
        turnDiffRewind: value.turnDiffRewind,
    };
}
function turnAffectedIds(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const affected = Reflect.get(value, 'affectedTurnIds');
    return Array.isArray(affected) && affected.every((entry) => typeof entry === 'string')
        ? affected
        : undefined;
}
function isEditResult(value) {
    return 'admitted' in value && value.admitted === true;
}
function isNeedsResubmit(value) {
    return 'needsResubmit' in value && value.needsResubmit === true;
}
function isRetryableEditSubmission(error, kind) {
    return (kind === 'session-edit' &&
        error instanceof RewindEditServiceError &&
        error.code === EDIT_SUBMIT_FAILED_AFTER_REWIND);
}
function isRetryableSessionPublication(error) {
    return (error instanceof RewindEditServiceError &&
        error.code === REWIND_DISPLAY_COMMIT_FAILED &&
        error.rewound);
}
function shouldTerminalizeMutation(error, kind) {
    return !isRetryableEditSubmission(error, kind) && !isRetryableSessionPublication(error);
}
async function publishBestEffort(ports, input, result) {
    await Promise.allSettled([
        ports.projection.project({
            sessionId: input.sessionId,
            operationId: input.clientRequestId,
            rewoundMessageIds: result.rewoundMessageIds,
            deletedMessageIds: result.deletedMessageIds,
        }),
        ports.events.publish({
            sessionId: input.sessionId,
            operationId: input.clientRequestId,
            deletedMessageIds: result.deletedMessageIds,
        }),
    ]);
}
//# sourceMappingURL=conversation-rewind-edit-service.js.map