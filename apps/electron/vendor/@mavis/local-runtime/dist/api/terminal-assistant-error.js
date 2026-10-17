import { Role } from '@mavis/agent-core/protocol/agent-message';
export function isTerminalAssistantDisplayError(message) {
    return message.role === Role.Assistant && readFinishReason(message) === 'error';
}
export function isTerminalAssistantPiError(message) {
    const record = message;
    return record.role === 'assistant' && record.stopReason === 'error';
}
function readStringField(value, key) {
    const field = value[key];
    return typeof field === 'string' ? field : undefined;
}
function readFinishReason(message) {
    return readStringField(message, 'finish_reason') ?? readStringField(message, 'finishReason');
}
//# sourceMappingURL=terminal-assistant-error.js.map