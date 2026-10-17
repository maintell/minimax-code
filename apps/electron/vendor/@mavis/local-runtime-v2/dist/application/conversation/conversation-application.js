import { toUserModelSelection } from './model-selection.js';
import { TurnContinuationState as TurnContinuationStateView } from '@mavis/thrift-gen/generated/desktop-service/types';
import { normalizeAbortSource } from '@mavis/agent-core/pi-turn-runner';
import { isServerOwnedTurnId } from '@mavis/shared/turn-identity';
import { isSameSessionAgentName, QueueServiceError, } from '../../service/session-system/index.js';
import { DEFAULT_RETRY_CONTINUATION_PROMPT } from '../../service/turn-system/index.js';
import { AttachmentRegistrationError, attachmentRegistrationResponse, materializeLocalAttachmentInputs, } from './attachment-registration.js';
import { ApplicationError, turnAdmissionError } from './errors.js';
import { queueServiceApplicationError } from './queue-service-error.js';
import { countApplicationMetric } from '../session/metrics.js';
import { mapV2TurnStreamResult, openV2SessionStream } from './session-stream-delivery.js';
import { WorkspaceInitialSnapshotGateError, WORKSPACE_INITIAL_SNAPSHOT_FAILED, WORKSPACE_INITIAL_SNAPSHOT_FAILED_MESSAGE, } from './workspace-snapshot-gate.js';
/** Owns the conversation use cases migrated from SessionController. */
export class ConversationApplication {
    options;
    constructor(options) {
        this.options = options;
    }
    getActiveTurn(sessionId) {
        return this.options.turnInspection?.activeTurn(sessionId) ?? Promise.resolve(undefined);
    }
    steer(input) {
        return this.options.steer(input);
    }
    async steerSession(_ctx, req) {
        const result = await this.options.queueSteer.execute({
            sessionId: req.id,
            ...(req.queueItemId ? { queueItemId: req.queueItemId } : {}),
        });
        return { success: true, queueItemId: result.queueItemId, turnId: result.turnId };
    }
    async sendMessage(_ctx, req, options = {}) {
        const gateError = await this.sendMessageGateError(req, options);
        if (gateError)
            return gateError;
        let prepared;
        try {
            prepared = await toDirectSendInput(req, this.options.attachmentRegistration);
        }
        catch (error) {
            const mapped = sendMessagePreparationError(error);
            if (mapped) {
                return streamOpenError(mapped.status, mapped.key, mapped.message);
            }
            throw error;
        }
        const submission = prepared.submission;
        if (!submission) {
            await prepared.discardCreated();
            return streamOpenError(400, 'local_message_content_required', 'Local message content or attachments are required.');
        }
        try {
            const result = await this.options.directSend.open({
                ...submission,
                ...(options.pausedQueueAction ? { resumePausedQueue: true } : {}),
            });
            if (!result.accepted)
                await prepared.discardCreated();
            return mapV2TurnStreamResult(result);
        }
        catch (error) {
            await prepared.discardCreated();
            if (error instanceof WorkspaceInitialSnapshotGateError) {
                return streamOpenError(500, WORKSPACE_INITIAL_SNAPSHOT_FAILED, WORKSPACE_INITIAL_SNAPSHOT_FAILED_MESSAGE);
            }
            throw error;
        }
    }
    async sendMessageGateError(req, options) {
        const deadlineError = executionDeadlineAdmissionError(req, options);
        if (deadlineError) {
            return streamOpenError(deadlineError.status, deadlineError.key, deadlineError.message);
        }
        if (options.pausedQueueAction === 'clear' || req.clientIntent === 'paused-queue-clear') {
            try {
                await this.options.queue.clearUserManageable(req.id);
            }
            catch (error) {
                if (error instanceof QueueServiceError) {
                    const mapped = queueServiceApplicationError(error);
                    return streamOpenError(mapped.status, mapped.key, mapped.message);
                }
                throw error;
            }
        }
        if (req.turnId && isServerOwnedTurnId(req.turnId)) {
            return streamOpenError(400, 'local_turn_id_reserved', 'The requested Turn identity is reserved for an internal workflow.');
        }
        return this.reviewGateError(req);
    }
    /**
     * Slash Review admission checks. v1 enforced both in `routes/sessions.ts`
     * before the turn was admitted; the Agent owner cutover retired that route,
     * so they live here now.
     */
    async reviewGateError(req) {
        const error = await this.reviewAdmissionError(req);
        return error ? streamOpenError(error.status, error.key, error.message) : undefined;
    }
    async reviewAdmissionError(req) {
        if (!req.reviewRequest)
            return undefined;
        if (req.reviewRequest.scope !== 'local_changes') {
            return new ApplicationError(400, 'local_review_scope_unsupported', 'Only reviewRequest.scope="local_changes" is supported.');
        }
        const session = await this.options.sessionReader.find(req.id);
        if (session && (session.appMode ?? 'coding') !== 'coding') {
            return new ApplicationError(400, 'local_review_coding_mode_required', 'Built-in code review is only available in coding mode.');
        }
        return undefined;
    }
    async resumeSession(_ctx, req) {
        return this.withSessionLifecycle('resume', async () => {
            const session = await this.options.sessionReader.find(req.id);
            if (!session) {
                return streamOpenError(404, 'local_session_not_found', `Session not found: ${req.id}`);
            }
            const frames = this.options.stream.resume({
                sessionId: req.id,
                ...(req.afterMsgId ? { afterMsgId: req.afterMsgId } : {}),
                ...(req.afterCursor ? { afterCursor: req.afterCursor } : {}),
                waitForTerminal: shouldWaitForTerminal(req.drainQueued === true || req.continuePausedQueue === true, session.status),
            });
            try {
                if (req.continuePausedQueue) {
                    const result = await this.options.turn.dispatchSessionQueue(req.id);
                    if (result.status !== 'started')
                        throw queueContinueApplicationError(result, req.id);
                }
                else if (req.drainQueued) {
                    await this.options.turn.dispatchQueue(req.id);
                }
            }
            catch (error) {
                await frames.return?.();
                throw error;
            }
            return openV2SessionStream(frames);
        });
    }
    async inspectTurnContinuation(_ctx, req) {
        if (!(await this.options.sessionReader.find(req.id)))
            throw sessionNotFound(req.id);
        const result = await this.options.turn.inspectContinuation(req.id);
        return { state: turnContinuationStateView(result.state) };
    }
    async continueTurn(_ctx, req) {
        if (!(await this.options.sessionReader.find(req.id))) {
            return streamOpenError(404, 'local_session_not_found', `Session not found: ${req.id}`);
        }
        return mapV2TurnStreamResult(await this.options.continuation.open(req.id));
    }
    async abortSession(_ctx, req) {
        const abortSource = normalizeAbortSource(req.reason);
        const result = await this.withSessionLifecycle('abort', async () => {
            if (!(await this.options.sessionReader.find(req.id)))
                throw sessionNotFound(req.id);
            return this.options.turn.abort({
                sessionId: req.id,
                ...(req.turnId ? { turnId: req.turnId } : {}),
                reason: req.reason ?? 'user',
                ...(abortSource === 'user_stop' || abortSource === 'session_leave'
                    ? {
                        // Leaving a conversation pauses its Goal exactly like an explicit
                        // stop; only `user_stop` additionally cascades into background work.
                        onAccepted: () => this.pauseActiveGoalForAbort(req.id),
                    }
                    : {}),
            });
        });
        if (result.status === 'aborted' ||
            result.status === 'released' ||
            result.status === 'not-running') {
            return { success: true };
        }
        const timeout = result.status === 'abort-timeout';
        throw new ApplicationError(409, timeout ? 'local_turn_abort_timeout' : 'local_turn_not_active', timeout ? 'Abort was signalled but the Turn is still closing' : 'Turn is not active');
    }
    async pauseActiveGoalForAbort(sessionId) {
        try {
            await this.options.threadGoal.pauseActiveForAbort(sessionId);
        }
        catch {
            // Turn abort is authoritative; Goal pause remains a best-effort side effect.
        }
    }
    async enqueueMessage(_ctx, req) {
        const reviewAdmissionError = await this.reviewAdmissionError(req);
        if (reviewAdmissionError)
            throw reviewAdmissionError;
        let result;
        let discardCreated = async () => undefined;
        try {
            const input = await toEnqueueMessageInput(req, this.options.attachmentRegistration);
            discardCreated = input.discardCreated;
            result = await this.options.turn.submit({
                sessionId: input.sessionId,
                allowQueue: true,
                input: input.input,
                provenance: enqueueMessageProvenance(req),
                ...enqueueSubmissionMetadata(input),
            });
        }
        catch (error) {
            await discardCreated();
            throw enqueueApplicationError(error);
        }
        if (!result.accepted) {
            await discardCreated();
            throw submissionApplicationError(result.reason, req.id);
        }
        if (result.mode !== 'queued') {
            throw new Error('Queue-enabled submit returned a non-queued result');
        }
        return { itemId: result.queue.itemId, status: 'queued', position: result.queue.position };
    }
    async requestCompaction(_ctx, req) {
        return this.countBuiltinCommand('compact', async () => {
            validateCompactionName(req);
            await validateCompactionSession(req, this.options.sessionReader);
            const result = await this.options.turn.requestCompaction({
                sessionId: req.id,
                ...(req.reason ? { reason: req.reason } : {}),
                ...(req.customInstructions ? { customInstructions: req.customInstructions } : {}),
            });
            return compactionResponse(result, req.id);
        });
    }
    async withSessionLifecycle(action, run) {
        try {
            const result = await run();
            countApplicationMetric(this.options.metrics, 'session_lifecycle_total', {
                action,
                status: lifecycleSucceeded(result) ? 'ok' : 'error',
            });
            return result;
        }
        catch (error) {
            countApplicationMetric(this.options.metrics, 'session_lifecycle_total', {
                action,
                status: 'error',
            });
            throw error;
        }
    }
    async countBuiltinCommand(command, operation) {
        countApplicationMetric(this.options.metrics, 'builtin_command_total', {
            command,
            status: 'started',
        });
        try {
            const result = await operation();
            countApplicationMetric(this.options.metrics, 'builtin_command_total', {
                command,
                status: 'succeeded',
            });
            return result;
        }
        catch (error) {
            countApplicationMetric(this.options.metrics, 'builtin_command_total', {
                command,
                status: 'failed',
            });
            throw error;
        }
    }
}
function queueContinueApplicationError(result, sessionId) {
    if (result.status === 'rejected')
        return compactionRejectionError(result.reason, sessionId);
    if (result.status === 'not-claimed') {
        return new ApplicationError(409, 'local_queue_continue_not_claimed', 'The paused Queue head is no longer available');
    }
    return new ApplicationError(409, 'local_queue_continue_not_ready', 'The paused Queue head could not be started');
}
function shouldWaitForTerminal(drainQueued, status) {
    return drainQueued === true || status === 'started';
}
function turnContinuationStateView(state) {
    switch (state) {
        case 'available':
            return TurnContinuationStateView.Available;
        case 'running':
            return TurnContinuationStateView.Running;
        case 'waiting-for-user':
            return TurnContinuationStateView.WaitingForUser;
        default:
            return TurnContinuationStateView.Unavailable;
    }
}
export function createConversationApplication(options) {
    return new ConversationApplication(options);
}
function requireNonEmpty(value) {
    if (typeof value !== 'string')
        return undefined;
    return value.trim().length === 0 ? undefined : value;
}
async function toDirectSendInput(req, registration) {
    const executionOptions = directExecutionOptions(req);
    const materialized = await materializeLocalAttachmentInputs(registration, {
        sessionId: req.id,
        ...(req.turnId ? { turnId: req.turnId } : {}),
        attachments: req.attachments,
    });
    const attachments = materialized.executionAttachments;
    const clientIntent = normalizedRetryClientIntent(req.clientIntent, req.content, attachments.length > 0);
    const retryContinuation = clientIntent === 'retry-continuation';
    const text = directSendText(req.content, retryContinuation, attachments.length > 0);
    if (text === undefined) {
        return { submission: undefined, discardCreated: materialized.discardCreated };
    }
    return {
        submission: {
            sessionId: req.id,
            input: toAgentHostUserInput(req, text, attachments),
            ...executionOptions,
            provenance: messageProvenance(req),
            ...(req.displayContent !== undefined ? { displayContent: req.displayContent } : {}),
            ...(materialized.displayAttachments.length > 0
                ? { displayAttachments: materialized.displayAttachments }
                : {}),
            ...(req.turnId ? { requestedTurnId: req.turnId } : {}),
            ...(clientIntent ? { clientIntent } : {}),
            ...(retryContinuation ? { hideUserMessage: true } : {}),
        },
        discardCreated: materialized.discardCreated,
    };
}
function directExecutionOptions(req) {
    const outputContract = outputContractField(req);
    const deadlineError = executionDeadlineAdmissionError(req);
    if (deadlineError)
        throw deadlineError;
    const executionDeadlineAtMs = req.executionDeadlineAtMs;
    return {
        ...outputContract,
        ...(executionDeadlineAtMs !== undefined ? { executionDeadlineAtMs } : {}),
    };
}
function executionDeadlineAdmissionError(req, options = {}) {
    const deadline = req.executionDeadlineAtMs;
    if (deadline === undefined)
        return undefined;
    if (!Number.isSafeInteger(deadline) || deadline <= 0) {
        return new ApplicationError(400, 'local_execution_deadline_invalid', 'executionDeadlineAtMs must be a positive safe integer in Unix milliseconds.');
    }
    if (options.pausedQueueAction !== undefined ||
        ['paused-queue-clear', 'paused-queue-keep', 'composer-steer'].includes(req.clientIntent ?? '')) {
        return new ApplicationError(400, 'local_turn_invalid_input', 'Execution deadlines require an immediate Turn without steering or paused Queue intents.');
    }
    return undefined;
}
function outputContractField(req) {
    if (req.outputFormat !== undefined && req.outputSchema !== undefined) {
        throw new ApplicationError(400, 'local_output_format_conflict', 'outputFormat and outputSchema cannot be used together.');
    }
    if (req.outputSchema !== undefined) {
        return {
            outputContract: {
                type: 'json_schema',
                schema: snapshotLegacyOutputSchema(req.outputSchema),
            },
        };
    }
    if (req.outputFormat === undefined)
        return {};
    if (!isPlainRecord(req.outputFormat)) {
        throw invalidOutputFormat('outputFormat must be an object with a supported type.');
    }
    if (req.outputFormat.type === 'json_object') {
        assertExactKeys(req.outputFormat, ['type'], 'json_object outputFormat');
        return { outputContract: { type: 'json_object' } };
    }
    if (req.outputFormat.type === 'json_schema') {
        assertExactKeys(req.outputFormat, ['type', 'schema'], 'json_schema outputFormat');
        return {
            outputContract: {
                type: 'json_schema',
                schema: snapshotJsonSchemaObject(req.outputFormat.schema, 'outputFormat.schema'),
            },
        };
    }
    throw invalidOutputFormat('outputFormat.type must be json_object or json_schema.');
}
function snapshotLegacyOutputSchema(value) {
    if (!isPlainRecord(value)) {
        throw invalidOutputFormat('outputSchema must be a JSON Schema object.');
    }
    // Keep the legacy Host snapshot semantics, including optional undefined values.
    // Detach before attachment registration; Host validation still runs downstream.
    try {
        return structuredClone(value);
    }
    catch {
        throw invalidOutputFormat('outputSchema must support structured cloning.');
    }
}
function snapshotJsonSchemaObject(value, field) {
    if (!isPlainRecord(value)) {
        throw invalidOutputFormat(`${field} must be a JSON Schema object.`);
    }
    return snapshotJsonValue(value, field, new Set());
}
function snapshotJsonValue(value, path, ancestors) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number') {
        if (Number.isFinite(value))
            return value;
        throw invalidOutputFormat(`${path} must contain only finite JSON numbers.`);
    }
    if (typeof value !== 'object') {
        throw invalidOutputFormat(`${path} must contain only JSON-compatible values.`);
    }
    return snapshotJsonComposite(value, path, ancestors);
}
function snapshotJsonComposite(value, path, ancestors) {
    if (ancestors.has(value)) {
        throw invalidOutputFormat(`${path} must not contain circular references.`);
    }
    ancestors.add(value);
    try {
        return Array.isArray(value)
            ? snapshotJsonArray(value, path, ancestors)
            : snapshotJsonRecord(value, path, ancestors);
    }
    finally {
        ancestors.delete(value);
    }
}
function snapshotJsonArray(value, path, ancestors) {
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw invalidOutputFormat(`${path} must not contain symbol properties.`);
    }
    const snapshot = Array.from({ length: value.length }, (_, index) => {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
            throw invalidOutputFormat(`${path}[${String(index)}] must not be an array hole.`);
        }
        return snapshotJsonValue(value[index], `${path}[${String(index)}]`, ancestors);
    });
    return Object.freeze(snapshot);
}
function snapshotJsonRecord(value, path, ancestors) {
    if (!isPlainRecord(value)) {
        throw invalidOutputFormat(`${path} must contain only plain JSON objects.`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw invalidOutputFormat(`${path} must not contain symbol properties.`);
    }
    const snapshot = {};
    for (const [key, child] of Object.entries(value)) {
        Object.defineProperty(snapshot, key, {
            value: snapshotJsonValue(child, `${path}.${key}`, ancestors),
            enumerable: true,
            configurable: false,
            writable: false,
        });
    }
    return Object.freeze(snapshot);
}
function assertExactKeys(value, allowedKeys, field) {
    if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
        throw invalidOutputFormat(`${field} contains unsupported fields.`);
    }
}
function isPlainRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function invalidOutputFormat(message) {
    return new ApplicationError(400, 'local_output_format_invalid', message);
}
function messageProvenance(req) {
    if (req.clientIntent === 'cloud-handoff') {
        return {
            source: 'api',
            routingFingerprint: `cloud_handoff:${req.id}`,
            sourceContext: { cloudHandoff: { trigger: 'slash' } },
        };
    }
    if (!req.reviewRequest) {
        return {
            source: 'api',
            routingFingerprint: `api:${req.id}`,
            ...(req.executionDiagnostics === true
                ? { sourceContext: { executionDiagnostics: true } }
                : {}),
        };
    }
    return {
        source: 'code_review',
        routingFingerprint: `code_review:${req.id}`,
        sourceContext: {
            ...(req.executionDiagnostics === true ? { executionDiagnostics: true } : {}),
            review: {
                trigger: 'slash',
                scope: 'local_changes',
            },
        },
    };
}
function enqueueMessageProvenance(req) {
    if (req.reviewRequest || req.clientIntent === 'cloud-handoff')
        return messageProvenance(req);
    return {
        source: 'api',
        routingFingerprint: `api:${req.id}:${req.clientRequestId ?? 'queue'}`,
    };
}
function directSendText(content, retryContinuation, hasAttachments) {
    const text = content ?? '';
    if (text.trim().length > 0 || hasAttachments)
        return text;
    return retryContinuation ? DEFAULT_RETRY_CONTINUATION_PROMPT : undefined;
}
function normalizedRetryClientIntent(clientIntent, content, hasAttachments) {
    if (clientIntent !== 'retry-continuation')
        return clientIntent;
    return content?.trim() || hasAttachments ? 'retry-message' : clientIntent;
}
function toAgentHostUserInput(req, text, attachments) {
    return {
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(req.model ? { model: toUserModelSelection(req.model) } : {}),
        ...(req.computerUse ? { computerUse: { enable: req.computerUse.enable } } : {}),
    };
}
function enqueueSubmissionMetadata(input) {
    return {
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
        ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        delivery: {
            ...(input.displayAttachments ? { displayAttachments: input.displayAttachments } : {}),
        },
    };
}
function toComputerUseInput(computerUse) {
    return computerUse ? { computerUse: { enable: computerUse.enable } } : undefined;
}
async function toEnqueueMessageInput(req, registration) {
    const content = req.content ?? '';
    validateReservedQueueIdentity(req);
    const materialized = await materializeLocalAttachmentInputs(registration, {
        sessionId: req.id,
        attachments: req.attachments,
    });
    const attachments = materialized.executionAttachments;
    if (content.trim().length === 0 && attachments.length === 0) {
        throw new ApplicationError(400, 'local_queue_invalid', 'Queue message is invalid');
    }
    return {
        sessionId: req.id,
        input: {
            text: content,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(req.model ? { model: toUserModelSelection(req.model) } : {}),
            ...toComputerUseInput(req.computerUse),
        },
        ...(materialized.displayAttachments.length > 0
            ? { displayAttachments: materialized.displayAttachments }
            : {}),
        ...(req.clientRequestId ? { clientRequestId: req.clientRequestId } : {}),
        ...(req.expiresAt !== undefined ? { expiresAt: req.expiresAt } : {}),
        ...(req.clientIntent ? { clientIntent: req.clientIntent } : {}),
        discardCreated: materialized.discardCreated,
    };
}
function validateReservedQueueIdentity(req) {
    if (req.clientRequestId && isServerOwnedTurnId(req.clientRequestId)) {
        throw new ApplicationError(400, 'local_client_request_id_reserved', 'The Queue request identity is reserved for an internal workflow.');
    }
}
function validateCompactionName(req) {
    if (!requireNonEmpty(req.name)) {
        throw new ApplicationError(400, 'VALIDATION_ERROR', 'name is required');
    }
}
async function validateCompactionSession(req, sessionReader) {
    const session = await sessionReader.find(req.id);
    if (!session)
        throw sessionNotFound(req.id);
    // The caller-supplied Agent name is a page identity, never the owner of
    // record. A main-owned primary Session is still the same Agent as mavis.
    if (!isSameSessionAgentName(session.agentName, req.name)) {
        throw new ApplicationError(403, 'FORBIDDEN', 'sessionId does not belong to this agent');
    }
}
function compactionResponse(result, sessionId) {
    if (!result.accepted)
        throw compactionRejectionError(result.reason, sessionId);
    const outcome = result.outcome;
    if (outcome.status === 'completed') {
        return {
            success: true,
            sessionId,
            compactionId: outcome.compactionId,
            messagesBefore: outcome.messagesBefore,
            messagesAfter: outcome.messagesAfter,
            tokensBefore: outcome.tokensBefore,
            tokensAfter: outcome.tokensAfter,
        };
    }
    if (outcome.status === 'unchanged') {
        throw new ApplicationError(400, 'NOTHING_TO_COMPACT', 'Nothing to compact');
    }
    if (outcome.status === 'failed') {
        const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        throw new ApplicationError(500, 'local_compaction_failed', message);
    }
    throw new ApplicationError(409, 'local_compaction_aborted', outcome.reason ?? 'Compaction aborted');
}
function lifecycleSucceeded(result) {
    if (!result || typeof result !== 'object')
        return true;
    if ('status' in result)
        return result.status === 'aborted' || result.status === 'released';
    return true;
}
function sessionNotFound(sessionId) {
    return new ApplicationError(404, 'local_session_not_found', `Session not found: ${sessionId}`);
}
function enqueueApplicationError(error) {
    if (error instanceof QueueServiceError)
        return queueServiceApplicationError(error);
    if (error instanceof AttachmentRegistrationError) {
        const mapped = attachmentRegistrationResponse(error);
        return new ApplicationError(mapped.status, mapped.key, mapped.message);
    }
    return error;
}
function sendMessagePreparationError(error) {
    if (error instanceof ApplicationError)
        return error;
    if (!(error instanceof AttachmentRegistrationError))
        return undefined;
    const mapped = attachmentRegistrationResponse(error);
    return new ApplicationError(mapped.status, mapped.key, mapped.message);
}
function streamOpenError(status, key, message) {
    return { ok: false, status, body: { sseErrorCode: 0, code: status, key, message } };
}
function submissionApplicationError(reason, sessionId) {
    if (reason === 'invalid-input') {
        return new ApplicationError(400, 'local_queue_invalid', 'Queue message is invalid');
    }
    return compactionRejectionError(reason, sessionId);
}
function compactionRejectionError(...args) {
    const admissionError = turnAdmissionError(args[0]);
    return admissionError
        ? new ApplicationError(admissionError.status, admissionError.key, admissionError.message)
        : genericRejectionError(...args);
}
function genericRejectionError(reason, sessionId) {
    if (reason === 'invalid-session')
        return sessionNotFound(sessionId);
    if (reason === 'invalid-input') {
        return new ApplicationError(400, 'local_turn_invalid_input', 'Turn input is invalid');
    }
    if (reason === 'priority-blocked') {
        return new ApplicationError(409, 'local_session_has_queued_messages', 'An earlier queued message has priority');
    }
    if (reason === 'ingress-conflict') {
        return new ApplicationError(409, 'local_turn_ingress_conflict', 'Turn ingress conflicts');
    }
    const planError = planRejectionError(reason);
    if (planError)
        return planError;
    if (reason === 'duplicate') {
        return new ApplicationError(409, 'local_turn_duplicate', 'Turn was already accepted');
    }
    if (reason === 'session-deleting') {
        return new ApplicationError(409, 'local_session_deleting', 'Session is being deleted');
    }
    if (reason === 'session-mutating') {
        return new ApplicationError(409, 'local_session_mutating', 'Session conversation is being changed');
    }
    if (reason === 'compaction-active') {
        return new ApplicationError(409, 'local_session_compacting', 'Session compaction is active');
    }
    return new ApplicationError(409, 'local_session_busy', 'Session already has an active Turn. Retry with queueing enabled to deliver it later.');
}
function planRejectionError(reason) {
    if (reason === 'policy:plan:lifecycle-active') {
        return new ApplicationError(409, 'local_plan_lifecycle_active', 'Plan review processing must finish before this request can run');
    }
    if (reason === 'policy:plan:questionnaire-active') {
        return new ApplicationError(409, 'local_plan_questionnaire_active', 'Resolve the pending questionnaire before entering Plan Mode');
    }
    if (reason === 'policy:plan:entry-disabled') {
        return new ApplicationError(409, 'local_plan_entry_disabled', 'New Plan Mode entry is temporarily disabled');
    }
    if (reason === 'policy:plan:mode-conflict') {
        return new ApplicationError(409, 'local_plan_mode_conflict', 'Session mode changed before Plan Mode entry');
    }
    return undefined;
}
//# sourceMappingURL=conversation-application.js.map