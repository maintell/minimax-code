import { RuntimeEventStatus, RuntimeEventType, } from '@mavis/agent-core/protocol';
import { isSelfReminderId } from '@mavis/shared/cron-purpose';
import { imLogger } from '@mavis/shared/local-runtime-logging/im-logger';
import { isTurnLifecycleMessageKind } from '@mavis/shared/turn-message-kind';
import { toConversationCommittedMessage } from '../../session-system/index.js';
import { incompleteReplyAddress, isBackgroundTaskWake, resolveAssignmentReplyRoute, resolveChannelRoute, resolveWakeReplyRoute, } from './routing.js';
/**
 * A Bunny Turn woken by a task report or a verdict answers the task's chat only
 * when it concluded something for the user: it recorded a conclusion or asked
 * the user. A Turn that only sent rework, or read a failed review, stays on the
 * desktop.
 */
const ASSIGNMENT_REPLY_TOOLS = new Set(['assignment_summary', 'ask_user']);
/** Bunny's way of saying the Turn has nothing for the user. */
const NOTHING_TO_SAY = new Set(['无', '无。']);
function outboundReply(source) {
    const assignment = resolveAssignmentReplyRoute(source);
    if (assignment)
        return {
            route: assignment,
            requiresConclusion: true,
            retriedOnFailure: reportRetriedOnFailure(source),
            replyScope: 'turn',
        };
    const wake = resolveWakeReplyRoute(source);
    if (!wake)
        return undefined;
    // Neither a schedule run nor a background-task delivery is run again after its Turn
    // fails (both retry only the hand-off before the Turn starts), so their failure is final.
    return {
        route: wake,
        requiresConclusion: !isUserSchedule(source),
        retriedOnFailure: false,
        // Same predicate that decided whether this reply quotes its originating
        // message, so the quote and the scope can never disagree.
        replyScope: isBackgroundTaskWake(source) ? 'background' : 'turn',
    };
}
/** A schedule the user asked for, as opposed to Bunny's self-reminder or a background task. */
function isUserSchedule(source) {
    if (source?.source !== 'cron')
        return false;
    const cronId = source.sourceContext?.cronId;
    return typeof cronId === 'string' && !isSelfReminderId(cronId);
}
/** The report service marks a report Turn whose failed review it will deliver again. */
function reportRetriedOnFailure(source) {
    const origin = source?.sourceContext?.origin;
    if (!origin || typeof origin !== 'object')
        return false;
    const report = Reflect.get(origin, 'assignmentReport');
    return (typeof report === 'object' &&
        report !== null &&
        Reflect.get(report, 'retriedOnFailure') === true);
}
/**
 * Best-effort terminal observer for Channel-sourced Turns.
 *
 * The Agent event pipeline only selects a durable terminal boundary. Actual
 * Channel routing and transport delivery stay behind an injected product
 * capability.
 */
export class ChannelFinalReplyObserver {
    options;
    constructor(options) {
        this.options = options;
    }
    async observeRuntimeEvent(input) {
        const status = terminalStatus(input.event);
        if (!status)
            return;
        try {
            await this.deliverTerminal(input.context, input.event, status);
        }
        finally {
            await this.options.turnLifecycle.end(input.context);
        }
    }
    async deliverTerminal(context, event, status) {
        const route = await this.resolveReplyChannel(context);
        if (!route)
            return this.deliverAssignmentReply(context, event, status);
        const [messages, session] = await Promise.all([
            this.options.messages.listTurn(context.sessionId, context.turnId),
            this.options.sessions.get(context.sessionId),
        ]);
        if (status !== 'failed' && !messages.some(isAssistantReply))
            return;
        const error = status === 'failed' ? terminalError(event) : undefined;
        await this.options.delivery.deliver({
            channelContext: route,
            sessionId: context.sessionId,
            messages: messages.map(toConversationCommittedMessage),
            ...(session ? { workspaceDir: session.workspaceDir } : {}),
            ...(error ? { error } : {}),
        });
    }
    /**
     * A report-back or verdict Turn of a task dispatched from an IM chat, a run of
     * a schedule Bunny created from one, or a delivery of background tasks Bunny
     * started from one, sends its result back there. Best effort: the desktop shows the Turn either way,
     * so a chat that cannot be reached (no client, no WeChat token, a send
     * error) is logged and nothing else is tried, and the Turn still ends.
     */
    async deliverAssignmentReply(context, event, status) {
        if (status === 'aborted')
            return;
        const { outbound, missing } = await this.resolveOutboundReply(context);
        if (!outbound) {
            if (missing)
                this.warnIncompleteAddress(context, missing);
            return;
        }
        // Only a final failure reaches the chat; a retried one would repeat itself there.
        if (status === 'failed' && outbound.retriedOnFailure)
            return;
        try {
            await this.sendAssignmentReply(context, event, status, outbound);
        }
        catch (error) {
            (this.options.logger ?? imLogger).warn({
                sessionId: context.sessionId,
                turnId: context.turnId,
                platform: outbound.route.platform,
                error: error instanceof Error ? error.message : String(error),
            }, 'Assignment reply could not reach its chat; it stays on the desktop');
        }
    }
    /** Sends a final Turn's reply to its chat; a completed Turn only when it has something for the user. */
    async sendAssignmentReply(context, event, status, outbound) {
        const [messages, session] = await Promise.all([
            this.options.messages.listTurn(context.sessionId, context.turnId),
            this.options.sessions.get(context.sessionId),
        ]);
        const committed = messages.map(toConversationCommittedMessage);
        if (status === 'completed' && !repliesToUser(outbound, committed))
            return;
        const error = status === 'failed' ? terminalError(event) : undefined;
        await this.options.delivery.deliver({
            channelContext: outbound.route,
            sessionId: context.sessionId,
            messages: committed,
            ...(session ? { workspaceDir: session.workspaceDir } : {}),
            ...(error ? { error } : {}),
            replyScope: outbound.replyScope,
        });
    }
    /**
     * The reply of the first source that carries a usable address: the in-process
     * provenance, the Turn's persisted source, then the source a continuation
     * resumed. `missing` names the fields of an address that was found but cannot
     * be sent to, so the caller can say why the reply stayed on the desktop.
     */
    async resolveOutboundReply(context) {
        let missing;
        const pick = (source) => {
            const outbound = outboundReply(source);
            if (!outbound)
                missing ??= incompleteReplyAddress(source);
            return outbound;
        };
        const direct = pick(context.provenance);
        if (direct)
            return { outbound: direct };
        try {
            const persisted = pick(await this.options.messages.resolveTurnSource(context.sessionId, context.turnId));
            if (persisted)
                return { outbound: persisted };
            const continuedFromTurnId = context.provenance?.sourceContext?.continuedFromTurnId;
            if (context.provenance?.source === 'turn-continuation' &&
                typeof continuedFromTurnId === 'string') {
                const continued = pick(await this.options.messages.resolveTurnSource(context.sessionId, continuedFromTurnId));
                if (continued)
                    return { outbound: continued };
            }
        }
        catch {
            // An unreadable source is no address; the Turn stays on the desktop.
        }
        return missing ? { missing } : {};
    }
    warnIncompleteAddress(context, missing) {
        (this.options.logger ?? imLogger).warn({ sessionId: context.sessionId, turnId: context.turnId, missing: [...missing] }, 'Assignment reply address is incomplete; it stays on the desktop');
    }
    async resolveReplyChannel(context) {
        let route = resolveChannelRoute(context.provenance) ??
            (await this.resolvePersistedTurnChannel(context.sessionId, context.turnId));
        // A retry has a fresh Turn id and no new user message. Resolve only the
        // original input selected by continuation, not an unrelated earlier IM.
        const continuedFromTurnId = context.provenance?.sourceContext?.continuedFromTurnId;
        if (!route &&
            context.provenance?.source === 'turn-continuation' &&
            typeof continuedFromTurnId === 'string') {
            route = await this.resolvePersistedTurnChannel(context.sessionId, continuedFromTurnId);
        }
        return route;
    }
    /**
     * Routing from the Turn's first persisted user message. It stays readable
     * for the whole Turn, so IM ingress uses the same answer to decide whether
     * a follow-up may join the running Turn.
     */
    async resolvePersistedTurnChannel(sessionId, turnId) {
        const persisted = await this.options.messages.resolveTurnSource(sessionId, turnId);
        return resolveChannelRoute(persisted);
    }
}
function terminalStatus(event) {
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
function terminalError(event) {
    const error = event.payload.error?.message?.trim();
    if (error)
        return error;
    const stopReason = event.payload.stop_reason?.message?.trim();
    return stopReason || 'Turn failed';
}
/** A completed Turn's reply goes out only when it says what its kind of Turn must. */
function repliesToUser(outbound, messages) {
    return outbound.requiresConclusion ? concludesForUser(messages) : hasWordsForUser(messages);
}
/** The Turn recorded a conclusion or asked the user, and has words for them. */
function concludesForUser(messages) {
    const used = messages.some((message) => message.toolCalls?.some((call) => ASSIGNMENT_REPLY_TOOLS.has(call.tool_name)));
    if (!used)
        return false;
    return hasWordsForUser(messages);
}
/** The final reply has text, and it is not Bunny saying it has nothing to report. */
function hasWordsForUser(messages) {
    const reply = finalReplyText(messages);
    return reply !== '' && !NOTHING_TO_SAY.has(reply);
}
/** What the channel collector sends in result mode: the assistant text after the last tool call. */
function finalReplyText(messages) {
    let body = '';
    let afterTool = false;
    for (const message of messages) {
        if (message.role === 'user' || message.role === 'system')
            continue;
        if (isTurnLifecycleMessageKind(message.kind))
            continue;
        if (message.raw?.msg_content_source === 'system_error')
            continue;
        if (message.toolCalls?.length)
            afterTool = true;
        if (!message.text)
            continue;
        if (afterTool) {
            body = '';
            afterTool = false;
        }
        body += message.text;
    }
    return body.trim();
}
function isAssistantReply(message) {
    return message.role === 'assistant';
}
//# sourceMappingURL=channel-final-reply-observer.js.map