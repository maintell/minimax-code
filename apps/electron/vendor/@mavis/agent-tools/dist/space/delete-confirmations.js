/** Delete confirmations: one-time tokens bound to a session and a node, kept in memory. */
export const SPACE_DELETE_CONFIRM_TTL_MS = 30 * 60_000;
export class SpaceDeleteConfirmations {
    records = new Map();
    issue(token, record, now) {
        for (const [key, value] of this.records) {
            if (value.expires_at <= now)
                this.records.delete(key);
        }
        this.records.set(token, record);
    }
    /** Returns the record once; unknown, expired or another session's token yields undefined. */
    consume(token, sessionId, now) {
        const record = this.records.get(token);
        if (!record || record.sessionId !== sessionId)
            return undefined;
        this.records.delete(token);
        return record.expires_at > now ? record : undefined;
    }
}
/**
 * Process-wide store. Tool registries are rebuilt per turn, so tokens must outlive one
 * registry; a restarted process loses them and the agent previews again (CONFIRM_INVALID).
 */
export const sharedSpaceDeleteConfirmations = new SpaceDeleteConfirmations();
//# sourceMappingURL=delete-confirmations.js.map