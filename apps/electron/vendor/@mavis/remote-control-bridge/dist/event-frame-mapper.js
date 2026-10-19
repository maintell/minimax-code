/**
 * Global Event → typed evt.* frame mapper (EVENT-FRAMES.md).
 *
 * Shapes the payload of a subset of admitted Global Events (field pruning,
 * camelCase→snake_case, JSON carriers) while keeping the frame `type` a
 * verbatim `evt.<event type>` — dots preserved — so the phone receives an
 * event type that maps one-to-one onto the desktop Event接口 bus type
 * (`session.start` → `evt.session.start`; the gateway strips the `evt.` prefix
 * on the broadcast path so the phone sees the bare `session.start`).
 *
 * Events without a payload-shaping entry return null and fall back to the
 * generic evt.<domain>.<action> frame (makeBusEventFrame) in permission-
 * upstream, which does the same top-level snake_case + ts_ms.
 *
 * compaction and thread_goal are NOT collapsed — each public event maps to
 * its own verbatim type. The Electron host adapter admits events against the
 * shared Global Event catalog before they reach this mapper.
 */
/** `evt.` + verbatim Global Event type — dots preserved (gateway strips prefix). */
function evt(eventType) {
    return `evt.${eventType}`;
}
/**
 * Returns a frame with a shaped payload for a Global Event, or null when the
 * event needs no special shaping (caller falls back to makeBusEventFrame,
 * which produces the same verbatim evt.<type> with a shallow-snake_cased
 * payload).
 */
export function mapBusEventToFrame(type, payload, tsMs) {
    switch (type) {
        case 'session.created':
            return {
                type: evt('session.created'),
                payload: prune({
                    session_id: str(payload.sessionId),
                    agent_name: str(payload.agentName),
                    session_type: str(payload.sessionType),
                    title: str(payload.title),
                    parent_session_id: str(payload.parentSessionId),
                    ts_ms: tsMs,
                }),
            };
        case 'session.start':
            return {
                type: evt('session.start'),
                payload: prune({
                    session_id: str(payload.sessionId),
                    agent_name: str(payload.agentName),
                    turn_id: str(payload.turnId),
                    source: str(payload.source),
                    queue_item_ids: strArray(payload.queueItemIds),
                    ts_ms: tsMs,
                }),
            };
        case 'session.title_updated':
            return {
                type: evt('session.title_updated'),
                payload: prune({
                    session_id: str(payload.sessionId),
                    agent_name: str(payload.agentName),
                    title: str(payload.title),
                    ts_ms: tsMs,
                }),
            };
        case 'session.model_updated':
            return {
                type: evt('session.model_updated'),
                payload: prune({
                    session_id: str(payload.sessionId),
                    agent_name: str(payload.agentName),
                    provider_id: str(payload.providerId),
                    model_id: str(payload.modelId),
                    variant: str(payload.variant),
                    thinking: rec(payload.thinking),
                    context_limit: payload.contextLimit,
                    ts_ms: tsMs,
                }),
            };
        case 'session.queue.updated':
            return {
                type: evt('session.queue.updated'),
                payload: prune({
                    session_id: str(payload.sessionId),
                    item_id: str(payload.itemId),
                    status: str(payload.status),
                    failed_reason: str(payload.failedReason),
                    queued_count: num(payload.queuedCount),
                    ts_ms: tsMs,
                }),
            };
        case 'rotation.completed':
            return {
                type: evt('rotation.completed'),
                payload: prune({
                    agent_name: str(payload.agentName),
                    old_session_id: str(payload.oldSessionId),
                    new_session_id: str(payload.newSessionId),
                    reason: str(payload.reason),
                    ts_ms: tsMs,
                }),
            };
        case 'message.rewind':
            return {
                type: evt('message.rewind'),
                payload: prune({ session_id: str(payload.sessionId), ts_ms: tsMs }),
            };
        case 'session.compaction.started':
            return compactionFrame('started', payload, tsMs);
        case 'session.compaction.completed':
            return compactionFrame('completed', payload, tsMs);
        case 'session.compaction.failed':
            return compactionFrame('failed', payload, tsMs);
        case 'thread_goal.updated':
            return threadGoalUpdated(payload, tsMs);
        case 'thread_goal.cleared':
            return {
                type: evt('thread_goal.cleared'),
                payload: prune({
                    session_id: str(payload.sessionId),
                    goal_id: str(payload.goalId),
                    ts_ms: tsMs,
                }),
            };
        case 'questionnaire.ask':
            return {
                type: evt('questionnaire.ask'),
                payload: prune({
                    request_id: str(payload.requestId),
                    session_id: str(payload.sessionId),
                    turn_id: questionnaireTurnId(payload.request),
                    agent_name: str(payload.agentName),
                    // The questionnaire request record is a structured client-authored
                    // form (steps/options) the phone renders verbatim. Per the IDL
                    // convention (complex archon types → JSON carrier), it ships as a
                    // JSON string rather than a re-keyed struct.
                    request_json: jsonString(payload.request),
                    ts_ms: tsMs,
                }),
            };
        case 'questionnaire.dismiss':
            return {
                type: evt('questionnaire.dismiss'),
                payload: prune({
                    request_id: str(payload.requestId),
                    session_id: str(payload.sessionId),
                    agent_name: str(payload.agentName),
                    status: str(payload.status),
                    ts_ms: tsMs,
                }),
            };
        case 'questionnaire.superseded':
            return {
                type: evt('questionnaire.superseded'),
                payload: prune({
                    request_id: str(payload.requestId),
                    session_id: str(payload.sessionId),
                    agent_name: str(payload.agentName),
                    keep_request_id: str(payload.keepRequestId),
                    superseded_at: num(payload.supersededAt),
                    ts_ms: tsMs,
                }),
            };
        case 'agent.created':
            return {
                type: evt('agent.created'),
                payload: prune({ agent_name: str(payload.agentName), ts_ms: tsMs }),
            };
        case 'agent.updated':
            return {
                type: evt('agent.updated'),
                payload: prune({ agent_name: str(payload.agentName), ts_ms: tsMs }),
            };
        default:
            return null;
    }
}
function compactionFrame(phase, payload, tsMs) {
    return {
        type: evt(`session.compaction.${phase}`),
        payload: prune({
            session_id: str(payload.sessionId),
            compaction_id: str(payload.compactionId),
            messages_before: num(payload.messagesBefore),
            messages_after: num(payload.messagesAfter),
            tokens_before: num(payload.tokensBefore),
            tokens_after: num(payload.tokensAfter),
            token_usage: compactionTokenUsage(payload.tokenUsage),
            ts_ms: tsMs,
        }),
    };
}
function compactionTokenUsage(value) {
    const usage = rec(value);
    const inputTokens = nonNegativeNum(usage?.inputTokens);
    const outputTokens = nonNegativeNum(usage?.outputTokens);
    const cacheReadTokens = nonNegativeNum(usage?.cacheReadTokens);
    const cacheWriteTokens = nonNegativeNum(usage?.cacheWriteTokens);
    const totalTokens = nonNegativeNum(usage?.totalTokens);
    if (inputTokens === undefined ||
        outputTokens === undefined ||
        cacheReadTokens === undefined ||
        cacheWriteTokens === undefined ||
        totalTokens === undefined ||
        typeof usage?.incomplete !== 'boolean' ||
        totalTokens !== inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens) {
        return undefined;
    }
    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        total_tokens: totalTokens,
        incomplete: usage.incomplete,
    };
}
function threadGoalUpdated(payload, tsMs) {
    const goal = rec(payload.goal);
    return {
        type: evt('thread_goal.updated'),
        payload: prune({
            goal: goal
                ? prune({
                    goal_id: str(goal.goalId),
                    session_id: str(goal.sessionId),
                    objective: objectiveText(goal.objective),
                    ...(Array.isArray(goal.objectiveResources)
                        ? {
                            objective_resources: goal.objectiveResources.map((value) => {
                                const resource = rec(value) ?? {};
                                return {
                                    meta: {
                                        attachment_type: str(resource.type),
                                        file_name: str(resource.fileName),
                                        mime_type: str(resource.mimeType),
                                    },
                                    local: { asset_id: str(resource.assetId), file_path: str(resource.filePath) },
                                };
                            }),
                        }
                        : {}),
                    status: str(goal.status),
                    created_at: num(goal.createdAt),
                    updated_at: num(goal.updatedAt),
                    tokens_used: num(goal.tokensUsed),
                    time_used_seconds: num(goal.timeUsedSeconds),
                    token_budget: num(goal.tokenBudget),
                })
                : undefined,
            ts_ms: tsMs,
        }),
    };
}
function str(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/**
 * Annotation evidence a Goal objective carries for verification and
 * continuation. Remote clients render and edit the objective as plain text, so
 * the block is projected out here. The bridge stays host-neutral, so the tag
 * names are duplicated from the Composer's chat-context contract rather than
 * imported from the UI package.
 */
const GOAL_OBJECTIVE_EVIDENCE_RE = /<(user-provided-context|mavis-chat-context|html-selection-context|deployed-website-context)\b[^>]*>[\s\S]*?<\/\1>/gu;
function objectiveText(value) {
    const objective = str(value);
    return objective === undefined
        ? undefined
        : str(objective.replace(GOAL_OBJECTIVE_EVIDENCE_RE, '').trim());
}
function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function nonNegativeNum(value) {
    const number = num(value);
    return number !== undefined && number >= 0 ? number : undefined;
}
function strArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const out = value.filter((entry) => typeof entry === 'string');
    return out.length > 0 ? out : undefined;
}
function rec(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
/** Serialize a nested record to a JSON string (IDL JSON-carrier convention). */
function jsonString(value) {
    const r = rec(value);
    if (!r)
        return undefined;
    try {
        return JSON.stringify(r);
    }
    catch {
        return undefined;
    }
}
function questionnaireTurnId(value) {
    const requester = rec(rec(value)?.requester);
    return str(requester?.runId);
}
/** Drop undefined-valued keys so optional IDL fields stay absent, not null. */
function prune(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined)
            out[k] = v;
    }
    return out;
}
//# sourceMappingURL=event-frame-mapper.js.map