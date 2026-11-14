import { RuntimeEventStatus, RuntimeEventType } from '@mavis/agent-core/protocol';
import { SessionStatusView } from '@mavis/thrift-gen/generated/desktop-service/types';
export function observeEvent(event, outcome) {
    // ConversationApplication emits SessionStreamFrameView, including v2 session_status frames.
    const status = event.type === 'session_status'
        ? event.session_status?.type
        : (event.payload?.status ?? event.status);
    const wasWaiting = outcome.waiting;
    // Legacy SSE agent_message frames also use type 2; only Runtime events carry payload.
    if ((event.type === RuntimeEventType.ACTION_REQUIRED && event.payload !== undefined) ||
        [RuntimeEventStatus.WAITING_ACTION, 'waiting_action'].includes(status))
        outcome.waiting = true;
    if ([RuntimeEventStatus.RUNNING, 'running', 'started'].includes(status))
        outcome.waiting = false;
    if ([RuntimeEventStatus.COMPLETED, 'completed', 'finished'].includes(status))
        outcome.completed = true;
    if ([RuntimeEventStatus.FAILED, 'failed', 'error'].includes(status))
        outcome.failed = true;
    if ([RuntimeEventStatus.ABORTED, 'aborted', 'interrupted'].includes(status))
        outcome.aborted = true;
    return wasWaiting !== outcome.waiting;
}
export function buildStatus(installed, outcome) {
    if (outcome.failed)
        return 'failed';
    if (outcome.aborted)
        return 'interrupted';
    if (outcome.waiting)
        return 'waiting';
    if (installed && outcome.completed)
        return 'ready';
    if (outcome.completed)
        return 'waiting';
    return 'interrupted';
}
export function stoppedCreationStatus(status) {
    if (status === SessionStatusView.Error)
        return 'failed';
    if (status === SessionStatusView.Abort)
        return 'interrupted';
    return undefined;
}
//# sourceMappingURL=miniapp-creation-status.js.map