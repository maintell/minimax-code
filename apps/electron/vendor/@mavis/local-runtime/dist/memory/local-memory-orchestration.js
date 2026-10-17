import { isMemoryV2Enabled } from '@mavis/config';
import { formatLocalDate } from './local-memory-store-utils.js';
import { LocalMemoryError } from './types.js';
export function handleMemoryBusEvent(input) {
    if (input.type !== 'memory.saved')
        return Promise.resolve();
    const agentName = typeof input.payload.agentName === 'string' ? input.payload.agentName : '';
    // user-scope saves carry an empty agentName and have no cleanup target.
    if (!agentName.trim())
        return Promise.resolve();
    return input.memoryFacade
        .triggerCleanup(agentName, false)
        .then((result) => {
        if (!result.spawned) {
            // Below-threshold / not-spawned is the common path (memory.saved fires on
            // every write); emit it anyway so "why didn't cleanup run" is answerable
            // by event rather than by absence.
            input.emitBusEvent('memory.cleanup_skipped', { agentName, ...result });
            return;
        }
        input.emitBusEvent('memory.cleanup_snapshot', { agentName, ...result });
    })
        .catch((err) => {
        input.emitBusEvent('memory.cleanup_failed', {
            agentName,
            error: err instanceof Error ? err.message : String(err),
        });
    });
}
export async function recordMemorySessionFinish(input) {
    const payload = {
        sessionId: input.session.sessionId,
        agentName: input.session.agentName,
        turnId: input.turnId,
        status: input.status,
        ...(input.errorMessage ? { error: input.errorMessage } : {}),
        ...(typeof input.errorCode === 'number' ? { errorCode: input.errorCode } : {}),
        ...(input.errorSource ? { errorSource: input.errorSource } : {}),
        ...(input.errorDetail ? { errorDetail: input.errorDetail } : {}),
        ...(input.errorProviderId ? { errorProviderId: input.errorProviderId } : {}),
    };
    if (!isSessionTerminalStatus(input.status))
        return;
    const result = await recordMemorySessionTerminal({
        sessionId: input.session.sessionId,
        agentName: input.session.agentName,
        turnId: input.turnId,
        status: input.status,
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        nowMs: input.nowMs,
        memoryFacade: input.memoryFacade,
        emitBusEvent: input.emitBusEvent,
    });
    publishSessionTerminal(input.publishGlobalEvent, {
        ...payload,
        status: input.status,
        ...(result.date ? { date: result.date } : {}),
    });
}
/**
 * V2 接管后永久停用 V1 自动记忆写入，独立于当前的召回和整理开关。
 */
export function v1AutoMemoryWritesStopped(memory) {
    return isMemoryV2Enabled(memory);
}
/** Records terminal Memory bookkeeping without publishing Session lifecycle events. */
export async function recordMemorySessionTerminal(input) {
    try {
        const agentName = input.agentName;
        if (!agentName?.trim())
            throw new LocalMemoryError('AGENT_NAME_REQUIRED', 'session has no agentName');
        const date = formatLocalDate(input.nowMs());
        await input.memoryFacade.markSession(date, input.sessionId, agentName, false);
        return { date };
    }
    catch (err) {
        input.emitBusEvent('memory.session_finish_failed', {
            sessionId: input.sessionId,
            agentName: input.agentName,
            turnId: input.turnId,
            status: input.status,
            ...(input.errorMessage ? { error: input.errorMessage } : {}),
            error: err instanceof Error ? err.message : String(err),
        });
        return {};
    }
}
function isSessionTerminalStatus(status) {
    return (status === 'finished' || status === 'error' || status === 'aborted' || status === 'interrupted');
}
function publishSessionTerminal(publish, payload) {
    if (payload.status === 'finished') {
        publish({ type: 'session.finish', payload: { ...payload, status: payload.status } });
    }
    else if (payload.status === 'error') {
        publish({ type: 'session.error', payload: { ...payload, status: payload.status } });
    }
    else {
        publish({ type: 'session.abort', payload: { ...payload, status: payload.status } });
    }
}
//# sourceMappingURL=local-memory-orchestration.js.map