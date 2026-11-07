/**
 * Reads the tool-call identity from the Host context. The identity never
 * comes from the tool input, and an unusable identity is a hard error.
 */
export function readPermissionToolRequest(context, snapshotInput) {
    const toolInput = readRecord(context.args);
    const request = {
        toolCallId: readToolCallField(context.toolCall, 'id'),
        toolName: readToolCallField(context.toolCall, 'name'),
        toolSource: readToolCallField(context.toolCall, 'source'),
        toolInput: snapshotInput ? snapshotInput(toolInput) : Object.freeze({ ...toolInput }),
    };
    if (typeof request.toolCallId !== 'string' ||
        !request.toolCallId ||
        typeof request.toolName !== 'string' ||
        !request.toolName) {
        throw new TypeError('Permission tool-call identity must contain a non-empty id and name.');
    }
    return request;
}
function readToolCallField(toolCall, field) {
    if (!toolCall || typeof toolCall !== 'object')
        return '';
    const value = Reflect.get(toolCall, field);
    return typeof value === 'string' ? value : '';
}
function readRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
//# sourceMappingURL=permission-tool-request.js.map