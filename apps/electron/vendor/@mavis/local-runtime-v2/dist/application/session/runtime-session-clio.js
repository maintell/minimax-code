import { buildLocalTrajectoryId, composeSessionClio, } from '../../service/session-clio/index.js';
/** Session Clio capture, or nothing when the owner supplied no Session Clio inputs. */
export function composeRuntimeSessionClio(input) {
    const { clio } = input;
    if (!clio)
        return undefined;
    return composeSessionClio({
        db: input.db,
        messages: input.messages,
        authContext: clio.authContext,
        gateway: clio.gateway,
        trajectoryId: clio.trajectoryId ?? buildLocalTrajectoryId,
        enabled: clio.enabled,
        nowMs: input.nowMs,
        ...(clio.bizId ? { bizId: clio.bizId } : {}),
        ...(clio.tickIntervalMs !== undefined ? { tickIntervalMs: clio.tickIntervalMs } : {}),
        ...(input.reportFailure ? { reportFailure: input.reportFailure } : {}),
        ...(input.overrides ? { overrides: input.overrides } : {}),
    });
}
//# sourceMappingURL=runtime-session-clio.js.map