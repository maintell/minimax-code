/**
 * Live Feishu long-connection state for one Connection binding — the
 * `transport_status` / `transport_error_category` fields of `IMBindingInfo`.
 *
 * A bound Connection only proves that bind succeeded at some point. Before
 * these fields existed, the IM panel showed every bound Feishu bot as
 * connected, even when its long connection had never completed a handshake
 * (MCT-202609-IKWIYNVW). The Feishu platform Api already keeps a live
 * snapshot per binding (`statusClients()`, keyed by the binding's
 * clientName); this module projects the safe part of one entry onto the wire.
 * The status values, the agreed category list and the warn line are shared
 * with WeChat / Telegram in `connection-transport.ts`.
 *
 * Only a fixed status value and a fixed failure category leave this module —
 * never the snapshot's raw `wsLastError` text, its appId or any secret.
 */
import { projectTransportEntry, readTransportEntry, } from './connection-transport.js';
const FEISHU_TRANSPORT_LOG = {
    operation: 'feishu_binding_transport',
    message: 'Feishu Connection transport status not reported',
};
/**
 * Transport fields for one Connection binding, spread into its
 * `IMBindingInfo`; empty when this binding does not report live state.
 * `clients` is the `statusClients()` snapshot of the current request —
 * undefined when it was skipped or failed (the caller already warned).
 * `wsTransportRuns` is the runtime half of the gate for the same request
 * (`LocalFeishuChannelApi.runsWsTransport`).
 */
export function feishuBindingTransport(connectionId, binding, clients, wsTransportRuns) {
    // Reported only for a Feishu binding whose long connection should be
    // running right now; every other case leaves both fields unset so the
    // panel keeps its existing display ("connected to X"). Reporting the
    // snapshot's `idle` there would flag a bot as broken, and the panel would
    // keep re-polling it. Not reported:
    //   - other channels: projected elsewhere (`polledBindingTransport`);
    //   - `!wsTransportRuns`: this process starts no long connection at all —
    //     a quarantined startup (`policy.startInboundLoops` in the restore
    //     pass, `quarantined` in the winner start) or the WS transport off
    //     (`feishuWsEnabled` in `startFeishuWs`, no WS client factory);
    //   - no snapshot / no entry: nothing live is known about this binding;
    //   - a record the restore pass (`visitFeishuRecord`) skips, checked on
    //     the entry fields `serializeFeishuBinding` writes: `enabled` (a
    //     staged family shadow — agents of one family share credentials and
    //     only the enabled one runs the long connection), `mode` (webhook
    //     bindings never open one; the snapshot reports them `idle` by
    //     design), `connected` and `hasCredentials` (appId + appSecret). The
    //     winner start (`startFeishuWinner`) checks the first three and gets
    //     the credential check from the adapter's own start.
    // No log for these: each is a steady state repeated on every (polled)
    // list request. Why a long connection did not start is logged once per
    // record where the decision is made — `Feishu WS restore skipped: ...`,
    // `Feishu WS start skipped: ...`, `Channel winner inbound not started` —
    // and the transport logs each real status change itself
    // (`Feishu WS status transition`).
    if (binding.channel !== 'feishu' || !wsTransportRuns)
        return {};
    const entry = readTransportEntry(FEISHU_TRANSPORT_LOG, connectionId, binding, clients);
    if (!entry || !wsShouldRun(entry))
        return {};
    return projectTransportEntry(FEISHU_TRANSPORT_LOG, connectionId, binding, entry.wsStatus, entry.wsLastErrorCategory);
}
/**
 * Record half of the gate: the restore pass's per-record start checks, read
 * from the snapshot entry. Strict `=== true` like the restore pass's
 * truthiness checks: an entry missing a flag is not known to run.
 */
function wsShouldRun(entry) {
    return (entry.enabled === true &&
        entry.mode === 'websocket' &&
        entry.connected === true &&
        entry.hasCredentials === true);
}
//# sourceMappingURL=feishu-connection-transport.js.map