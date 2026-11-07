import { report, writeLog } from '../ptc/ptc-observability.js';
import { comparePtcPrefix, fingerprintPtcPrefix, } from './ptc-prefix-fingerprint.js';
/**
 * Turn sources reported as is (`provenance.source`, an internal enum). Anything
 * else reports `other`, so a label never carries an unexpected value.
 */
const REPORTED_SOURCES = new Set([
    'api',
    'cron',
    'task',
    'background-task',
    'team',
    'thread-goal',
    'questionnaire',
    'communication',
    'code_review',
    'greeting',
    'channel:wechat',
    'channel:feishu',
    'channel:telegram',
    'miniapp',
    /** Explicit Continue of an interrupted Turn. */
    'turn-continuation',
    /** Edit-and-resend of an earlier message. */
    'conversation-mutation',
]);
const REPORTED_SESSION_KINDS = new Set([
    'conversation',
    'task',
    'peek',
    'channel',
    'cron',
    'unknown',
]);
/**
 * One `ptc admission` line and one `ptc_turn_total` count per Turn of a Session in PTC mode
 * (`toolCallMode: 'ptc'`, carried as agentConfig.ptc_enabled), with the source and Session kind
 * of the Turn and the fingerprint of the prefix it sends. Without them, "PTC did not kick in"
 * and "the prefix changed" cannot be told apart from an ordinary Turn, and the share of beta
 * Turns that really run PTC is unknown. Turns of native-mode Sessions report nothing.
 */
export function observePtcAdmission(input, admitted, options, prefix) {
    let facts;
    try {
        if (input.assemblyContext.agentConfig.ptc_enabled !== true)
            return;
        facts = {
            reason: admitted ? 'enabled' : 'other',
            surface: options.ptcSurface ?? 'other',
            source: reportedSource(input),
            sessionKind: reportedSessionKind(input),
        };
    }
    catch {
        // Diagnostics must not affect the Turn.
        return;
    }
    const { reason, surface, source, sessionKind } = facts;
    // The fingerprint only adds hashes: when it fails, the line and the count
    // still go out, without the hashes and without a prefix comparison.
    const fingerprint = tryFingerprint(prefix);
    writeLog(options.logger, 'ptc admission', {
        session_id: input.lease.sessionId,
        turn_id: input.lease.turnId,
        admitted,
        reason,
        surface,
        source,
        session_kind: sessionKind,
        ...fingerprint,
    });
    report(() => options.metricsClient?.counter('ptc_turn_total', 1, {
        admitted: String(admitted),
        reason,
        surface,
        source,
        session_kind: sessionKind,
    }));
    if (!fingerprint)
        return;
    try {
        comparePtcPrefix({ sessionId: input.lease.sessionId, turnId: input.lease.turnId, source, fingerprint }, options.logger);
    }
    catch {
        // Diagnostics must not affect the Turn.
    }
}
function tryFingerprint(prefix) {
    try {
        return fingerprintPtcPrefix(prefix);
    }
    catch {
        return undefined;
    }
}
function reportedSource(input) {
    // Direct test seams may omit provenance.
    const provenance = input.request.provenance;
    const source = provenance?.source;
    return typeof source === 'string' && REPORTED_SOURCES.has(source) ? source : 'other';
}
function reportedSessionKind(input) {
    const kind = input.session.sessionKind;
    return typeof kind === 'string' && REPORTED_SESSION_KINDS.has(kind) ? kind : 'unknown';
}
//# sourceMappingURL=ptc-admission-observability.js.map