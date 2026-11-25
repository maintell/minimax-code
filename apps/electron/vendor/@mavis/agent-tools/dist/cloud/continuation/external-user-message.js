/**
 * Normal START records retain the first Archon wire id. Runtime-created
 * user-role records use `msg-*` ids and are not semantic share anchors.
 * Inherited continuation records follow the same rule: they keep the
 * Server-assigned recipient DB id when materialize supplied one
 * (`message_id_map`), otherwise they carry a runtime `msg-*` id.
 */
export function isExternalUserHistoryRecord(record) {
    if (record?.message.role !== 'user')
        return false;
    return !record.messageId.startsWith('msg-');
}
/** A share anchor additionally needs a one-to-one display-id mapping. */
export function isExternalUserShareAnchor(record) {
    return isExternalUserHistoryRecord(record);
}
//# sourceMappingURL=external-user-message.js.map