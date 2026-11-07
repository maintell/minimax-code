import { CronExecutor, CronRegistry, configureCronHost, } from '@mavis/cron';
import { MsgType, RespDataType, Role as AgentMessageRole, } from '@mavis/agent-core/protocol/agent-message';
import { KeyedOperationQueue } from '../../../../infra/util/keyed-operation-queue.js';
import { startCronRuntimeWithMigration } from '../legacy-md-migration.js';
import { collectChannelResponseFromSse } from './sse-collector.js';
import { buildCronHistoryMessage } from './history-message.js';
import { localCronScheduler, toCronSessionStatus } from './runtime-contracts.js';
/** Queued cron prompts expire after 30 minutes (daemon executor parity). */
const CRON_QUEUE_ITEM_TTL_MS = 30 * 60 * 1000;
export function createLocalCronRuntime(options) {
    const eventBus = new LocalCronEventBus((type, payload) => options.emitBusEvent(type, payload));
    // Handler registry behind the bridge's `onResponse` (daemon SessionBridge
    // parity); shared with the queued-cron drain so retried dispatches feed the
    // same channel-delivery listeners.
    const responseHandlers = new Set();
    const fanOutTurnResponse = buildCronTurnFanOut(options, responseHandlers);
    const sessionBridge = buildLocalCronSessionBridge(options, responseHandlers, fanOutTurnResponse);
    const sessionLifecycle = buildLocalCronSessionLifecycle(options);
    const agentSpawner = buildLocalCronAgentSpawner(options);
    const messageQueue = new LocalCronMessageQueue();
    const cronHost = {
        cronStore: options.cronStore,
        sessionLifecycle,
        agentSpawner,
        messageQueue,
        ...(options.channelDelivery ? { channelDelivery: options.channelDelivery } : {}),
    };
    const ensureConfigured = () => {
        configureCronHost({
            datetimeHelpers: buildLocalCronDatetimeHelpers(options.nowMs),
            ...(options.metricsReporter ? { metricsReporter: options.metricsReporter } : {}),
        });
    };
    ensureConfigured();
    const executor = new CronExecutor(sessionBridge, eventBus, cronHost);
    const registry = new CronRegistry(executor, eventBus, {
        unrefTimers: true,
        scheduler: localCronScheduler,
        cronHost,
    });
    const cronConsumerEnabled = options.cronConsumerEnabled ?? true;
    let startPromise;
    const ensureStarted = (reason = 'unspecified') => {
        ensureConfigured();
        const alreadyRequested = Boolean(startPromise);
        options.emitBusEvent('cron.runtime_start_requested', buildCronStartupDiagnostics(options, reason, alreadyRequested));
        if (!cronConsumerEnabled) {
            options.emitBusEvent('cron.runtime_start_skipped', {
                ...buildCronStartupDiagnostics(options, reason, alreadyRequested),
                skipReason: 'consumer_disabled',
            });
            return Promise.resolve();
        }
        if (!startPromise) {
            options.emitBusEvent('cron.runtime_starting', buildCronStartupDiagnostics(options, reason, false));
            startPromise = startCronRuntime(options, registry, reason);
        }
        return startPromise;
    };
    return {
        registry,
        cronStore: options.cronStore,
        cronConsumerEnabled,
        ensureConfigured,
        ensureStarted,
        deleteAgentTasks: async (agentName) => {
            if (!cronConsumerEnabled) {
                const tasks = await options.cronStore.listByAgent(agentName);
                for (const task of tasks)
                    await options.cronStore.delete(agentName, task.cronName);
                return;
            }
            await ensureStarted('delete_agent_tasks');
            for (const task of registry.listTasks(agentName)) {
                await registry.deleteTask(agentName, task.cronName, { mutationSource: 'system' });
            }
        },
        notifyTurnFinished: (sessionId, status) => {
            // The executor drains its BusyQueue on terminal events emitted with
            // source 'session-bridge' (executor.ts subscriptions): session.finish,
            // session.error and session.abort.
            const type = cronTerminalEventType(status);
            if (!type)
                return;
            eventBus.emitInternal(type, 'session-bridge', { sessionId });
            // Recover cron prompts stranded by the 409 dispatch race (see
            // drainQueuedCronPrompts) now that this session's turn ended.
            scheduleCronPromptDrain(options, fanOutTurnResponse, sessionId);
        },
        stop: () => registry.stop(),
    };
}
async function startCronRuntime(options, registry, reason) {
    try {
        await startCronRuntimeWithMigration(options, localCronScheduler, registry);
        options.emitBusEvent('cron.runtime_started', {
            ...buildCronStartupDiagnostics(options, reason, false),
            taskCount: registry.listAllTasks().length,
        });
    }
    catch (err) {
        options.emitBusEvent('cron.runtime_start_failed', {
            ...buildCronStartupDiagnostics(options, reason, false),
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
}
function buildCronStartupDiagnostics(options, reason, alreadyRequested) {
    return {
        reason,
        alreadyRequested,
        runtimeOwnerKind: options.runtimeOwnerKind ?? null,
        runtimeOwnerId: options.runtimeOwnerId ?? null,
        runtimeMode: options.runtimeMode ?? null,
        cliEmbedded: options.capabilities?.cliEmbedded ?? null,
        electronHost: options.capabilities?.electronHost ?? null,
        dataDir: options.dataDir(),
        pid: process.pid,
        ppid: process.ppid,
        execPath: process.execPath,
        argv: sanitizeProcessArgv(process.argv),
        cwd: process.cwd(),
        platform: process.platform,
        nodeVersion: process.version,
    };
}
function sanitizeProcessArgv(argv) {
    const secretName = /(?:token|secret|password|passwd|pwd|api[-_]?key|apikey|credential|authorization|auth)/i;
    const sanitized = [];
    let redactNext = false;
    for (const arg of argv.slice(0, 40)) {
        if (redactNext) {
            sanitized.push('[REDACTED]');
            redactNext = false;
            continue;
        }
        const equalsIndex = arg.indexOf('=');
        if (equalsIndex > 0) {
            const name = arg.slice(0, equalsIndex);
            const value = arg.slice(equalsIndex + 1);
            if (secretName.test(name) || secretName.test(value)) {
                sanitized.push(`${name}=[REDACTED]`);
                continue;
            }
        }
        if (secretName.test(arg)) {
            if (/^-{1,2}[^=:]+$/.test(arg)) {
                sanitized.push(arg);
                redactNext = true;
                continue;
            }
            sanitized.push('[REDACTED]');
            continue;
        }
        sanitized.push(arg);
    }
    if (argv.length > sanitized.length)
        sanitized.push(`...(${argv.length - sanitized.length} more)`);
    return sanitized;
}
function buildLocalCronDatetimeHelpers(nowMs) {
    return {
        nowMs,
        formatLocalMonthDayTime: (ts) => formatLocalDateParts(ts).slice(5, 16),
        formatLocalDateTime: (ts) => formatLocalDateParts(ts),
        formatLocalDate: (date) => formatLocalDateParts(date).slice(0, 10),
        todayLocal: () => formatLocalDateParts(nowMs()).slice(0, 10),
    };
}
function formatLocalDateParts(ts) {
    const date = ts instanceof Date ? ts : new Date(ts);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
function buildCronTurnFanOut(options, responseHandlers) {
    return (sessionId, raw) => {
        if (responseHandlers.size === 0)
            return;
        const collected = collectChannelResponseFromSse(raw);
        const message = {
            rawData: '',
            end: true,
            source: 'cron',
            ...(collected.text
                ? {
                    respData: {
                        type: RespDataType.AgentMessage,
                        agent_message: {
                            msg_id: `cron-turn:${sessionId}:${options.nowMs()}`,
                            role: AgentMessageRole.Assistant,
                            msg_type: MsgType.AgentContent,
                            msg_content: collected.text,
                            timestamp: options.nowMs(),
                        },
                    },
                }
                : {}),
        };
        for (const handler of [...responseHandlers]) {
            scheduleCronResponseHandler(handler, sessionId, message);
        }
    };
}
/**
 * Dispatch still-queued cron prompts once the session is idle again.
 *
 * Covers the dispatch race the bridge cannot retry by itself: the executor's
 * busy check saw the session idle (so nothing was parked in its BusyQueue),
 * but a user/API turn won the `openLocalMessageStream` gate and the bridge's
 * `runQueuedTurn` came back 409, leaving the enqueued cron item stranded
 * (cron items are excluded from mid-turn injection). Invoked from
 * `notifyTurnFinished` on every turn-terminal event — daemon parity with
 * `SessionInboundQueue`'s idle drain. Dispatches at most one turn per call;
 * that turn's own terminal event drains any remaining items.
 */
function cronTerminalEventType(status) {
    if (status === 'finished')
        return 'session.finish';
    if (status === 'error')
        return 'session.error';
    if (status === 'aborted' || status === 'interrupted')
        return 'session.abort';
    return undefined;
}
function scheduleCronPromptDrain(options, fanOut, sessionId) {
    const drain = async () => {
        try {
            await drainQueuedCronPrompts(options, fanOut, sessionId);
        }
        catch {
            // A terminal event must remain best-effort; the next terminal event retries.
        }
    };
    queueMicrotask(drain);
}
/** @internal Exported only for focused tests. */
export async function drainQueuedCronPrompts(options, fanOut, sessionId) {
    if (options.activePiTurns.has(sessionId))
        return;
    const queued = (await options.queueStore.list(sessionId)).filter((item) => item.status === 'queued' && item.source === 'cron');
    if (queued.length === 0)
        return;
    const session = await options.getSessionById(sessionId);
    if (!session)
        return;
    for (const item of queued) {
        if (options.activePiTurns.has(sessionId))
            return;
        const response = await options.runQueuedTurn({ session, queuedMessage: item });
        // 409: lost the idle race again — the next terminal event retries.
        if (response.status === 409)
            return;
        // Other failures stay queued; the 30min expiry bounds the backlog.
        if (response.status >= 400)
            continue;
        scheduleCronResponseFanOut(response, sessionId, fanOut);
        return;
    }
}
async function readCronResponseText(response) {
    try {
        return await response.text();
    }
    catch {
        return '';
    }
}
function scheduleCronResponseHandler(handler, sessionId, message) {
    const invoke = async () => {
        try {
            await handler(sessionId, message);
        }
        catch {
            // Channel response listeners are best-effort and must not affect cron.
        }
    };
    queueMicrotask(invoke);
}
function scheduleCronResponseFanOut(response, sessionId, fanOut) {
    const drain = async () => {
        try {
            fanOut(sessionId, await response.text());
        }
        catch {
            // Turn failures are reflected on the queue item by finishDrain.
        }
    };
    queueMicrotask(drain);
}
function buildLocalCronSessionBridge(options, responseHandlers, fanOutTurnResponse) {
    return {
        sendMessage: async (...args) => {
            const [, agentName, sessionId, msg] = args;
            const session = await options.getSessionById(sessionId);
            if (!session)
                throw new Error(`Session not found: ${sessionId}`);
            if (session.agentName !== agentName) {
                throw new Error(`Session ${sessionId} does not belong to agent ${agentName}`);
            }
            await enqueueAndDispatchCronMessage(options, session, msg, fanOutTurnResponse);
        },
        onResponse: (handler) => {
            responseHandlers.add(handler);
            return () => responseHandlers.delete(handler);
        },
        hasActiveTurn: (sessionId) => options.activePiTurns.has(sessionId),
        getActiveSource: () => undefined,
    };
}
async function enqueueAndDispatchCronMessage(options, session, msg, fanOutTurnResponse) {
    const cronName = readInboundCronName(msg.inboundContext);
    const historyMessage = buildCronHistoryMessage(msg);
    const queued = await options.queueStore.enqueue(session, {
        content: historyMessage.content,
        ...(historyMessage.source ? { source: historyMessage.source } : {}),
        ...(historyMessage.origin !== undefined ? { origin: historyMessage.origin } : {}),
    }, {
        source: 'cron',
        ...(cronName ? { dedupeKey: `${msg.source ?? 'cron'}:${cronName}` } : {}),
        expiresAt: options.nowMs() + CRON_QUEUE_ITEM_TTL_MS,
    });
    if (!queued)
        throw new Error(`Failed to enqueue cron prompt for session ${session.sessionId}`);
    if (options.activePiTurns.has(session.sessionId))
        return;
    const response = await options.runQueuedTurn({ session, queuedMessage: queued });
    if (response.status === 409)
        return;
    if (response.status >= 400) {
        const detail = await readCronResponseText(response);
        throw new Error(`Cron dispatch failed for session ${session.sessionId}: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
    }
    scheduleCronResponseFanOut(response, session.sessionId, fanOutTurnResponse);
}
function readInboundCronName(inboundContext) {
    if (!inboundContext || typeof inboundContext !== 'object')
        return undefined;
    const value = inboundContext.cronName;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function buildLocalCronSessionLifecycle(options) {
    return {
        getRootSession: async (agentName) => {
            const sessions = await options.listAllSessions(agentName, { includeHidden: true });
            return sessions
                .filter((session) => session.sessionType === 'root')
                .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
                .map(toCronSessionInfo)[0];
        },
        getSession: async (sessionId) => {
            const session = await options.getSessionById(sessionId);
            return session ? toCronSessionInfo(session) : undefined;
        },
        getSessionStatus: async (_ctx, sessionId) => {
            // Busy truth lives in activePiTurns (the in-process turn tracker).
            // The stored record may keep status 'started' while no turn is active
            // (stale rows are normalized lazily, other-process locks linger), so
            // stored 'started' without an active turn must not report busy.
            if (options.activePiTurns.has(sessionId))
                return { type: 'started' };
            const session = await options.getSessionById(sessionId);
            if (!session)
                return { type: 'error', message: 'not found' };
            const status = toCronSessionStatus(session.status);
            return status.type === 'started' ? { type: 'finished' } : status;
        },
        setSessionArchived: async (sessionId, archived) => {
            const session = await options.getSessionById(sessionId);
            if (!session)
                return;
            await options.updateSession(sessionId, { archived });
        },
        deleteSession: async (sessionId) => {
            await options.deleteSession(sessionId);
            await options.deleteMessageState(sessionId);
        },
        listByPurposePrefix: async (purposePrefix) => {
            const sessions = await options.listAllSessions(undefined, {
                includeHidden: true,
                includePurposePrefix: purposePrefix,
            });
            return sessions.map(toCronSessionInfo);
        },
        seedGeneratedTitle: async (sessionId, title, seedOptions) => {
            const session = await options.getSessionById(sessionId);
            if (!session)
                return;
            if (seedOptions?.onlyIfEmpty && session.title && session.title.trim())
                return;
            await options.updateSession(sessionId, { title });
        },
    };
}
function buildLocalCronAgentSpawner(options) {
    return {
        newSession: async (...args) => {
            const [, agentName, workspaceDir, parentSessionId, title, , , createOptions] = args;
            const parent = parentSessionId ? await options.getSessionById(parentSessionId) : undefined;
            const localAgent = await options.agentRoutes.getLocalAgent(agentName);
            if (!localAgent && agentName !== options.primaryAgentName) {
                throw new Error(`Agent not found: ${agentName}`);
            }
            const session = await options.agentRoutes.createSession({
                agentName,
                workspaceDir: workspaceDir ??
                    parent?.workspaceDir ??
                    localAgent?.defaultWorkspaceDir ??
                    options.resolveDefaultWorkspaceDir(),
                sessionType: 'branch',
                sessionKind: 'cron',
                parentSessionId: parentSessionId ?? null,
                title: title ?? null,
                visibility: createOptions?.visibility,
                purpose: createOptions?.purpose,
                isDefaultWorkspace: workspaceDir !== undefined ? false : parent?.isDefaultWorkspace,
            });
            return { sessionId: session.sessionId };
        },
    };
}
class LocalCronMessageQueue {
    buckets = new KeyedOperationQueue();
    async enqueue(_lane, bucketKey, task, _opts) {
        return this.buckets.run(bucketKey, task);
    }
}
class LocalCronEventBus {
    emitRuntimeEvent;
    listeners = new Map();
    constructor(emitRuntimeEvent) {
        this.emitRuntimeEvent = emitRuntimeEvent;
    }
    emit(type, source, payload) {
        this.emitRuntimeEvent(type, payload ?? {});
        this.emitInternal(type, source, payload);
    }
    emitInternal(type, source, payload) {
        for (const handler of this.listeners.get(type) ?? []) {
            handler({ type, source, payload });
        }
    }
    on(type, handler) {
        const handlers = this.listeners.get(type) ?? new Set();
        handlers.add(handler);
        this.listeners.set(type, handlers);
        return () => {
            handlers.delete(handler);
            if (handlers.size === 0)
                this.listeners.delete(type);
        };
    }
}
function toCronSessionInfo(session) {
    return {
        sessionId: session.sessionId,
        agentName: session.agentName,
        sessionType: session.sessionType === 'root' ? 1 : 0,
        // Local runtime has no compaction concept: `archived` is user-facing
        // archive state, not compaction, so archived sessions must not be
        // dropped from cron history as compacted-out.
        compressed: false,
        status: { type: session.status },
        purpose: session.purpose,
    };
}
//# sourceMappingURL=runtime.js.map