import { settleInBackground } from '../../../service/plugin-system/index.js';
import { formatUnknownError } from '../host-support.js';
/**
 * 阻塞依赖（如后台任务）释放后重新驱动 Session 队列。派发按电平触发：重新检查
 * 所有门禁，空队列是 no-op，并发唤醒由派发器合并；失败只上报，不影响任务终态。
 */
export function wakeSessionQueueAfterDependencyRelease(input) {
    if (!input.conversation)
        return;
    settleInBackground(dispatchSessionQueue(input.conversation, input));
}
async function dispatchSessionQueue(conversation, input) {
    try {
        await conversation.ingress.dispatchQueue(input.sessionId);
    }
    catch (error) {
        input.reportFailure(input.sessionId, `thread_goal_dependency_wake_failed:${formatUnknownError(error)}`);
    }
}
//# sourceMappingURL=host-background-tasks.js.map