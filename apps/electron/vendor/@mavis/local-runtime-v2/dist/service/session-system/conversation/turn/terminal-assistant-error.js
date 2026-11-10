export function isTerminalAssistantPiError(message) {
    const record = message;
    return record.role === 'assistant' && record.stopReason === 'error';
}
//# sourceMappingURL=terminal-assistant-error.js.map