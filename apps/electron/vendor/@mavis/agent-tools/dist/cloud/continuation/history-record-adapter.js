export function persistedMessageToHistoryRecord(input) {
    return {
        messageId: input.message_id,
        turnId: input.turn_id,
        message: structuredClone(input.message),
        ...(input.turn_config ? { turnConfig: structuredClone(input.turn_config) } : {}),
    };
}
export function historyRecordToPersistedMessage(input) {
    return {
        message_id: input.messageId,
        turn_id: input.turnId,
        message: structuredClone(input.message),
        ...(input.turnConfig ? { turn_config: structuredClone(input.turnConfig) } : {}),
    };
}
export function persistedMessagesToHistoryRecords(input) {
    return input.map(persistedMessageToHistoryRecord);
}
export function historyRecordsToPersistedMessages(input) {
    return input.map(historyRecordToPersistedMessage);
}
//# sourceMappingURL=history-record-adapter.js.map