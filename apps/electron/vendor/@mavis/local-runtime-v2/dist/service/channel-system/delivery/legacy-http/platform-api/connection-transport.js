/**
 * Live receive-channel state of one Connection binding — the
 * `transport_status` / `transport_error_category` fields of `IMBindingInfo`
 * — for all three channels.
 *
 * A bound Connection only proves that bind succeeded at some point. Before
 * these fields existed the IM panel showed every bound bot as connected,
 * even when nothing could reach it: a Feishu long connection that never
 * completed a handshake (MCT-202609-IKWIYNVW), a WeChat login session that
 * expired, a Telegram token that was revoked. Each platform Api keeps a live
 * snapshot per binding, keyed by the binding's clientName:
 *   - Feishu: `statusClients()` (`wsStatus` / `wsLastErrorCategory`),
 *     projected by `feishu-connection-transport.ts`;
 *   - WeChat / Telegram: `transportClients()` (`status` / `errorCategory`),
 *     projected by {@link polledBindingTransport} below.
 * This module owns what every channel shares: the status values, the agreed
 * category list and the warn line for an abnormal snapshot.
 *
 * Only a fixed status value and a fixed failure category leave this module —
 * never raw error text, URLs, tokens, appIds or other snapshot fields.
 */
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/** `transport_status` values; `satisfies` pins them to both live-state producers. */
const TRANSPORT_STATUSES = new Set([
    'idle',
    'connecting',
    'connected',
    'error',
]);
/**
 * `transport_error_category` values listed on `IMBindingInfo` in weaver/idl
 * `matrix/api_common/channel.thrift`: the connection-failure subset of the
 * Feishu SDK log classifier, plus three values only the polled channels
 * produce. `satisfies` pins each part to its producer's type, so renaming a
 * category there breaks the build here instead of silently degrading it to
 * `unknown`.
 */
const TRANSPORT_ERROR_CATEGORIES = new Set([
    ...[
        'endpoint_rejected',
        'endpoint_response_invalid',
        'endpoint_request_failed',
        'network_error',
        'network_timeout',
        'http_error',
        'ws_construct_failed',
        'ws_handshake_failed',
        'connect_failed',
        'reconnect_failed',
        'ws_runtime_error',
        'credential_missing',
        'unknown',
    ],
    ...[
        'session_expired',
        'token_invalid',
        'poll_conflict',
    ],
]);
/** Status values are internal enums; anything else is logged by type only. */
const STATUS_TOKEN = /^[a-z][a-z_]{0,31}$/;
/**
 * The snapshot entry of `binding`, or `undefined` when there is no snapshot
 * (skipped or failed — the caller already warned), no entry for this
 * binding, or an entry that is not an object (warned here).
 */
export function readTransportEntry(log, connectionId, binding, clients) {
    if (!clients || !Object.hasOwn(clients, binding.clientName))
        return undefined;
    const entry = clients[binding.clientName];
    if (isRecord(entry))
        return entry;
    warnNotReported(log, connectionId, binding, 'entry_invalid', { entryType: describeType(entry) });
    return undefined;
}
/**
 * Project the status + category of one entry whose binding reports live
 * state. A missing or unrecognized status is warned and reported as nothing.
 */
export function projectTransportEntry(log, connectionId, binding, status, category) {
    if (typeof status !== 'string' || !TRANSPORT_STATUSES.has(status)) {
        // A reporting binding must carry one of the four live statuses.
        // `undefined` means the adapter's status provider failed (the platform
        // Api swallows that) — exactly when the panel would fall back to showing
        // "connected" — so every occurrence is worth a warn.
        warnNotReported(log, connectionId, binding, status === undefined ? 'status_missing' : 'status_unrecognized', describeStatusValue(status));
        return {};
    }
    return {
        transportStatus: status,
        ...(category !== undefined
            ? { transportErrorCategory: toTransportErrorCategory(category) }
            : {}),
    };
}
const POLLED_TRANSPORT_LOGS = {
    telegram: {
        operation: 'telegram_binding_transport',
        message: 'Telegram Connection transport status not reported',
    },
    wechat: {
        operation: 'wechat_binding_transport',
        message: 'WeChat Connection transport status not reported',
    },
};
/**
 * Transport fields for one WeChat / Telegram Connection binding, spread into
 * its `IMBindingInfo`; empty for other channels and for bindings that do
 * not report live state.
 */
export function polledBindingTransport(connectionId, binding, snapshots) {
    if (binding.channel !== 'telegram' && binding.channel !== 'wechat')
        return {};
    // The platform Api lists only bindings whose receive channel should be
    // running right now (see `collectTransportClients`): no entry leaves both
    // fields unset so the panel keeps its existing display — a disabled
    // family shadow, a non-polling mode, an unwired channel or a quarantined
    // startup must not be flagged as broken. These are steady states repeated
    // on every (polled) list request, so they are deliberately not logged; the
    // transport logs each real status change itself
    // (`<Platform> transport status transition`).
    const log = POLLED_TRANSPORT_LOGS[binding.channel];
    const entry = readTransportEntry(log, connectionId, binding, snapshots[binding.channel]);
    if (!entry)
        return {};
    return projectTransportEntry(log, connectionId, binding, entry.status, entry.errorCategory);
}
/**
 * One polled platform Api's `transportClients()`: the provider's live state
 * for every record whose receive channel should be running
 * (`runsReceiveChannel`, the same gate the restore / winner start applies),
 * keyed by clientId. A record the provider does not report for — unwired
 * channel, quarantined startup — stays absent.
 */
export function collectTransportClients(records, runsReceiveChannel, provider) {
    const clients = {};
    if (!provider)
        return clients;
    for (const record of records) {
        if (!runsReceiveChannel(record))
            continue;
        const transport = provider(record.agentName);
        if (transport)
            clients[record.clientId] = transport;
    }
    return clients;
}
/**
 * The IDL's forward-compatible degrade: a category outside the agreed list
 * (e.g. a classifier grew) is reported as `unknown`. Not logged — the raw
 * category is already on the transport's own status-transition line
 * (`errorCategory`), and a held `error` status is re-read on every poll.
 */
function toTransportErrorCategory(value) {
    return typeof value === 'string' && TRANSPORT_ERROR_CATEGORIES.has(value) ? value : 'unknown';
}
function warnNotReported(log, connectionId, binding, reason, detail) {
    // Opaque ids only: the clientName is the agent name and snapshot entries
    // may carry an appId, a masked token or raw error text.
    logger.warn({
        operation: log.operation,
        connectionId,
        bindingId: binding.bindingId,
        reason,
        ...detail,
    }, log.message);
}
function describeStatusValue(value) {
    if (value === undefined)
        return {};
    return typeof value === 'string' && STATUS_TOKEN.test(value)
        ? { status: value }
        : { statusType: describeType(value) };
}
function describeType(value) {
    if (value === null)
        return 'null';
    return Array.isArray(value) ? 'array' : typeof value;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=connection-transport.js.map