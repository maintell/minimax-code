import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { getRuntimePresetKey, resolveModelAvailability } from '@mavis/config';
import { LocalModelProviderError, resolveRequestedSessionModel, } from '../../../model-system/index.js';
import { MINIAPP_AGENT_NAME, MINIAPP_AGENT_PURPOSE_PREFIX, MiniAppAgentError, } from '../contracts.js';
import { modelSelectionFromRecord, sessionModelFields } from '../model-selection.js';
import { ABORT_SETTLE_TIMEOUT_MS, ABORTED, beforeDispatch, confirmCancelled, deliverChecked, errorFields, finish, followOwnedTurn, nextTurnFrame, outcomeUnknown, pendingQuestionOf, preDeliveryCheck, prepend, readNumber, readString, rejectedTurn, settleAbortedTurn, TIMED_OUT, timeoutPromise, withTurnStream, } from './turn-follow.js';
import { runWhenBusy } from './when-busy.js';
import { findObservableSession, lastAssistantText, listObservableSessions, observeAllSessions, observeOneSession, } from './session-observe.js';
/** Upper bound on delegated-session hops walked to find a Mini App root. */
const MAX_MINIAPP_ROOT_HOPS = 16;
/** Binds the Mini App Agent gateway to SessionSystem records/stream and TurnSystem steering. */
export function createMiniAppAgentSessionPorts(options) {
    return {
        async createSession({ pluginId, agentName, workspaceDir, createDir, hostSessionId, model, contextWindow, }) {
            if (createDir)
                await mkdir(workspaceDir, { recursive: true });
            const session = await options.records.createInternalSession({
                agentName,
                sessionType: 'branch',
                sessionKind: 'conversation',
                visibility: 'hidden',
                purpose: `${MINIAPP_AGENT_PURPOSE_PREFIX}${pluginId}`,
                workspaceDir,
                isDefaultWorkspace: false,
                miniAppOrigin: {
                    pluginId,
                    createdAtMs: options.nowMs(),
                    ...(hostSessionId ? { hostSessionId } : {}),
                },
                // Shown as the side-panel tab label; the gateway has no plugin display name.
                title: pluginId,
                ...sessionModelFields(model),
                ...(contextWindow === undefined ? {} : { effectiveModelContextWindow: contextWindow }),
            });
            return { sessionId: session.sessionId };
        },
        listModels: () => listModelOptions(options),
        listAgents: () => listAgentOptions(options),
        defaultSessionModel: () => resolveDefaultSessionModel(options),
        resolveModel: async (requested) => requested
            ? resolveRequestedModel(options, requested)
            : (await resolveDefaultSessionModel(options)).selection,
        readSessionModel: (sessionId) => readSessionModel(options, sessionId),
        setSessionModel: (sessionId, model) => beforeDispatch(options, { stage: 'set-session-model', sessionId }, async () => {
            await options.lifecycle.mutateSession(sessionId, {
                ...sessionModelFields(model),
                effectiveModelContextWindow: null,
                effectiveModelMaxOutputTokens: null,
            });
        }),
        async getOwner(sessionId) {
            return (await options.repository.get(sessionId))?.miniAppOrigin?.pluginId;
        },
        resolveMiniAppRoot: (sessionId) => resolveMiniAppRoot(options, sessionId),
        resolveHostSession: (sessionId) => beforeDispatch(options, { stage: 'resolve-host-session', sessionId }, async () => {
            const session = await options.repository.get(sessionId);
            if (!session)
                return undefined;
            const { agentName, workspaceDir, isDefaultWorkspace } = session;
            // Same reading as the session wire projection: only an explicit `true` is the default.
            const model = modelSelectionFromRecord(session);
            return {
                agentName,
                workspaceDir,
                isDefaultWorkspace: isDefaultWorkspace === true,
                model,
            };
        }),
        runTurn: (input) => runMiniAppAgentTurn(options, input),
        answerQuestion: (input) => answerMiniAppAgentQuestion(options, input),
        replyPermission: (input) => replyMiniAppAgentPermission(options, input),
        subscribePermissionAsks: (listener) => options.eventBus.subscribe({
            next(event) {
                if (event.type === 'permission.ask')
                    listener(projectPermissionAsk(event.payload));
            },
        }),
        listSessions: () => listObservableSessions(options),
        findSession: (sessionId) => findObservableSession(options, sessionId),
        lastAssistantText: (sessionId) => lastAssistantText(options, sessionId),
        observeSession: (input) => observeOneSession(options, input),
        observeSessions: (input) => observeAllSessions(options, input),
    };
}
async function listModelOptions(options) {
    return (await options.models.list())
        .filter((entry) => entry.enabled)
        .map((entry) => ({
        providerId: entry.providerId,
        modelId: entry.modelId,
        displayName: entry.displayName,
        ...(entry.supportedVariants?.length ? { variants: [...entry.supportedVariants] } : {}),
        ...(entry.effortOptions?.length
            ? {
                thinking: {
                    efforts: [...entry.effortOptions],
                    ...(entry.defaultEffort ? { default: entry.defaultEffort } : {}),
                },
            }
            : {}),
    }));
}
async function listAgentOptions(options) {
    const byName = new Map();
    for (const agent of await options.agents.list({ includeAliases: false })) {
        const name = agent.canonicalViewName;
        if (byName.has(name))
            continue;
        byName.set(name, {
            name,
            displayName: agent.displayName || name,
            primary: name === MINIAPP_AGENT_NAME,
        });
    }
    return [...byName.values()];
}
/** Same validation as the composer. */
async function resolveRequestedModel(options, requested) {
    return (await resolveSelection(options, requested)).selection;
}
/**
 * The runtime default as the turn system would run it with no session model: the global
 * variant, thinking and context window apply (`variant: ''` is thinking off and is kept).
 */
async function resolveDefaultSessionModel(options) {
    const config = options.modelConfig();
    return resolveSelection(options, {
        ...(config.defaultModelVariant === undefined ? {} : { variant: config.defaultModelVariant }),
        ...(config.defaultModelThinking === undefined ? {} : { thinking: config.defaultModelThinking }),
        ...(config.defaultModelContextWindow === undefined
            ? {}
            : { contextLimit: config.defaultModelContextWindow }),
    });
}
async function resolveSelection(options, requested) {
    try {
        const config = options.modelConfig();
        const resolved = resolveRequestedSessionModel(config, requested);
        if (!resolved.providerId || !resolved.modelId) {
            throw new MiniAppAgentError('INVALID_ARGUMENTS', 'Model is not available: the runtime default model is not configured');
        }
        // A retired official model was already replaced above. The Mini App API
        // still validates its arguments up front: a model no route lists is an
        // input error for the caller rather than a Turn left to fail upstream.
        const availability = resolveModelAvailability({
            config,
            providerId: resolved.providerId,
            modelId: resolved.modelId,
            preset: getRuntimePresetKey(),
            source: 'explicit_request',
        });
        if (!availability.available) {
            throw new MiniAppAgentError('INVALID_ARGUMENTS', `Model is not available: ${availability.message}`);
        }
        return {
            selection: {
                providerId: resolved.providerId,
                modelId: resolved.modelId,
                ...(typeof resolved.variant === 'string' ? { variant: resolved.variant } : {}),
                ...(resolved.thinking?.effort ? { thinking: { effort: resolved.thinking.effort } } : {}),
            },
            ...(resolved.contextLimit === undefined ? {} : { contextWindow: resolved.contextLimit }),
        };
    }
    catch (error) {
        if (error instanceof LocalModelProviderError) {
            throw new MiniAppAgentError('INVALID_ARGUMENTS', `Model is not available: ${error.message}`);
        }
        throw error;
    }
}
function readSessionModel(options, sessionId) {
    return beforeDispatch(options, { stage: 'read-session-model', sessionId }, async () => {
        const record = await options.repository.get(sessionId);
        return record ? modelSelectionFromRecord(record) : undefined;
    });
}
/**
 * The model a turn is about to be dispatched with. A record predating the model snapshot has
 * none stored, so the turn runs on the runtime default, which is what it is reported as.
 */
async function modelBeforeDispatch(options, sessionId) {
    const recorded = await readSessionModel(options, sessionId);
    return (recorded ??
        beforeDispatch(options, { stage: 'resolve-default-model', sessionId }, async () => {
            return (await resolveDefaultSessionModel(options)).selection;
        }));
}
/** Walks delegated child sessions up to the Mini App session that owns them (bounded, cycle-safe). */
async function resolveMiniAppRoot(options, sessionId) {
    const seen = new Set();
    let current = sessionId;
    while (current) {
        if (seen.has(current) || seen.size > MAX_MINIAPP_ROOT_HOPS) {
            options.logger.warn({ sessionId, hops: seen.size, cycle: seen.has(current) }, 'Mini App root lookup stopped at the hop limit or a cycle');
            return undefined;
        }
        seen.add(current);
        const record = await options.repository.get(current);
        const pluginId = record?.miniAppOrigin?.pluginId;
        if (pluginId)
            return { rootSessionId: current, pluginId };
        current = record?.parentSessionId;
    }
    return undefined;
}
/** How long an answer waits for the continuation turn it should start. */
const CONTINUATION_START_TIMEOUT_MS = 15_000;
async function runMiniAppAgentTurn(options, input) {
    const model = await modelBeforeDispatch(options, input.sessionId);
    const follow = { ...input, model };
    // Subscribe before steering; the iterator buffers frames until the turnId is known.
    return withTurnStream(options, input, async (source, aborted) => {
        const startedAtMs = options.nowMs();
        if (input.whenBusy !== undefined) {
            return runWhenBusy(options, follow, { source, aborted, startedAtMs });
        }
        const turnId = await activateTurn(options, input);
        return followOwnedTurn(options, follow, { source, turnId, aborted, startedAtMs });
    });
}
/**
 * Answers the questionnaire the session paused on and follows the continuation turn the
 * answer starts. The stream is subscribed before replying, and the continuation is the
 * first turn-scoped frame that follows. An answer the runtime saved without starting a
 * continuation settles `finished` without a turn; one whose continuation is not observed
 * within the bound has an unknown outcome (the turn may still start later).
 */
async function answerMiniAppAgentQuestion(options, input) {
    const { sessionId, requestId } = input;
    const { agentName, pending } = await beforeDispatch(options, { stage: 'answer-lookup', sessionId, requestId }, async () => {
        const name = (await options.repository.get(sessionId))?.agentName;
        return {
            agentName: name,
            pending: name ? await pendingQuestionOf(options, name, sessionId) : undefined,
        };
    });
    // A request id of another session (even of the same agent) is never settled from here.
    if (!agentName || pending?.requestId !== requestId) {
        throw new MiniAppAgentError('REQUEST_NOT_FOUND', 'Mini App Agent question is not pending');
    }
    const model = await modelBeforeDispatch(options, sessionId);
    const follow = { ...input, model };
    return withTurnStream(options, input, async (source, aborted) => {
        const startedAtMs = options.nowMs();
        input.beforeDelivery?.();
        const reply = await replyQuestion(options, agentName, input);
        if (reply.injected === false)
            return { status: 'finished' };
        const first = await awaitContinuation(source, aborted);
        if (first === TIMED_OUT) {
            options.logger.warn({
                stage: 'answer-continuation',
                sessionId,
                requestId,
                timeoutMs: CONTINUATION_START_TIMEOUT_MS,
            }, 'Mini App Agent answer continuation turn was not observed');
            throw outcomeUnknown('Mini App Agent answer was recorded but the follow-up turn was not observed');
        }
        if (first === ABORTED) {
            return finish(follow, await abortUnidentifiedTurn(options, sessionId, source));
        }
        source.current = prepend(first, source.current);
        return followOwnedTurn(options, follow, {
            source,
            turnId: first.turnId,
            aborted,
            startedAtMs,
        });
    });
}
async function awaitContinuation(source, aborted) {
    const deadline = timeoutPromise(CONTINUATION_START_TIMEOUT_MS);
    try {
        return await nextTurnFrame(source, Promise.race([aborted, deadline.promise]));
    }
    finally {
        deadline.dispose();
    }
}
async function replyQuestion(options, agentName, input) {
    try {
        return await options.questionnaires.reply({
            agentName,
            requestId: input.requestId,
            answers: [...input.answers],
            submittedAt: options.nowMs(),
        });
    }
    catch (error) {
        // These statuses are raised before the answer is saved, so nothing was dispatched. Any
        // other failure (e.g. 503 QUESTIONNAIRE_CONTINUATION_NOT_STARTED, raised after the answer
        // was persisted) propagates and is reported as an unknown outcome.
        const status = readNumber(error, 'status');
        if (status === 400) {
            throw new MiniAppAgentError('INVALID_ARGUMENTS', 'Mini App Agent answers were rejected');
        }
        if (status === 404 || status === 409 || status === 410) {
            throw new MiniAppAgentError('REQUEST_NOT_FOUND', 'Mini App Agent question is not pending');
        }
        throw error;
    }
}
async function replyMiniAppAgentPermission(options, input) {
    // Nothing is decided until `permissions.reply`; a failed lookup before it may be retried.
    const decidable = await beforeDispatch(options, { stage: 'reply-lookup', sessionId: input.sessionId, requestId: input.requestId }, () => isRaisedUnderSameRoot(options, input));
    if (!decidable)
        return 'skipped';
    const result = await options.permissions.reply({
        requestIds: [input.requestId],
        decision: input.decision,
    });
    return result.processed.includes(input.requestId) ? 'processed' : 'skipped';
}
/** Approval request ids are global; only a request raised under the same root may be decided. */
async function isRaisedUnderSameRoot(options, input) {
    const root = await resolveMiniAppRoot(options, input.sessionId);
    if (!root)
        return false;
    const pending = await options.permissions.listPending();
    const request = pending.find((entry) => entry.requestId === input.requestId);
    if (!request)
        return false;
    // Raised by the named session or the root itself: its root is already known.
    if (request.sessionId === input.sessionId || request.sessionId === root.rootSessionId) {
        return true;
    }
    const owner = await resolveMiniAppRoot(options, request.sessionId);
    return owner?.rootSessionId === root.rootSessionId;
}
function projectPermissionAsk(payload) {
    return {
        sessionId: payload.sessionId,
        requestId: payload.requestId,
        toolName: payload.toolName,
        reason: payload.reason,
        ...(payload.turnId ? { turnId: payload.turnId } : {}),
        ...(payload.toolInput === undefined ? {} : { toolInput: payload.toolInput }),
    };
}
async function activateTurn(options, input) {
    const { sessionId, beforeDelivery } = input;
    const requestId = randomUUID();
    const steered = await deliverChecked(() => options.turns.steer({
        sessionId,
        input: { text: input.text },
        producerId: `miniapp:${sessionId}`,
        idempotencyKey: requestId,
        provenance: {
            source: 'miniapp',
            routingFingerprint: `miniapp:${sessionId}:${requestId}`,
        },
        // Checked at the delivery itself: the steer awaits before it delivers.
        ...preDeliveryCheck(beforeDelivery),
    }));
    if (!steered.delivered)
        throw rejectedTurn();
    // A steered delivery merged the text into a turn this run does not own.
    if (steered.mode !== 'activated') {
        throw new MiniAppAgentError('BUSY', 'Mini App Agent session is busy', true, 'session_busy');
    }
    return steered.turnId;
}
/**
 * Cancelled before the continuation turn was seen: wait (bounded) for it to appear, abort it
 * and wait for its terminal, so the session is idle for the next call. Not seeing the turn
 * at all leaves the outcome unknown: it may still start after this call returns.
 */
async function abortUnidentifiedTurn(options, sessionId, source) {
    const deadline = timeoutPromise(ABORT_SETTLE_TIMEOUT_MS);
    let first;
    try {
        first = await nextTurnFrame(source, deadline.promise);
    }
    catch (error) {
        options.logger.warn({ stage: 'cancel-continuation-watch', sessionId, ...errorFields(error) }, 'Mini App Agent lost the stream while waiting for the cancelled continuation turn');
        first = TIMED_OUT;
    }
    finally {
        deadline.dispose();
    }
    if (first === TIMED_OUT) {
        options.logger.warn({ stage: 'cancel-continuation', sessionId, timeoutMs: ABORT_SETTLE_TIMEOUT_MS }, 'Mini App Agent cancelled answer: continuation turn was not observed');
        throw outcomeUnknown('Mini App Agent answer was cancelled but the follow-up turn was not observed');
    }
    const turnId = first.turnId;
    if (first.kind === 'turn-terminal') {
        const terminal = { status: readString(first.data, 'status') };
        return confirmCancelled(options, { sessionId, turnId, terminal });
    }
    const abort = await options.turns.abort({ sessionId, turnId, reason: 'miniapp-cancelled' });
    const terminal = await settleAbortedTurn(options, sessionId, source, turnId);
    return confirmCancelled(options, { sessionId, turnId, abort, terminal });
}
//# sourceMappingURL=session-ports.js.map