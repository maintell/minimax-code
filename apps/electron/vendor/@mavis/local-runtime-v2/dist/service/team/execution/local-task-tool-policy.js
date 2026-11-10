import { isLocalChildWorkerSession } from '../../session-system/index.js';
export function shouldEnableLocalTaskTool(session) {
    return !isLocalChildWorkerSession(session);
}
//# sourceMappingURL=local-task-tool-policy.js.map