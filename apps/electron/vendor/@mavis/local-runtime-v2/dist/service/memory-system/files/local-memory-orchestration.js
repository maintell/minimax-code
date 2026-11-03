import { isMemoryV2Enabled } from '@mavis/config';
import { formatLocalDate } from './local-memory-store-utils.js';
import { LocalMemoryError } from './types.js';
export async function handleMemoryBusEvent(input) {
    if (input.type !== 'memory.saved')
        return Promise.resolve();
    const agentName = typeof input.payload.agentName === 'string' ? input.payload.agentName : '';
    // user-scope saves carry an empty agentName and have no cleanup target.
    if (!agentName.trim())
        return Promise.resolve();
    try {
        const result = await input.memoryFacade.triggerCleanup(agentName, false);
        if (!result.spawned) {
            // Emit the common below-threshold path so skipped cleanup remains observable.
            input.emitBusEvent('memory.cleanup_skipped', { agentName, ...result });
            return;
        }
        input.emitBusEvent('memory.cleanup_snapshot', { agentName, ...result });
    }
    catch (err) {
        input.emitBusEvent('memory.cleanup_failed', {
            agentName,
            error: err instanceof Error ? err.message : String(err),
        });
    }
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
//# sourceMappingURL=local-memory-orchestration.js.map