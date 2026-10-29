/** Hidden canonical control record, separate from the inherited-context boundary. */
export function createSideChatModeMessage(timestamp) {
    return {
        role: 'custom',
        customType: 'sidechat_mode',
        display: false,
        content: '<system-reminder>You are in a SideChat. Prefer answering and discussing with minimal file changes. When the user explicitly asks for changes or tool use, follow the current session permissions and normal tool and subagent behavior.</system-reminder>',
        timestamp,
    };
}
export function isSideChatModeMessage(message) {
    return (typeof message === 'object' &&
        message !== null &&
        Reflect.get(message, 'role') === 'custom' &&
        Reflect.get(message, 'customType') === 'sidechat_mode' &&
        Reflect.get(message, 'display') === false);
}
//# sourceMappingURL=sidechat-mode.js.map