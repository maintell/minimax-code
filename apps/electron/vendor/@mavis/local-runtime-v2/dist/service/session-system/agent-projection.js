import { CONTEXT_USAGE_COMPONENT_KINDS, RuntimeEventStatus, RuntimeStopReasonType, RuntimeEventType, } from '@mavis/agent-core/protocol';
import { RespDataType, Role } from '@mavis/agent-core/protocol/agent-message';
export function createSessionSystemAgentProjection(options) {
    const compactionLane = createCompactionProjectionLane();
    const startedCompactions = new Map();
    return {
        preparation: {
            projectStarted: async (input) => {
                // Preparation owns an accepted Turn but has no AgentHost runtime sequence yet.
                // Use the same fenced Session state writer without inventing a Runtime event.
                const result = await options.state.markStarted(input);
                assertStateWrite(result.status);
            },
        },
        session: {
            projectRuntimeEvent: (input) => projectSessionRuntime(options, input),
        },
        messages: {
            projectRuntimeEvent: async (input) => {
                const message = displayMessage(input.event);
                if (message && !isTerminalAssistantDisplayError(message)) {
                    const queryKey = await queryKeyForTurn(options, input.context);
                    await options.messages.upsert({
                        sessionId: input.context.sessionId,
                        turnId: input.context.turnId,
                        message: {
                            ...message,
                            turn_id: input.context.turnId,
                            ...(queryKey ? { query_key: queryKey } : {}),
                        },
                        source: input.context.provenance?.source ?? 'agent',
                        ...(input.context.provenance?.sourceContext
                            ? { sourceContext: input.context.provenance.sourceContext }
                            : {}),
                    }, 
                    // Complete tool messages describe work already executed, including
                    // abort cleanup. Persist these facts within the write-lock budget
                    // even when the lease is cancelled; text-only waits may stop early.
                    message.tool_calls?.length ? undefined : { signal: input.signal });
                }
                await projectQueryCollapse(() => options.queryCollapse?.projectRuntimeEvent(input));
            },
            projectHistoryCommitted: async (input) => {
                await projectCanonicalAssistantBoundaries(options, input);
                await projectCommittedConversation(options, input);
                await projectQueryCollapse(() => options.queryCollapse?.projectHistoryCommitted({
                    context: input.context,
                    change: input.change,
                }));
            },
        },
        attemptRecall: {
            recallAssistantAttempt: (input) => recallAssistantAttempt(options, input),
        },
        stream: {
            projectRuntimeEvent: async (input) => {
                const terminal = terminalOutcome(input.event);
                const streamData = terminal
                    ? undefined
                    : streamProjectionData(options, input, await queryKeyForTurn(options, input.context));
                const messageActionDeltas = terminal
                    ? await terminalConversationActions(options, input.context)
                    : [];
                options.stream.write({
                    identity: `runtime:${input.event.event_id}`,
                    sessionId: input.context.sessionId,
                    turnId: input.context.turnId,
                    kind: terminal ? 'turn-terminal' : 'runtime-event',
                    data: terminal ? terminalFrameData(input.event, terminal) : (streamData ?? input.event),
                    ...(messageActionDeltas.length > 0 ? { messageActionDeltas } : {}),
                });
            },
        },
        historyFailures: {
            projectHistoryFailure: async (input) => {
                const updated = await options.sessions.update(input.sessionId, {
                    status: 'error',
                    errorMessage: `Canonical history commit failed for ${input.turnId}`,
                    errorSource: 'canonical-history',
                    ...(input.metadata === undefined ? {} : { errorDetail: safeJson(input.metadata) }),
                });
                if (!updated)
                    throw new Error(`Session not found: ${input.sessionId}`);
            },
        },
        failures: {
            project: async (input) => {
                const status = input.status ?? 'failed';
                const publicFailure = readPublicPreparationFailure(input.error);
                const errorMessage = describePublicError(input.error, publicFailure);
                if (status === 'failed' && publicFailure)
                    await persistPreparationFailure(options, input, publicFailure);
                const result = await options.state.markTerminal({
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    turnSequence: input.turnSequence,
                    eventId: input.eventId,
                    outcome: status,
                    ...(status === 'failed'
                        ? { errorMessage, errorSource: publicFailure?.code ?? 'turn-system' }
                        : {}),
                });
                assertStateWrite(result.status);
                await projectQueryCollapse(() => options.queryCollapse?.projectFailure(input));
                const messageActionDeltas = await terminalConversationActions(options, {
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                });
                options.stream.write({
                    identity: `turn-${status === 'aborted' ? 'abort' : 'failure'}:${input.eventId}`,
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    kind: 'turn-terminal',
                    data: {
                        status,
                        ...(status === 'failed' ? { error: errorMessage } : {}),
                        ...(publicFailure ? { errorSource: publicFailure.code } : {}),
                    },
                    ...(messageActionDeltas.length > 0 ? { messageActionDeltas } : {}),
                });
            },
        },
        compactionLifecycle: {
            completeCommittedHistory: (input) => compactionLane.run(input.attemptId, async () => {
                await writeCompactionFact(options, input, 'compaction');
                recordCompletedCompactionMetrics(options, input, startedCompactions.get(input.attemptId));
            }),
            failCommittedHistory: (input) => compactionLane.run(input.attemptId, () => writeCompactionFact(options, input, 'compaction_failed')),
        },
        compactionObserver: {
            observe: (input) => compactionLane.run(input.attemptId, async () => {
                await projectCompactionObservation(options, startedCompactions, input);
            }),
        },
    };
}
async function terminalConversationActions(options, context) {
    try {
        return ((await options.conversationActions?.projectTerminalTurn({
            sessionId: context.sessionId,
            turnId: context.turnId,
        })) ?? []);
    }
    catch {
        // Transient action projection must never suppress the durable terminal boundary.
        return [];
    }
}
async function projectCanonicalAssistantBoundaries(options, input) {
    const canonicalMessageIds = canonicalAssistantMessageIds(input.change);
    if (canonicalMessageIds.length === 0)
        return;
    try {
        const displayMessages = await options.messages.listTurn(input.context.sessionId, input.context.turnId);
        const assistants = displayMessages.filter(isCanonicalAssistantDisplayMessage);
        if (assistants.length < canonicalMessageIds.length)
            return;
        const targets = assistants.slice(-canonicalMessageIds.length);
        await Promise.all(targets.flatMap((message, index) => {
            const canonicalMessageId = canonicalMessageIds[index];
            return canonicalMessageId
                ? [
                    options.messages.upsert({
                        sessionId: input.context.sessionId,
                        turnId: input.context.turnId,
                        message: {
                            ...message,
                            canonical_message_id: canonicalMessageId,
                        },
                    }),
                ]
                : [];
        }));
    }
    catch {
        // The canonical commit is authoritative. This Display-side Fork anchor is
        // best-effort and old rows retain the next-User compatibility boundary.
    }
}
function canonicalAssistantMessageIds(change) {
    const messages = change.messages;
    const identities = change.committedIdentityVector;
    if (change.reason !== 'messageDelta' ||
        !messages ||
        !identities ||
        identities.length < messages.length) {
        return [];
    }
    const offset = identities.length - messages.length;
    return messages.flatMap((message, index) => {
        const identity = identities[offset + index];
        return message.role === Role.Assistant && typeof identity === 'string' && identity.length > 0
            ? [identity]
            : [];
    });
}
function isCanonicalAssistantDisplayMessage(message) {
    return (message.role === Role.Assistant &&
        !(typeof message.kind === 'string' && message.kind.length > 0) &&
        !(typeof message.displayKind === 'string' && message.displayKind.length > 0));
}
async function recallAssistantAttempt(options, input) {
    const displayMessages = await options.messages.listTurn(input.sessionId, input.turnId);
    const userMessageIds = new Set(displayMessages.flatMap((message) => message.role === Role.User && typeof message.msg_id === 'string' && message.msg_id.length > 0
        ? [message.msg_id]
        : []));
    const durableAssistantIds = displayMessages.flatMap((message) => message.role === Role.Assistant &&
        typeof message.msg_id === 'string' &&
        message.msg_id.length > 0
        ? [message.msg_id]
        : []);
    const messageIds = [
        ...new Set([
            ...durableAssistantIds,
            ...input.messageIds.filter((messageId) => !userMessageIds.has(messageId)),
        ]),
    ];
    if (messageIds.length > 0) {
        await options.messages.rewind({ sessionId: input.sessionId, messageIds });
    }
    options.stream.write({
        identity: `messages-rewound:${input.turnId}:attempt:${String(input.attempt)}`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        kind: 'messages-rewound',
        data: { messageIds },
    });
    await options.conversationFacts.handle({
        kind: 'attempt-recalled',
        sessionId: input.sessionId,
        turnId: input.turnId,
        attempt: input.attempt,
    });
}
async function projectCommittedConversation(options, input) {
    if (input.change.operation.kind === 'network-reconcile') {
        await options.conversationFacts.handle({
            kind: 'network-stopped',
            sessionId: input.context.sessionId,
            turnId: input.context.turnId,
        });
        return;
    }
    if (input.change.operation.kind !== 'output-recall')
        return;
    const displayMessages = await options.messages.listTurn(input.context.sessionId, input.context.turnId);
    const messageIds = displayMessages.flatMap((message) => typeof message.msg_id === 'string' && message.msg_id.length > 0 ? [message.msg_id] : []);
    const lastUserMsgId = displayMessages.reduce((latest, message) => message.role === Role.User && typeof message.msg_id === 'string' && message.msg_id.length > 0
        ? message.msg_id
        : latest, undefined);
    await options.messages.rewind({
        sessionId: input.context.sessionId,
        messageIds,
    });
    options.stream.write({
        identity: `messages-rewound:${input.context.turnId}`,
        sessionId: input.context.sessionId,
        turnId: input.context.turnId,
        kind: 'messages-rewound',
        data: { messageIds },
    });
    await options.conversationFacts.handle({
        kind: 'turn-retracted',
        sessionId: input.context.sessionId,
        turnId: input.context.turnId,
        variant: input.change.operation.variant ?? 'content',
        ...(lastUserMsgId ? { lastUserMsgId } : {}),
    });
}
async function projectCompactionObservation(options, startedCompactions, input) {
    const nowMs = options.nowMs ?? Date.now;
    if (input.status === 'started') {
        if (startedCompactions.has(input.attemptId))
            return;
        startedCompactions.set(input.attemptId, {
            startedAtMs: nowMs(),
            trigger: input.reason === 'automatic' ? 'auto' : 'manual',
        });
        await writeCompactionFact(options, input, 'compaction_start');
        await options.compactionFacts?.handle({
            kind: 'started',
            sessionId: input.context.sessionId,
            attemptId: input.attemptId,
        });
        return;
    }
    if (input.status === 'completed') {
        startedCompactions.delete(input.attemptId);
        await options.compactionFacts?.handle({
            kind: 'completed',
            sessionId: input.context.sessionId,
            attemptId: input.attemptId,
            snapshotId: input.compactionId,
            messagesBefore: input.messagesBefore,
            messagesAfter: input.messagesAfter,
            tokensBefore: input.tokensBefore,
            tokensAfter: input.tokensAfter,
            ...(input.contextUsage === undefined ? {} : { contextUsage: input.contextUsage }),
            ...compactionTokenUsageMetadata(input.tokenUsage),
        });
        return;
    }
    const started = startedCompactions.get(input.attemptId);
    startedCompactions.delete(input.attemptId);
    recordTerminalCompactionMetrics(options, input, started, nowMs());
    if (input.status === 'unchanged') {
        if (!started)
            return;
        await writeCompactionFact(options, {
            context: input.context,
            attemptId: input.attemptId,
            error: input.reason ?? 'nothing-to-compact',
        }, 'compaction_failed');
    }
    await options.compactionFacts?.handle({
        kind: 'failed',
        sessionId: input.context.sessionId,
        attemptId: input.attemptId,
        ...terminalCompactionTokenUsageMetadata(input),
    });
}
function recordCompletedCompactionMetrics(options, input, started) {
    const metrics = options.compactionMetrics;
    const metadata = readCompactionMetricMetadata(input.metadata);
    if (!metrics || !metadata)
        return;
    const { phase, method, tokensBefore, tokensAfter, bytesBefore, bytesAfter, hmidOverflowRecovered, tokenUsage, } = metadata;
    const trigger = phase === 'manual' ? 'manual' : 'auto';
    try {
        metrics.counter('compact_outcome_total', 1, { trigger, outcome: 'completed', method });
        if (hmidOverflowRecovered) {
            metrics.counter('compact_hmid_overflow_recovery_total', 1, { trigger });
        }
        if (started) {
            metrics.histogram('compact_duration_ms', (options.nowMs ?? Date.now)() - started.startedAtMs, {
                trigger,
            });
        }
        const ratioLabels = { trigger, method };
        if (tokensBefore > 0) {
            metrics.histogram('compact_saved_ratio', 1 - tokensAfter / tokensBefore, {
                ...ratioLabels,
                dimension: 'tokens',
            });
        }
        if (bytesBefore > 0) {
            metrics.histogram('compact_saved_ratio', 1 - bytesAfter / bytesBefore, {
                ...ratioLabels,
                dimension: 'serialized_bytes',
            });
        }
        recordCompactionTokenUsage(metrics, tokenUsage, { trigger, outcome: 'completed' });
    }
    catch {
        // Metrics must never change projection or Host outcomes.
    }
}
function recordTerminalCompactionMetrics(options, input, started, terminalAtMs) {
    const metrics = options.compactionMetrics;
    if (!metrics)
        return;
    const trigger = started?.trigger ?? fallbackCompactionTrigger(input);
    const outcome = terminalCompactionOutcome(input);
    try {
        metrics.counter('compact_outcome_total', 1, { trigger, outcome, method: 'none' });
        if (started) {
            metrics.histogram('compact_duration_ms', terminalAtMs - started.startedAtMs, { trigger });
        }
        recordCompactionTokenUsage(metrics, terminalCompactionTokenUsage(input), { trigger, outcome });
    }
    catch {
        // Metrics must never change projection or Host outcomes.
    }
}
function fallbackCompactionTrigger(input) {
    return input.status === 'unchanged' ? 'auto' : 'unknown';
}
function terminalCompactionOutcome(input) {
    if (input.status !== 'unchanged')
        return input.status;
    return input.reason === 'internal-context-filter' ? 'filter_only' : 'below_trigger';
}
function readCompactionMetricMetadata(value) {
    if (!isRecord(value))
        return undefined;
    const phase = value.phase;
    if (phase !== 'initial' && phase !== 'iteration' && phase !== 'manual')
        return undefined;
    const method = value.method;
    if (method !== 'tool_archive' && method !== 'tool_trim' && method !== 'llm_checkpoint') {
        return undefined;
    }
    const counts = readCompactionMetricCounts(value);
    const tokenUsage = readCompactionTokenUsage(value.tokenUsage);
    return counts
        ? {
            phase,
            method,
            ...counts,
            ...compactionTokenUsageMetadata(tokenUsage),
            hmidOverflowRecovered: method === 'llm_checkpoint' && Reflect.get(value, 'hmidOverflowRecovered') === true,
        }
        : undefined;
}
function compactionTokenUsageMetadata(tokenUsage) {
    if (tokenUsage === undefined)
        return {};
    return { tokenUsage };
}
function terminalCompactionTokenUsage(input) {
    if (input.status === 'unchanged')
        return undefined;
    return input.tokenUsage;
}
function terminalCompactionTokenUsageMetadata(input) {
    return compactionTokenUsageMetadata(terminalCompactionTokenUsage(input));
}
function recordCompactionTokenUsage(metrics, tokenUsage, labels) {
    if (!metrics || !tokenUsage)
        return;
    for (const [kind, value] of [
        ['input', tokenUsage.inputTokens],
        ['output', tokenUsage.outputTokens],
        ['cache_read', tokenUsage.cacheReadTokens],
        ['cache_write', tokenUsage.cacheWriteTokens],
    ]) {
        try {
            metrics.counter('compact_provider_tokens_total', value, { ...labels, kind });
        }
        catch {
            // Metrics must never change projection or Host outcomes.
        }
    }
    if (tokenUsage.incomplete) {
        try {
            metrics.counter('compact_provider_token_usage_incomplete_total', 1, labels);
        }
        catch {
            // Metrics must never change projection or Host outcomes.
        }
    }
}
function readCompactionTokenUsage(value) {
    if (!isRecord(value))
        return undefined;
    const inputTokens = readNonNegativeNumber(value.inputTokens);
    const outputTokens = readNonNegativeNumber(value.outputTokens);
    const cacheReadTokens = readNonNegativeNumber(value.cacheReadTokens);
    const cacheWriteTokens = readNonNegativeNumber(value.cacheWriteTokens);
    const totalTokens = readNonNegativeNumber(value.totalTokens);
    if (inputTokens === undefined ||
        outputTokens === undefined ||
        cacheReadTokens === undefined ||
        cacheWriteTokens === undefined ||
        totalTokens === undefined ||
        typeof value.incomplete !== 'boolean' ||
        totalTokens !== inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens) {
        return undefined;
    }
    return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
        incomplete: value.incomplete,
    };
}
function readCompactionMetricCounts(value) {
    const tokensBefore = readNonNegativeNumber(value.tokensBefore);
    const tokensAfter = readNonNegativeNumber(value.tokensAfter);
    const bytesBefore = readNonNegativeNumber(value.serializedBytesBefore);
    const bytesAfter = readNonNegativeNumber(value.serializedBytesAfter);
    if (tokensBefore === undefined)
        return undefined;
    if (tokensAfter === undefined)
        return undefined;
    if (bytesBefore === undefined)
        return undefined;
    if (bytesAfter === undefined)
        return undefined;
    return { tokensBefore, tokensAfter, bytesBefore, bytesAfter };
}
async function projectSessionRuntime(options, input) {
    const identity = eventIdentity(input);
    const terminal = terminalOutcome(input.event);
    if (terminal) {
        const error = terminalError(input.event);
        const result = await options.state.markTerminal({
            ...identity,
            outcome: terminal,
            ...(error?.message ? { errorMessage: error.message } : {}),
            ...(error?.code !== undefined ? { errorCode: error.code } : {}),
            ...(error?.errorSource ? { errorSource: error.errorSource } : {}),
            ...(error?.details ? { errorDetail: error.details } : {}),
        });
        assertStateWrite(result.status);
        return { terminal: true, outcome: terminal };
    }
    if (isSessionStatus(input.event, RuntimeEventStatus.RUNNING)) {
        const result = await options.state.markStarted(identity);
        assertStateWrite(result.status);
    }
    else if (isSessionStatus(input.event, RuntimeEventStatus.IDLE)) {
        const result = await options.state.markIdle(identity);
        assertStateWrite(result.status);
    }
    return { terminal: false };
}
function eventIdentity(input) {
    return {
        sessionId: input.context.sessionId,
        turnId: input.context.turnId,
        turnSequence: input.context.turnSequence,
        eventId: input.event.event_id,
        ...(typeof input.event.runtime_seq === 'number' ? { runtimeSeq: input.event.runtime_seq } : {}),
    };
}
function terminalOutcome(event) {
    if (event.type !== RuntimeEventType.SESSION_STATUS &&
        event.type !== RuntimeEventType.TURN_TERMINAL) {
        return undefined;
    }
    if (event.payload.status === RuntimeEventStatus.COMPLETED)
        return 'completed';
    if (event.payload.status === RuntimeEventStatus.FAILED)
        return 'failed';
    return event.payload.status === RuntimeEventStatus.ABORTED ? 'aborted' : undefined;
}
function terminalFrameData(event, status) {
    const error = terminalError(event);
    return {
        status,
        ...(error?.message ? { error: error.message } : {}),
        ...(error?.code !== undefined ? { errorCode: error.code } : {}),
        ...(error?.details ? { detail: error.details } : {}),
    };
}
function terminalError(event) {
    const protocolError = event.payload.error;
    const stopReasonMessage = event.payload.status === RuntimeEventStatus.FAILED &&
        event.payload.stop_reason?.type === RuntimeStopReasonType.ERROR
        ? event.payload.stop_reason.message
        : undefined;
    const message = protocolError?.message || stopReasonMessage;
    if (!protocolError && !message)
        return undefined;
    return {
        ...(message ? { message } : {}),
        ...(protocolError?.code !== undefined ? { code: protocolError.code } : {}),
        ...(protocolError?.details !== undefined ? { details: protocolError.details } : {}),
        ...(protocolError ? { errorSource: 'agent-runtime' } : {}),
    };
}
function isSessionStatus(event, status) {
    return ((event.type === RuntimeEventType.SESSION_STATUS ||
        event.type === RuntimeEventType.TURN_TERMINAL) &&
        event.payload.status === status);
}
function assertStateWrite(status) {
    if (status !== 'applied' && status !== 'duplicate') {
        throw new Error(`Session Agent state projection rejected: ${status}`);
    }
}
function streamResponseData(event) {
    if (event.type !== RuntimeEventType.STREAM_RESP)
        return undefined;
    const raw = event.payload.stream_resp;
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
function streamProjectionData(options, input, queryKey) {
    const raw = streamResponseData(input.event);
    if (!raw)
        return undefined;
    let response;
    try {
        response = JSON.parse(raw);
    }
    catch {
        return raw;
    }
    if (!isRecord(response))
        return raw;
    const messageField = streamMessageField(response);
    if (!messageField || !isRecord(response[messageField]))
        return raw;
    return JSON.stringify({
        ...response,
        [messageField]: {
            ...response[messageField],
            turn_id: input.context.turnId,
            ...(queryKey ? { query_key: queryKey } : {}),
            ...(queryKey ? (options.steeringProjection?.(queryKey) ?? {}) : {}),
        },
    });
}
async function queryKeyForTurn(options, context) {
    try {
        return await options.queryKeyForTurn?.(context.sessionId, context.turnId);
    }
    catch {
        return undefined;
    }
}
async function projectQueryCollapse(project) {
    try {
        await project();
    }
    catch {
        // The sidecar is a display projection and must not change Session/Turn durability.
    }
}
function streamMessageField(response) {
    if (response.type === RespDataType.AgentMessage)
        return 'agent_message';
    if (response.type === RespDataType.AgentMessageChunk)
        return 'agent_message_chunk';
    return undefined;
}
function displayMessage(event) {
    const raw = streamResponseData(event);
    if (!raw)
        return undefined;
    try {
        const response = JSON.parse(raw);
        if (!isRecord(response) || response.type !== RespDataType.AgentMessage)
            return undefined;
        const message = response.agent_message;
        return isAgentMessage(message) ? message : undefined;
    }
    catch {
        return undefined;
    }
}
function isAgentMessage(value) {
    return isRecord(value) && typeof value.msg_id === 'string' && value.msg_id.length > 0;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isTerminalAssistantDisplayError(message) {
    return message.role === Role.Assistant && finishReason(message) === 'error';
}
function finishReason(message) {
    if (message.finish_reason)
        return message.finish_reason;
    const value = Reflect.get(message, 'finishReason');
    return typeof value === 'string' ? value : undefined;
}
async function writeCompactionFact(options, input, kind) {
    const contextUsage = readCommittedContextUsage(input, kind);
    const message = {
        msg_id: `compaction-${input.attemptId}`,
        role: 'assistant',
        kind,
        timestamp: (options.nowMs ?? Date.now)(),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(contextUsage ? { context_usage: contextUsage } : {}),
        ...(kind === 'compaction_failed' && input.error !== undefined
            ? { error: describeError(input.error) }
            : {}),
        ...(input.committedRevision !== undefined && input.operationId !== undefined
            ? {
                operationId: input.operationId,
                committedRevision: input.committedRevision,
            }
            : {}),
    };
    await options.messages.upsert({
        sessionId: input.context.sessionId,
        turnId: input.context.turnId,
        message,
        source: input.context.provenance?.source ?? 'agent',
    });
    options.stream.write({
        identity: `compaction:${input.attemptId}:${kind}`,
        sessionId: input.context.sessionId,
        turnId: input.context.turnId,
        kind: 'message-committed',
        data: { messages: [message] },
    });
}
function readCommittedContextUsage(input, kind) {
    return kind === 'compaction' && isRecord(input.metadata)
        ? readContextUsage(input.metadata.contextUsage)
        : undefined;
}
function readContextUsage(value) {
    if (!isRecord(value))
        return undefined;
    const contextWindowTokens = readNonNegativeNumber(value.contextWindowTokens);
    const usedTokens = readNonNegativeNumber(value.usedTokens);
    if (contextWindowTokens === undefined ||
        usedTokens === undefined ||
        value.totalCountSource !== 'LOCAL_ESTIMATE') {
        return undefined;
    }
    const components = readContextUsageComponents(value.components);
    if (!components)
        return undefined;
    return {
        contextWindowTokens,
        usedTokens,
        totalCountSource: 'LOCAL_ESTIMATE',
        components,
    };
}
function readContextUsageComponents(value) {
    if (!Array.isArray(value) || value.length !== CONTEXT_USAGE_COMPONENT_KINDS.length) {
        return undefined;
    }
    const components = value.flatMap((component) => {
        if (!isRecord(component) || !isContextUsageComponentKind(component.kind))
            return [];
        const tokens = readNonNegativeNumber(component.tokens);
        return tokens === undefined ? [] : [{ kind: component.kind, tokens }];
    });
    return components.length === CONTEXT_USAGE_COMPONENT_KINDS.length &&
        new Set(components.map((component) => component.kind)).size ===
            CONTEXT_USAGE_COMPONENT_KINDS.length
        ? components
        : undefined;
}
function readNonNegativeNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function isContextUsageComponentKind(value) {
    return CONTEXT_USAGE_COMPONENT_KINDS.some((kind) => kind === value);
}
function createCompactionProjectionLane() {
    const tails = new Map();
    return {
        async run(attemptId, operation) {
            const previous = tails.get(attemptId) ?? Promise.resolve();
            let release = () => undefined;
            const current = new Promise((resolve) => {
                release = resolve;
            });
            tails.set(attemptId, current);
            try {
                await previous;
                return await operation();
            }
            finally {
                release();
                if (tails.get(attemptId) === current)
                    tails.delete(attemptId);
            }
        },
    };
}
function safeJson(value) {
    try {
        return JSON.stringify(value) ?? 'undefined';
    }
    catch {
        return '[unserializable]';
    }
}
function readPublicPreparationFailure(error) {
    const source = error instanceof AggregateError ? error.cause : error;
    if (!isRecord(source))
        return undefined;
    const value = source.publicFailure;
    if (!isRecord(value))
        return undefined;
    return typeof value.code === 'string' && typeof value.message === 'string'
        ? { code: value.code, message: value.message }
        : undefined;
}
async function persistPreparationFailure(options, input, publicFailure) {
    const queryKey = await queryKeyForTurn(options, input);
    const previous = (await options.messages.listTurn(input.sessionId, input.turnId)).find((message) => message.msg_id === `${input.turnId}-preparation-error`);
    const message = {
        msg_id: `${input.turnId}-preparation-error`,
        role: 'assistant',
        turn_id: input.turnId,
        finish_reason: 'error',
        msg_content: '',
        timestamp: previous?.timestamp ?? (options.nowMs ?? Date.now)(),
        preparation_error: publicFailure,
        ...(queryKey ? { query_key: queryKey } : {}),
    };
    await options.messages.upsert({
        sessionId: input.sessionId,
        turnId: input.turnId,
        source: 'turn-preparation',
        message,
    });
    options.stream.write({
        identity: `preparation-error:${input.turnId}`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        kind: 'message-committed',
        data: { messages: [message] },
    });
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
function describePublicError(error, failure) {
    return failure?.message ?? describeError(error);
}
//# sourceMappingURL=agent-projection.js.map