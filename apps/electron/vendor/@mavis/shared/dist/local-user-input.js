/**
 * 本机当场输入的消息来源；undefined 是直接 API 消息的旧写法。runtime 和客户端共用
 * 这一条规则：被撤回的消息只有是用户在本机打的才放回输入框，来自 IM、定时任务、team
 * 或目标的都不放回。
 */
export function isLocallyOriginatedUserSource(source) {
    return (source === undefined ||
        source === 'api' ||
        source === 'code_review' ||
        source === 'cloud_session_handoff');
}
//# sourceMappingURL=local-user-input.js.map