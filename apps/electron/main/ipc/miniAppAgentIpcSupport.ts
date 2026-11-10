import { isMiniAppAgentFailureCode, toMiniAppAgentFailureCode } from "@mavis/shared/miniapp-surface";
import { getCategoryLogger } from "../utils/logger";
export const failure = (code, reason) => ({ ok: false, code, ...(code === 'busy' && reason ? { reason } : {}) });

export function captureTabCaller(manager, event) {
    const source = manager.captureMiniAppComposerSource(event.sender, event.senderFrame);
    if (!source)
        return null;
    return {
        pluginId: source.pluginId,
        runId: source.runId,
        ...(source.sessionId ? { hostSessionId: source.sessionId } : {}),
    };
}
/**
 * Recognised codes are expected outcomes. Anything else (a Main or broker bug, a lost port) is
 * still reported as `result_unknown`, since the request may have applied, but is logged.
 */
export function toFailureCode(error, context) {
    if (error instanceof Error && error.name === 'AbortError')
        return 'cancelled';
    const code = error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    if (isMiniAppAgentFailureCode(code))
        return code;
    const mapped = toMiniAppAgentFailureCode(code);
    if (mapped)
        return mapped;
    getCategoryLogger('main').warn('miniapp_agent_unexpected_failure', {
        pluginId: context.pluginId,
        method: context.method,
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : undefined,
    });
    return 'result_unknown';
}
