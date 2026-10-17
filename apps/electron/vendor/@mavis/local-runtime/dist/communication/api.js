import { json, notFound, readFirstString, readJsonBody } from '../api/host-helpers.js';
import { observeSteerCompletion } from '../api/conversation-steer.js';
import { logger } from '../common/logger.js';
import { routeLocalCommunicationMessagesApi } from './messages-api.js';
export async function routeLocalCommunicationApi(input) {
    const tail = input.parts.slice(1).join('/');
    if (input.method === 'POST' && tail === 'send') {
        return routeLocalCommunicationSend(input, tail);
    }
    if (input.method === 'GET' && tail === 'messages') {
        return routeLocalCommunicationMessagesApi({
            url: new URL(input.request.url),
            store: input.communicationMessageStore,
        });
    }
    if (input.method === 'GET' && tail === 'peers') {
        return routeLocalCommunicationPeers(input, new URL(input.request.url));
    }
    return notFound(`/communication/${tail || input.method.toLowerCase()}`);
}
async function routeLocalCommunicationSend(input, tail) {
    void tail;
    const body = await readJsonBody(input.request);
    const fromSession = readFirstString(body, ['fromSession', 'from_session']);
    const toSession = readFirstString(body, ['toSession', 'to_session']);
    const command = readFirstString(body, ['command']);
    const content = readFirstString(body, ['content']) ?? '';
    const messageId = input.nowMs();
    if (!fromSession) {
        return json({ error: 'fromSession is required', code: 'bad_request' }, { status: 400 });
    }
    if (!command) {
        return json({ error: 'command is required', code: 'bad_request' }, { status: 400 });
    }
    if (command !== 'prompt') {
        if (fromSession && toSession) {
            await recordCommunicationMessage(input, {
                messageId: String(messageId),
                fromSession,
                toSession,
                command,
                content,
                status: 'failed',
                error: `Local runtime communication command "${command}" is not supported in clean mode.`,
            });
        }
        return json({
            messageId,
            status: 'failed',
            error: `Local runtime communication command "${command}" is not supported in clean mode.`,
            code: 'local_communication_command_unsupported',
        }, { status: 400 });
    }
    if (!toSession) {
        return json({
            messageId,
            status: 'failed',
            error: 'Command "prompt" requires a toSession parameter',
            code: 'bad_request',
        }, { status: 400 });
    }
    const sender = await input.getSessionById(fromSession);
    if (!sender) {
        await recordCommunicationMessage(input, {
            messageId: String(messageId),
            fromSession,
            toSession,
            command,
            content,
            status: 'failed',
            error: `fromSession not found: ${fromSession}`,
        });
        return json({
            messageId,
            status: 'failed',
            error: `fromSession not found: ${fromSession}`,
            code: 'session_not_found',
        }, { status: 404 });
    }
    const target = await input.getSessionById(toSession);
    if (!target) {
        await recordCommunicationMessage(input, {
            messageId: String(messageId),
            fromSession,
            toSession,
            command,
            content,
            status: 'failed',
            error: `toSession not found: ${toSession}`,
        });
        return json({
            messageId,
            status: 'failed',
            error: `toSession not found: ${toSession}`,
            code: 'session_not_found',
        }, { status: 404 });
    }
    if (target.runtime !== 'pi-agent') {
        await recordCommunicationMessage(input, {
            messageId: String(messageId),
            fromSession,
            toSession,
            command,
            content,
            status: 'failed',
            error: 'Communication to non-Pi sessions is disabled in clean local-runtime mode.',
        });
        return json({
            messageId,
            status: 'failed',
            error: 'Communication to non-Pi sessions is disabled in clean local-runtime mode.',
            code: 'legacy_runtime_disabled',
        }, { status: 409 });
    }
    if (!input.conversation) {
        return json({
            messageId,
            status: 'failed',
            error: 'Runtime Conversation is unavailable',
            code: 'conversation_unavailable',
        }, { status: 503 });
    }
    return sendThroughConversation(input, {
        messageId,
        fromSession,
        toSession,
        command,
        content,
    });
}
/**
 * This route has no host-injected logger in scope, so the completion observer
 * gets a facade-backed adapter. Without it an `activated` steer's rejection is
 * consumed and left untraced.
 */
function createSteerCompletionLogger(message) {
    const origin = {
        component: 'local-runtime.communication',
        fromSession: message.fromSession,
        messageId: String(message.messageId),
    };
    return {
        info: (ctx, text) => logger.info({ ...origin, sessionId: ctx.sessionId, turnId: ctx.turnId }, text),
        warn: (ctx, text) => logger.warn({ ...origin, sessionId: ctx.sessionId, turnId: ctx.turnId }, text),
    };
}
async function sendThroughConversation(input, message) {
    try {
        const steered = await input.conversation.ingress.steer({
            sessionId: message.toSession,
            source: 'communication',
            producerId: `communication:${message.fromSession}`,
            idempotencyKey: String(message.messageId),
            message: {
                content: message.content,
                attachments: [],
                origin: { fromSession: message.fromSession, command: message.command },
            },
        });
        // Communication reports delivery on admission; the target Turn runs on.
        observeSteerCompletion(steered, {
            sessionId: message.toSession,
            producer: 'Local communication send',
            matrixLogger: createSteerCompletionLogger(message),
        });
        await recordCommunicationMessage(input, {
            ...message,
            messageId: String(message.messageId),
            status: 'delivered',
        });
        return json({
            messageId: message.messageId,
            status: 'delivered',
            data: {
                fromSession: message.fromSession,
                toSession: message.toSession,
                command: message.command,
            },
        });
    }
    catch (error) {
        return communicationFailure(input, message, error instanceof Error ? error.message : String(error));
    }
}
async function communicationFailure(input, message, error) {
    await recordCommunicationMessage(input, {
        ...message,
        messageId: String(message.messageId),
        status: 'failed',
        error,
    });
    return json({
        messageId: message.messageId,
        status: 'failed',
        error,
        code: 'local_communication_send_failed',
    }, { status: 400 });
}
async function recordCommunicationMessage(input, record) {
    await input.communicationMessageStore.append({
        ...record,
        createdAtMs: input.nowMs(),
    });
}
async function routeLocalCommunicationPeers(input, url) {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
        return json({ error: 'sessionId query parameter is required', code: 'bad_request' }, { status: 400 });
    }
    const session = await input.getSessionById(sessionId);
    if (!session)
        return json({ sessions: [], count: 0 });
    const agentFilter = url.searchParams.get('agent') ?? undefined;
    const sessions = (await input.listAllSessions(agentFilter)).filter((item) => item.sessionId !== sessionId && !item.archived && item.visibility !== 'hidden');
    return json({
        sessions: sessions.map((item) => ({
            sessionId: item.sessionId,
            agentName: item.agentName,
            agentRole: item.parentSessionId ? 'child' : 'root',
            title: item.title ?? undefined,
            status: item.status,
        })),
        count: sessions.length,
    });
}
//# sourceMappingURL=api.js.map