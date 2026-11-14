import { composeOwnerSessionClio, } from '../../service/session-clio/index.js';
/** Session Clio capture, or nothing when the owner supplied no Session Clio inputs. */
export function composeRuntimeSessionClio(input) {
    return composeOwnerSessionClio(input.clio, {
        db: input.db,
        messages: input.messages,
        nowMs: input.nowMs,
        ...(input.reportFailure ? { reportFailure: input.reportFailure } : {}),
        ...(input.overrides ? { overrides: input.overrides } : {}),
    });
}
//# sourceMappingURL=runtime-session-clio.js.map