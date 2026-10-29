export function isBackgroundTaskChildSession(session) {
    if (!session.parentSessionId)
        return false;
    if (session.sessionKind === 'task')
        return true;
    return (session.sessionType === 'branch' &&
        session.visibility === 'hidden' &&
        (session.sessionKind === undefined ||
            ['local-task:', 'local-background-task:', 'team-plan:'].some((prefix) => session.purpose?.trim().startsWith(prefix))));
}
export function requireBackgroundTaskConversation(host) {
    if (!host.runtimeConversation)
        throw new Error('Background tasks require the RuntimeConversation owner');
    return host.runtimeConversation;
}
export function backgroundTaskNotificationReceiptId(taskId) {
    return `background-task-notification:${taskId}`;
}
//# sourceMappingURL=background-task-runtime.js.map