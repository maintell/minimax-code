import { createHash, randomUUID } from 'node:crypto';
import { isServerOwnedTurnId } from '@mavis/shared/turn-identity';
import { readFile } from 'node:fs/promises';
import { createUserMessageId, fallbackSessionTitle, stripSessionTitleInjectedTags, SideChatError, } from '../../service/session-system/index.js';
import { toQueueInput, queueModelFromAgentHost, } from '../../service/turn-system/index.js';
import { AppError } from '../errors.js';
import { publishBestEffort } from '../events.js';
import { toDirectSendInput, reviewAdmissionError, } from '../conversation/conversation-application.js';
import { AttachmentRegistrationError, attachmentRegistrationResponse, } from '../conversation/attachment-registration.js';
import { projectedMessageContent, shouldProjectMessage, } from '../conversation/user-message-turn-delivery.js';
import { toUserModelSelection } from '../conversation/model-selection.js';
import { toSessionInfoView } from './wire.js';
import { copySideChatAssets } from './sidechat-asset-copy.js';
import { selectSideChatDisplayPrefix } from './sidechat-history-copy.js';
/** Process-scoped idempotency surrounds file preparation and one durable admission. */
export class SideChatApplication {
    options;
    operations = new Map();
    closed = false;
    dispatchObservations = new WeakSet();
    constructor(options) {
        this.options = options;
    }
    async createSideChat(_context, req) {
        if (!req.clientRequestId?.trim())
            throw new AppError(400, 'CLIENT_REQUEST_ID_REQUIRED', 'clientRequestId is required');
        if (req.createOnly &&
            [
                req.content,
                req.attachments,
                req.turnId,
                req.clientIntent,
                req.enableTeam,
                req.reviewRequest,
                req.computerUse,
            ].some((value) => value !== undefined))
            throw new AppError(400, 'SIDECHAT_CREATE_ONLY_INPUT', 'createOnly cannot include message or Turn fields');
        return this.runOperation({
            mainSessionId: req.id,
            requestId: req.clientRequestId,
            fingerprint: await requestFingerprint(req),
            prepare: (pending, signal) => this.prepare(req, pending, signal),
            turnId: req.turnId,
            createOnly: req.createOnly,
        });
    }
    async createSideChatFromQueue(_context, req) {
        if (!req.clientRequestId?.trim())
            throw new AppError(400, 'CLIENT_REQUEST_ID_REQUIRED', 'clientRequestId is required');
        const alias = stableJson(['queue', req.id, req.itemId]);
        const fingerprint = stableJson({ kind: 'queue', itemId: req.itemId });
        return this.runOperation({
            mainSessionId: req.id,
            requestId: req.clientRequestId,
            fingerprint,
            prepare: (pending, signal) => this.prepareQueue(req, pending, signal),
            alias,
        });
    }
    async promoteSideChat(_context, req) {
        if (!req.clientRequestId?.trim())
            throw new AppError(400, 'CLIENT_REQUEST_ID_REQUIRED', 'clientRequestId is required');
        return this.runOperation({
            mainSessionId: req.id,
            requestId: req.clientRequestId,
            fingerprint: 'promote',
            targetSessionId: req.id,
            prepare: async (pending) => {
                const result = this.options.sideChats.promote(req.id, Date.now());
                if (result.previousMainSessionId)
                    publishBestEffort(this.options.publish, {
                        type: 'session.visibility_updated',
                        payload: {
                            sessionId: req.id,
                            agentName: result.session.agentName,
                            visibility: 'visible',
                            previousMainSessionId: result.previousMainSessionId,
                        },
                    });
                return {
                    state: 1,
                    operationId: pending.operationId,
                    sessionId: req.id,
                    session: toSessionInfoView(result.session),
                };
            },
        });
    }
    async runOperation(request) {
        const key = stableJson([request.mainSessionId, request.requestId]);
        const existing = this.operations.get(key) ?? (request.alias ? this.operations.get(request.alias) : undefined);
        if (existing) {
            if (existing.fingerprint !== request.fingerprint)
                throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'The request identity was already used with different input');
            if (existing.committed && !(await this.options.sessions.get(existing.committed.sessionId)))
                throw new AppError(410, 'SIDECHAT_RESULT_DELETED', 'The previously created SideChat was deleted');
        }
        const operation = existing ?? this.createOperation(request);
        this.operations.set(key, operation);
        if (request.alias)
            this.operations.set(request.alias, operation);
        return this.observeOperation(operation);
    }
    async observeOperation(operation) {
        let timer;
        try {
            return {
                result: await Promise.race([
                    operation.done,
                    new Promise((resolve) => {
                        timer = setTimeout(() => resolve(operation.result), 100);
                    }),
                ]),
            };
        }
        catch (error) {
            // A failed Pending operation stays available until a caller observes its error.
            for (const [key, entry] of this.operations)
                if (entry === operation)
                    this.operations.delete(key);
            throw error;
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    createOperation(request) {
        if (this.closed)
            throw new AppError(503, 'SIDECHAT_PREPARATION_FAILED', 'Runtime is closing');
        const sessionId = request.targetSessionId ?? `session_${randomUUID()}`;
        const result = {
            state: 0,
            operationId: randomUUID(),
            sessionId,
            ...(request.targetSessionId || request.createOnly
                ? {}
                : { firstTurnId: request.turnId ?? `turn_${randomUUID()}` }),
            retryAfterMs: 100,
        };
        const controller = new AbortController();
        return {
            fingerprint: request.fingerprint,
            result,
            controller,
            done: this.completeOperation(request, result, controller.signal),
        };
    }
    async completeOperation(request, pending, signal) {
        try {
            const result = await request.prepare(pending, signal);
            const operation = this.operations.get(stableJson([request.mainSessionId, request.requestId]));
            if (operation)
                operation.committed = result;
            return result;
        }
        catch (error) {
            throw sideChatApplicationError(error);
        }
    }
    async close() {
        this.closed = true;
        for (const operation of this.operations.values())
            if (!operation.committed)
                operation.controller.abort(new Error('Runtime is closing'));
        await Promise.allSettled([...this.operations.values()].map((operation) => operation.done));
        this.operations.clear();
    }
    async prepare(req, pending, signal) {
        const source = await this.options.sessions.get(req.id);
        if (!source)
            throw new AppError(404, 'local_session_not_found', `Session not found: ${req.id}`);
        if (req.createOnly)
            return this.commitPrepared({
                mainSessionId: req.id,
                pending,
                signal,
                ...(req.model ? { model: queueModelFromAgentHost(toUserModelSelection(req.model)) } : {}),
            });
        if (req.turnId && isServerOwnedTurnId(req.turnId))
            throw new AppError(400, 'local_turn_id_reserved', 'The requested Turn identity is reserved for an internal workflow.');
        const reviewError = await reviewAdmissionError(req, (id) => this.options.sessions.get(id));
        if (reviewError)
            throw reviewError;
        const prepared = await toDirectSendInput({ ...req, id: pending.sessionId, turnId: pending.firstTurnId }, this.options.registration);
        try {
            const submission = prepared.submission;
            if (!submission)
                throw new AppError(400, 'local_message_content_required', 'Local message content or attachments are required.');
            const input = toQueueInput({
                ...submission,
                allowQueue: true,
                delivery: {
                    displayAttachments: submission.displayAttachments,
                    hideUserMessage: submission.hideUserMessage,
                },
            }, {
                requestedTurnId: pending.firstTurnId,
                userMessageId: createUserMessageId({
                    sessionId: pending.sessionId,
                    messageKey: `turn:${pending.firstTurnId}`,
                }),
                agentName: source.agentName,
                source: submission.provenance.source === 'code_review' ? 'code_review' : 'api',
            });
            return await this.commitPrepared({ mainSessionId: req.id, pending, signal, input });
        }
        catch (error) {
            await prepared.discardCreated();
            throw error;
        }
    }
    async prepareQueue(req, pending, signal) {
        pending.sourceQueueItemId = req.itemId;
        const claim = (await this.options.queue.claimNext({ sessionId: req.id, itemId: req.itemId }))
            .value;
        if (!claim) {
            throw new AppError(409, 'QUEUE_ITEM_NOT_TRANSFERABLE', 'Queue item is no longer transferable');
        }
        const claimController = new AbortController();
        const abort = () => claimController.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted)
            abort();
        const renew = setInterval(() => {
            try {
                if (!this.options.queue.renewClaim(req.id, claim.claimId))
                    claimController.abort(new Error('Queue claim lost'));
            }
            catch (error) {
                claimController.abort(error);
            }
        }, 10000);
        let committed = false;
        let copied;
        try {
            const item = claim.item;
            const input = {
                message: { ...item.message, queueItemId: undefined },
                source: item.source,
                model: item.model,
                requestedTurnId: pending.firstTurnId,
                userMessageId: createUserMessageId({
                    sessionId: pending.sessionId,
                    messageKey: `turn:${pending.firstTurnId}`,
                }),
                ...(item.immediateSendBatch
                    ? {
                        immediateSendBatch: {
                            id: randomUUID(),
                            members: item.immediateSendBatch.members.map((member, index) => {
                                const preserved = { ...member };
                                delete preserved.queueClaim;
                                delete preserved.unconsumedFromTurnIds;
                                delete preserved.unstartedFromTurnIds;
                                const messageKey = `sidechat:${pending.operationId}:${index}`;
                                return {
                                    ...preserved,
                                    message: { ...member.message, queueItemId: undefined },
                                    messageKey,
                                    userMessageId: createUserMessageId({
                                        sessionId: pending.sessionId,
                                        messageKey,
                                    }),
                                };
                            }),
                        },
                    }
                    : {}),
            };
            const source = await this.options.sessions.get(req.id);
            if (!source)
                throw new AppError(404, 'local_session_not_found', `Session not found: ${req.id}`);
            copied = await copySideChatAssets({
                sessionId: pending.sessionId,
                workspaceDir: source.workspaceDir,
                display: [input],
                history: { active: [], snapshots: [], historyRevision: '' },
                registration: this.options.registration,
            });
            const result = await this.commitPrepared({
                mainSessionId: req.id,
                pending,
                signal: claimController.signal,
                input: copied.display[0],
                sourceClaim: claim,
            });
            committed = true;
            return result;
        }
        finally {
            clearInterval(renew);
            signal.removeEventListener('abort', abort);
            if (!committed) {
                await copied?.discard();
                await this.options.queue.releaseClaim(req.id, claim.claimId);
            }
        }
    }
    async dispatchCommitted(sessionId) {
        try {
            await this.options.dispatch(sessionId);
        }
        catch {
            /* Durable queue admission survives dispatch failure. */
        }
    }
    async commitPrepared(request) {
        const { mainSessionId, pending, signal, input, sourceClaim } = request;
        const source = await this.options.sessions.get(mainSessionId);
        if (!source)
            throw new AppError(404, 'local_session_not_found', `Session not found: ${mainSessionId}`);
        let staged;
        let committed = false;
        let discardAssets;
        try {
            const model = await this.options.sideChats.prepareModel(mainSessionId, request.model ?? input?.model);
            const createdAtMs = Date.now();
            staged = await this.options.prepareHistory({
                sourceSessionId: mainSessionId,
                target: { sessionId: pending.sessionId, createdAtMs },
                signal,
                captureDisplay: async (frozen) => {
                    const copied = await copySideChatAssets({
                        sessionId: pending.sessionId,
                        workspaceDir: source.workspaceDir,
                        display: selectSideChatDisplayPrefix((await this.options.messages.listAfter(mainSessionId)).messages, frozen),
                        history: frozen,
                        registration: this.options.registration,
                    });
                    discardAssets = copied.discard;
                    return copied;
                },
            });
            signal.throwIfAborted();
            const result = this.options.sideChats.commit({
                mainSessionId,
                sessionId: pending.sessionId,
                createdAtMs,
                title: input ? sideChatInitialTitle(input) : 'SideChat',
                historyRelativeDir: staged.historyRelativeDir,
                historyRevision: staged.historyRevision,
                targetRevision: staged.targetRevision,
                messageCount: staged.messageCount,
                sourceMessageId: staged.display.at(-1)?.msg_id,
                display: staged.display,
                ...(sourceClaim ? { sourceClaim } : {}),
                model,
                ...(input ? { input: { ...input, ...(model ? { model } : {}) } } : {}),
            });
            committed = true;
            this.publishCreated(mainSessionId, result);
            return {
                state: 1,
                operationId: pending.operationId,
                sessionId: pending.sessionId,
                ...(pending.firstTurnId ? { firstTurnId: pending.firstTurnId } : {}),
                ...(sourceClaim ? { sourceQueueItemId: sourceClaim.item.itemId } : {}),
                session: toSessionInfoView(result.session, { mainSessionId, createdAtMs }),
            };
        }
        finally {
            if (!committed) {
                await staged?.rollback();
                await discardAssets?.();
            }
        }
    }
    publishCreated(mainSessionId, result) {
        publishBestEffort(this.options.publish, {
            type: 'session.created',
            payload: {
                sessionId: result.session.sessionId,
                agentName: result.session.agentName,
                sessionType: 'branch',
                sessionKind: 'conversation',
                visibility: 'hidden',
                title: result.session.title,
                mainSessionId,
            },
        });
        try {
            this.options.publishQueueFacts([
                ...(result.consumed?.facts ?? []),
                ...(result.queued?.facts ?? []),
            ]);
        }
        catch {
            /* Committed admission remains authoritative. */
        }
        if (result.queued)
            this.dispatchObservations.add(this.dispatchCommitted(result.session.sessionId));
    }
}
async function requestFingerprint(req) {
    const { attachments } = req;
    const input = { ...req };
    delete input.attachments;
    delete input.baseReq;
    delete input.clientRequestId;
    const stableAttachments = await Promise.all((attachments ?? []).map(async (attachment) => {
        const bytes = await attachmentSourceBytes(attachment.local);
        return {
            meta: attachment.meta,
            ...(bytes ? { digest: createHash('sha256').update(bytes).digest('hex') } : { attachment }),
        };
    }));
    return createHash('sha256')
        .update(stableJson({ ...input, attachments: stableAttachments }))
        .digest('hex');
}
/**
 * Content identity for idempotent creation, read in the same order as asset
 * registration: an inline data URL wins over a path, because a pasted image
 * carries only its bare file name. An unreadable source falls back to the
 * attachment metadata; registration stays the one place that rejects it.
 */
async function attachmentSourceBytes(source) {
    if (source?.dataUrl?.startsWith('data:'))
        return Buffer.from(source.dataUrl.slice(source.dataUrl.indexOf(',') + 1), 'base64');
    if (!source?.filePath)
        return undefined;
    try {
        return await readFile(source.filePath);
    }
    catch {
        return undefined;
    }
}
function stableJson(value) {
    return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
        : item);
}
function sideChatApplicationError(error) {
    if (error instanceof SideChatError) {
        // This error reaches the boundary only after the transaction and prepared files rolled back.
        if (error.code === 'SIDECHAT_PREPARATION_FAILED')
            return new AppError(503, error.code, error.message, true);
        return new AppError(409, error.code, error.message);
    }
    if (error instanceof AttachmentRegistrationError) {
        const mapped = attachmentRegistrationResponse(error);
        return new AppError(mapped.status, mapped.key, mapped.message);
    }
    return error;
}
function sideChatInitialTitle(input) {
    const messages = input.immediateSendBatch?.members.map((member) => member.message) ?? [
        input.message,
    ];
    const firstVisibleMessage = messages.find(shouldProjectMessage);
    const titleSource = projectedMessageContent(firstVisibleMessage, firstVisibleMessage?.content ?? '');
    return fallbackSessionTitle(stripSessionTitleInjectedTags(titleSource) ||
        firstVisibleMessage?.attachments[0]?.fileName ||
        input.message.attachments[0]?.fileName ||
        'SideChat');
}
//# sourceMappingURL=sidechat-application.js.map