import { isLocalChildWorkerSession } from '../sessions/session-policy.js';
export function shouldEnableLocalTaskTool(session) {
    return !isLocalChildWorkerSession(session);
}
//# sourceMappingURL=local-task-tool-policy.js.map