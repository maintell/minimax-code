export function requireTaskConversation(host) {
    if (!host.runtimeConversation) {
        throw new Error('Local task execution requires the Session V2 RuntimeConversation');
    }
    return host.runtimeConversation;
}
//# sourceMappingURL=local-task-host.js.map