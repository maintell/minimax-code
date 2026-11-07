export const LOCAL_SESSION_LEDGER_SCHEMA_VERSION = 1;
export function isLocalSessionLedgerEvent(value) {
    if (!value || typeof value !== 'object')
        return false;
    const event = value;
    return (event.schemaVersion === LOCAL_SESSION_LEDGER_SCHEMA_VERSION &&
        typeof event.eventId === 'string' &&
        typeof event.sessionId === 'string' &&
        Number.isInteger(event.seq) &&
        typeof event.createdAtMs === 'number' &&
        typeof event.kind === 'string');
}
//# sourceMappingURL=ledger-event.js.map