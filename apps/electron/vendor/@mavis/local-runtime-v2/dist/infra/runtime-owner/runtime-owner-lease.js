const LEASE_SCHEMA_VERSION = 1;
/**
 * Writes the lease as a bare PID line followed by a JSON record.
 *
 * The duplicated PID line is deliberate: ADR-005 requires the previous release to stay
 * launchable, and that binary reads the lease with `parseInt`. Keeping the PID on the
 * first line means a rolled-back Runtime still sees the exact owner PID instead of
 * falling back to the lock heartbeat alone, while a current Runtime additionally gets the
 * start token it needs to reject a reused PID.
 */
export function serializeRuntimeOwnerLease(input) {
    const record = {
        schemaVersion: LEASE_SCHEMA_VERSION,
        pid: input.pid,
        ...(input.startToken === undefined ? {} : { startToken: input.startToken }),
    };
    return `${String(input.pid)}\n${JSON.stringify(record)}\n`;
}
/**
 * Decodes lease text without ever making a parse failure fatal.
 *
 * The first line is authoritative for identity, so any missing, malformed or
 * disagreeing JSON record degrades to `legacy` — the fence then behaves exactly as it did
 * before start tokens existed instead of turning a corrupt file into a permanent refusal
 * to start.
 */
export function parseRuntimeOwnerLease(text) {
    if (text === undefined)
        return { format: 'absent' };
    const [head = '', ...rest] = text.split('\n');
    const pid = Number.parseInt(head.trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return { format: 'unreadable' };
    const record = decodeLeaseRecord(rest.join('\n').trim(), pid);
    if (record.startToken !== undefined) {
        return { format: 'structured', pid, startToken: record.startToken };
    }
    return {
        format: 'legacy',
        pid,
        ...(record.issue === undefined ? {} : { recordIssue: record.issue }),
    };
}
function decodeLeaseRecord(payload, pid) {
    // A lease written before start tokens existed has no record line at all; that is the
    // supported legacy shape rather than a problem worth reporting.
    if (payload.length === 0)
        return {};
    const fields = parseLeaseRecordFields(payload);
    if (typeof fields === 'string')
        return { issue: fields };
    if (fields.schemaVersion !== LEASE_SCHEMA_VERSION)
        return { issue: 'unsupported-schema-version' };
    if (fields.pid !== pid)
        return { issue: 'pid-mismatch' };
    return decodeStartToken(fields.startToken);
}
/** Returns the record fields, or the issue code explaining why there are none. */
function parseLeaseRecordFields(payload) {
    let record;
    try {
        record = JSON.parse(payload);
    }
    catch {
        return 'invalid-json';
    }
    if (!record || typeof record !== 'object' || Array.isArray(record))
        return 'invalid-record';
    return record;
}
function decodeStartToken(startToken) {
    // A record without a token means the writer's platform had no probe: a normal degrade.
    if (startToken === undefined)
        return {};
    if (typeof startToken !== 'string' || startToken.length === 0) {
        return { issue: 'invalid-start-token' };
    }
    return { startToken };
}
//# sourceMappingURL=runtime-owner-lease.js.map