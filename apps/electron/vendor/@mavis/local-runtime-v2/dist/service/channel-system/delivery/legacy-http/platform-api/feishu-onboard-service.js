import { json, notFound, readFirstString, readJsonBody } from '../http-helpers.js';
import { AgentContractHttpError, isAgentContractLikeError } from '../agent-contract-error.js';
import { captureConnectionBindingCompensation, logConnectionBindingState, } from './connection-binding.js';
import { LocalFeishuOnboardHttpClient } from './feishu-onboard-http.js';
import { LocalImConnectionError, } from '../../../binding/im-connection-types.js';
import { serialize, } from '../../../transport/feishu/feishu-onboard-session.js';
const FINISHED_TTL_MS = 5 * 60_000;
export class LocalFeishuOnboardService {
    sessions = new Map();
    feishu;
    resolveAgentWriteTarget;
    bindingStore;
    imConnectionStore;
    accessControlStore;
    bindRootlessDefaultSession;
    ensureRootSession;
    nowMs;
    makeId;
    onboardingHttp;
    metrics;
    constructor(options) {
        this.feishu = options.feishu;
        this.resolveAgentWriteTarget = options.resolveAgentWriteTarget;
        this.bindingStore = options.bindingStore;
        this.imConnectionStore = options.imConnectionStore;
        this.accessControlStore = options.accessControlStore;
        this.bindRootlessDefaultSession = options.bindRootlessDefaultSession;
        this.ensureRootSession = options.ensureRootSession;
        this.nowMs = options.nowMs;
        this.makeId = options.makeId;
        this.metrics = options.metrics;
        this.onboardingHttp = new LocalFeishuOnboardHttpClient(options);
    }
    async route(request, method, parts, url) {
        if (parts[0] !== 'lark' || parts[1] !== 'onboard')
            return notFound(`/${parts.join('/')}`);
        const action = parts[2];
        if (method === 'POST' && action === 'start')
            return this.startGuarded(request);
        if (method === 'GET' && action === 'status')
            return this.status(url);
        if (method === 'POST' && action === 'cancel')
            return this.cancel(request);
        return notFound(`/lark/onboard/${action ?? ''}`);
    }
    /** start() with the contract-error → JSON mapping the route relies on. */
    async startGuarded(request) {
        try {
            return await this.start(request);
        }
        catch (err) {
            // Structural check: the write resolver is an injected v1 closure and
            // throws the v1 LocalAgentContractError class; our own facade throws
            // the channel-system twin. Both map to the same JSON contract.
            if (isAgentContractLikeError(err) || err instanceof LocalImConnectionError) {
                return json({ ok: false, error: err.message, code: err.code, localRuntime: true }, { status: err.status });
            }
            throw err;
        }
    }
    async start(request) {
        await this.sweep();
        const body = await readJsonBody(request);
        const connectionId = readFirstString(body, ['connectionId', 'connection_id']);
        const explicitRequestedName = readFirstString(body, ['agentName', 'agent_name']);
        const requestedName = explicitRequestedName ?? 'mavis';
        if (!connectionId && !this.resolveAgentWriteTarget) {
            throw new AgentContractHttpError(503, 'Agent write resolver is unavailable', 'AGENT_RESOLVER_UNAVAILABLE');
        }
        const connection = connectionId
            ? await this.requireConnection(connectionId, explicitRequestedName)
            : undefined;
        const agentName = connection
            ? connection.agentName
            : await this.resolveWriteAgentOrThrow(requestedName);
        const connectionLink = this.buildConnectionLink(connection, agentName);
        const sessionId = this.makeId('lark_onboard');
        const skipUserAuth = body.skipUserAuth === true;
        if (connectionLink) {
            await connectionLink.store.beginAuthorization({
                connectionId: connectionLink.connectionId,
                channel: 'feishu',
                platformSessionId: sessionId,
            });
            logConnectionBindingState(connectionLink, 'start');
        }
        const started = await this.onboardingHttp.beginAppRegistration();
        if (!started.ok) {
            return this.failStart({ sessionId, agentName, skipUserAuth, connection, connectionLink });
        }
        const now = this.nowMs();
        const session = {
            sessionId,
            agentName,
            status: 'app_pending',
            appDeviceCode: started.deviceCode,
            verificationUriComplete: started.verificationUriComplete,
            userCode: started.userCode,
            expiresAtMs: now + started.expiresInSec * 1000,
            intervalSec: started.intervalSec,
            skipUserAuth,
            ...(connection ? { connectionId: connection.connectionId } : {}),
        };
        this.sessions.set(sessionId, session);
        if (connectionLink) {
            await connectionLink.store.beginAuthorization({
                connectionId: connectionLink.connectionId,
                channel: 'feishu',
                platformSessionId: sessionId,
                expiresAt: session.expiresAtMs,
            });
            logConnectionBindingState(connectionLink, 'pending');
        }
        return json({ ok: true, ...serialize(session, now) });
    }
    /** Connection bookkeeping link; absent without a Connection or its store. */
    buildConnectionLink(connection, agentName) {
        return connection && this.imConnectionStore
            ? {
                connectionId: connection.connectionId,
                channel: 'feishu',
                agentName,
                store: this.imConnectionStore,
            }
            : undefined;
    }
    /** Missing resolver is an assembly error, surfaced with the v1 503 code. */
    async resolveWriteAgentOrThrow(requestedName) {
        const resolveAgentWriteTarget = this.resolveAgentWriteTarget;
        if (!resolveAgentWriteTarget) {
            throw new AgentContractHttpError(503, 'Agent write resolver is unavailable', 'AGENT_RESOLVER_UNAVAILABLE');
        }
        return resolveAgentWriteTarget(requestedName);
    }
    /** Provider start failure: persist the error session + Connection state. */
    async failStart(scope) {
        const { sessionId, agentName, skipUserAuth, connection, connectionLink } = scope;
        const now = this.nowMs();
        const session = {
            sessionId,
            agentName,
            status: 'error',
            expiresAtMs: now,
            intervalSec: 5,
            skipUserAuth,
            error: 'FEISHU_ONBOARD_START_FAILED',
            ...(connection ? { connectionId: connection.connectionId } : {}),
        };
        this.sessions.set(sessionId, session);
        if (connectionLink) {
            await connectionLink.store.markAuthorizationError(connectionLink.connectionId, 'feishu', 'FEISHU_ONBOARD_START_FAILED');
            logConnectionBindingState(connectionLink, 'failed', {
                status: 502,
                code: 'FEISHU_ONBOARD_START_FAILED',
            });
        }
        this.metrics?.incr('channel_onboard_total', { channel: 'feishu', status: 'error' });
        return json({ ok: false, ...serialize(session, now) }, { status: 502 });
    }
    async status(url) {
        await this.sweep();
        const sessionId = url.searchParams.get('sessionId') ?? '';
        const session = this.sessions.get(sessionId);
        if (!session)
            return json({ ok: false, status: 'error', error: 'session not found' }, { status: 404 });
        await this.advance(session);
        await this.syncConnectionAuthorization(session);
        return json({ ok: session.status !== 'error', ...serialize(session, this.nowMs()) });
    }
    async cancel(request) {
        const body = await readJsonBody(request);
        const sessionId = readFirstString(body, ['sessionId', 'session_id']);
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        const cancelled = sessionId ? this.sessions.delete(sessionId) : false;
        if (session?.connectionId)
            await this.imConnectionStore?.cancelAuthorization(session.connectionId);
        return json({ ok: true, cancelled });
    }
    /** Called by the Connection-level cancel endpoint; legacy Lark cancel stays intact. */
    async cancelAuthorizationForConnection(connectionId) {
        for (const [sessionId, session] of this.sessions) {
            if (session.connectionId === connectionId)
                this.sessions.delete(sessionId);
        }
    }
    async advance(session) {
        if (session.status === 'done' || session.status === 'error')
            return;
        if (this.isExpired(session)) {
            this.markExpired(session);
            return;
        }
        if (session.status === 'app_pending') {
            await this.advanceApp(session);
            return;
        }
        if (session.status === 'user_pending')
            await this.advanceUser(session);
    }
    async advanceApp(session) {
        if (!session.appDeviceCode) {
            this.markError(session, 'FEISHU_ONBOARD_FAILED');
            return;
        }
        const poll = await this.onboardingHttp.pollAppRegistration(session.appDeviceCode);
        if (!poll.ok) {
            if (this.isExpired(session, poll.error))
                this.markExpired(session);
            else
                this.markError(session, 'FEISHU_ONBOARD_FAILED');
            return;
        }
        if (poll.pending)
            return;
        session.appId = poll.appId;
        session.appSecret = poll.appSecret;
        if (!(await this.bindBotWithCompensation(session)))
            return;
        if (session.skipUserAuth) {
            this.finish(session);
            return;
        }
        const user = await this.onboardingHttp.beginUserDeviceCode(session.appId);
        if (!user.ok) {
            this.markError(session, 'FEISHU_ONBOARD_FAILED');
            return;
        }
        const now = this.nowMs();
        session.status = 'user_pending';
        session.userDeviceCode = user.deviceCode;
        session.userVerificationUriComplete = user.verificationUriComplete;
        session.userCodeFromCli = user.userCode;
        session.userExpiresAtMs = now + user.expiresInSec * 1000;
        session.userIntervalSec = user.intervalSec;
    }
    /**
     * Bind the bot credentials and the rootless default session, rolling the
     * platform bind back through the captured compensation when local
     * persistence fails. Returns false after any terminal markError.
     */
    async bindBotWithCompensation(session) {
        const connectionLink = this.connectionLink(session);
        let compensate;
        if (connectionLink) {
            try {
                compensate = await captureConnectionBindingCompensation(this.feishu, connectionLink);
            }
            catch (error) {
                this.markError(session, error instanceof LocalImConnectionError
                    ? error.code
                    : 'FEISHU_ONBOARD_COMPENSATION_UNAVAILABLE');
                return false;
            }
        }
        const bound = await this.bindBot(session);
        if (!bound.ok) {
            this.markError(session, 'FEISHU_ONBOARD_FAILED');
            return false;
        }
        session.clientName = bound.clientName;
        try {
            await this.bindDefaultSession(session);
        }
        catch (error) {
            return this.rollbackFailedDefaultSessionBind(session, error, bound.clientName, compensate);
        }
        if (connectionLink)
            logConnectionBindingState(connectionLink, 'bound');
        session.botBound = true;
        return true;
    }
    /** Compensation path for a failed default-session bind; always returns false. */
    async rollbackFailedDefaultSessionBind(session, error, clientName, compensate) {
        if (compensate) {
            try {
                await compensate(clientName);
            }
            catch (compensationError) {
                this.markError(session, compensationError instanceof LocalImConnectionError
                    ? compensationError.code
                    : 'CHANNEL_PLATFORM_COMPENSATION_FAILED');
                return false;
            }
        }
        this.markError(session, error instanceof LocalImConnectionError ? error.code : 'FEISHU_ONBOARD_BIND_FAILED');
        return false;
    }
    async advanceUser(session) {
        if (!session.appId || !session.appSecret || !session.userDeviceCode) {
            this.markError(session, 'FEISHU_ONBOARD_FAILED');
            return;
        }
        const poll = await this.onboardingHttp.pollUserToken(session);
        if (!poll.ok) {
            if (this.isExpired(session, poll.error))
                this.markExpired(session);
            else
                this.markError(session, 'FEISHU_ONBOARD_FAILED');
            return;
        }
        if (poll.pending)
            return;
        session.userOpenId = poll.openId;
        session.userName = poll.name;
        this.finish(session);
    }
    finish(session) {
        session.status = 'done';
        session.confirmedAtMs = this.nowMs();
        // Terminal transition; advance() early-returns on 'done', so exactly once.
        this.metrics?.incr('channel_onboard_total', { channel: 'feishu', status: 'done' });
    }
    /** Terminal error transition — stable codes keep provider details out of status responses. */
    markError(session, error) {
        const wasError = session.status === 'error';
        session.status = 'error';
        session.error = error;
        this.metrics?.incr('channel_onboard_total', { channel: 'feishu', status: 'error' });
        const connectionLink = this.connectionLink(session);
        if (!wasError && connectionLink) {
            logConnectionBindingState(connectionLink, 'failed', {
                status: 502,
                code: 'FEISHU_ONBOARD_FAILED',
            });
        }
    }
    markExpired(session) {
        const wasError = session.status === 'error';
        session.status = 'error';
        session.error = 'authorization expired';
        this.metrics?.incr('channel_onboard_total', { channel: 'feishu', status: 'error' });
        session.expired = true;
        const connectionLink = this.connectionLink(session);
        if (!wasError && connectionLink) {
            logConnectionBindingState(connectionLink, 'expired', { code: 'FEISHU_ONBOARD_EXPIRED' });
        }
    }
    isExpired(session, providerError) {
        const expiresAtMs = session.status === 'user_pending' ? session.userExpiresAtMs : session.expiresAtMs;
        const providerExpired = providerError?.toLowerCase().includes('expired') === true;
        return providerExpired || (expiresAtMs !== undefined && this.nowMs() >= expiresAtMs);
    }
    async bindBot(session) {
        const result = await this.feishu.bindBody({
            agentName: session.agentName,
            appId: session.appId,
            appSecret: session.appSecret,
            botName: 'Mavis Feishu Bot',
            mode: 'websocket',
        });
        if ('error' in result) {
            return { ok: false };
        }
        return { ok: true, clientName: result.record.clientId };
    }
    async bindDefaultSession(session) {
        if (session.connectionId && this.imConnectionStore) {
            if (!session.clientName) {
                throw new LocalImConnectionError(502, 'FEISHU_CLIENT_ID_MISSING', 'Feishu onboarding did not return a transport client identity.');
            }
            await this.imConnectionStore.bind({
                connectionId: session.connectionId,
                clientName: session.clientName,
            });
            return;
        }
        if (this.bindRootlessDefaultSession) {
            await this.bindRootlessDefaultSession(session.agentName);
            return;
        }
        if (!this.bindingStore || !this.ensureRootSession)
            return;
        const root = await this.ensureRootSession(session.agentName);
        if (!root?.sessionId)
            return;
        await this.bindingStore.upsert({
            platform: 'feishu',
            chatType: 'agent',
            chatId: session.agentName,
            senderId: session.agentName,
            clientName: session.agentName,
            lane: 'interactive',
        }, { agentName: session.agentName, sessionId: root.sessionId, strategy: 'root', pinned: false });
        await this.accessControlStore?.ensureDefaultPolicy('feishu', session.agentName);
    }
    connectionLink(session) {
        if (!session.connectionId || !this.imConnectionStore)
            return undefined;
        return {
            connectionId: session.connectionId,
            channel: 'feishu',
            agentName: session.agentName,
            store: this.imConnectionStore,
        };
    }
    async requireConnection(connectionId, requestedAgentName) {
        if (!this.imConnectionStore) {
            throw new LocalImConnectionError(503, 'CHANNEL_CONNECTIONS_UNAVAILABLE', 'Channel Connections require the Local Runtime V2 Conversation composition.');
        }
        const connection = await this.imConnectionStore.getConnection(connectionId);
        if (!connection) {
            throw new LocalImConnectionError(404, 'CHANNEL_CONNECTION_NOT_FOUND', 'Channel Connection not found.');
        }
        if (connection.channel !== 'feishu') {
            throw new LocalImConnectionError(409, 'CHANNEL_CONNECTION_CHANNEL_MISMATCH', 'Channel mismatch.');
        }
        if (requestedAgentName) {
            const resolved = this.resolveAgentWriteTarget
                ? await this.resolveAgentWriteTarget(requestedAgentName)
                : requestedAgentName;
            if (resolved !== connection.agentName) {
                throw new LocalImConnectionError(409, 'CHANNEL_CONNECTION_AGENT_MISMATCH', 'The requested Agent does not match this Channel Connection.');
            }
        }
        return connection;
    }
    async syncConnectionAuthorization(session) {
        if (!session.connectionId || !this.imConnectionStore || session.botBound)
            return;
        if (session.status !== 'error')
            return;
        if (session.expired) {
            await this.imConnectionStore.expireAuthorization(session.connectionId);
            return;
        }
        await this.imConnectionStore.markAuthorizationError(session.connectionId, 'feishu', 'FEISHU_ONBOARD_FAILED');
    }
    async sweep() {
        const now = this.nowMs();
        for (const [sessionId, session] of this.sessions.entries()) {
            if (session.confirmedAtMs && now - session.confirmedAtMs > FINISHED_TTL_MS) {
                this.sessions.delete(sessionId);
                continue;
            }
            if (session.status !== 'done' && session.status !== 'error' && this.isExpired(session)) {
                this.markExpired(session);
                await this.syncConnectionAuthorization(session);
            }
        }
    }
}
//# sourceMappingURL=feishu-onboard-service.js.map