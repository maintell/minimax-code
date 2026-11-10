/**
 * T4b — host-neutral RC audit redaction helpers.
 *
 * Redaction hard rules (plan §10, gateway self-routing §4.8.3):
 *   - ticket / user JWT / raw desktop_device_id NEVER hit the log file;
 *     only sha256 tail-6 hashes or the binding_id may be recorded.
 *   - WS URLs must be passed through redactWsUrl() before logging.
 * The helpers below are the only sanctioned way to reference those values
 * in log lines.
 */
import { createHash } from 'node:crypto';
/** sha256 hex tail (6 chars) — correlate without disclosing the value. */
export function hashTail6(value) {
    return createHash('sha256').update(value).digest('hex').slice(-6);
}
/** Safe representation of the raw desktop_device_id for log lines. */
export function deviceIdForLog(deviceId) {
    return `sha…${hashTail6(deviceId)}`;
}
/**
 * Redact credential query params in a WS URL. Keeps endpoint + binding_id
 * (route key, non-secret) and replaces ticket with its hash tail.
 */
export function redactWsUrl(url) {
    try {
        const u = new URL(url);
        const ticket = u.searchParams.get('ticket');
        if (ticket)
            u.searchParams.set('ticket', `sha…${hashTail6(ticket)}`);
        return u.toString();
    }
    catch {
        // Never let a malformed URL leak through un-redacted.
        return '<unparseable-ws-url>';
    }
}
/** Log-safe one-liner for a GET /desktop/bindings result (no ticket material). */
export function describeBindingForLog(info) {
    const parts = [`state=${info.state ?? 'unknown'}`];
    if (info.binding_id !== undefined)
        parts.push(`binding_id=${info.binding_id}`);
    if (info.endpoint)
        parts.push(`endpoint=${info.endpoint}`);
    if (info.ticket)
        parts.push(`ticket=sha…${hashTail6(info.ticket)}`);
    if (info.expires_at_ms !== undefined)
        parts.push(`expires_at_ms=${info.expires_at_ms}`);
    return parts.join(' ');
}
//# sourceMappingURL=audit-redaction.js.map