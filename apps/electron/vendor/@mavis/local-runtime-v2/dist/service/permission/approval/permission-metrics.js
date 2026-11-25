/**
 * Permission metrics — emission helpers for the permission decision and
 * approval flow.
 *
 * Bare metric names; the server-side pipeline owns the `local_runtime_`
 * prefix. Every helper is a noop when `metrics` is undefined (injection is
 * optional, zero behavior change). Labels are bounded enums only — never
 * sessionId/userId, commands, paths or free-form reasons.
 */
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '@mavis/permission';
import {} from '@mavis/shared/local-runtime-logging/metric-registry';
import { incrementMetric } from '../../../infra/logging/metrics.js';
const WEB_TOOLS = new Set(['web_fetch', 'web_search']);
function permissionToolKind(toolName) {
    if (toolName === 'bash')
        return 'bash';
    if (READ_ONLY_TOOLS.has(toolName))
        return 'fs_read';
    // apply_patch has no engine checker of its own but writes files all the same.
    if (WRITE_TOOLS.has(toolName) || toolName === 'apply_patch')
        return 'fs_write';
    if (WEB_TOOLS.has(toolName))
        return 'web';
    return toolName.startsWith('mcp__') ? 'mcp' : 'other';
}
function permissionPlatformLabel(platform) {
    return platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : 'other';
}
/** Registered label values are snake_case; the legacy ask-shown counter keeps the raw mode. */
const PERMISSION_MODE_LABELS = {
    default: 'default',
    acceptEdits: 'accept_edits',
    bypassPermissions: 'bypass_permissions',
    auto: 'auto',
    dontAsk: 'dont_ask',
    off: 'off',
};
/**
 * One final decision at the facade (and Mini App) exit: the denominator of
 * facade-decided asks. Cards the Turn gate raises without a facade decision
 * (side-session approval, plugin PreToolUse ask, unknown-owner downgrade) are
 * not counted here; read those from `permission_ask_shown_total` by sessionKind.
 */
export function emitPermissionCheckMetric(metrics, input) {
    incrementMetric(metrics, 'permission_check_total', 1, {
        mode: PERMISSION_MODE_LABELS[input.mode],
        result: input.result,
        source: input.source,
        tool_kind: permissionToolKind(input.toolName),
        platform: permissionPlatformLabel(input.platform),
    });
}
/** Deterministic allow, labelled by the bounded fast-path kind the facade derives. */
export function emitFastAllowMetric(metrics, kind, platform) {
    incrementMetric(metrics, 'permission_fast_allow_total', 1, {
        kind,
        platform: permissionPlatformLabel(platform),
    });
}
/** Effective profile permission-mode change; unchanged writes do not emit. */
export function emitPermissionModeChangeMetric(metrics, from, to) {
    if (from === to)
        return;
    incrementMetric(metrics, 'permission_mode_change_total', 1, {
        from: PERMISSION_MODE_LABELS[from],
        to: PERMISSION_MODE_LABELS[to],
    });
}
/**
 * `verdict` = CloudClassifyVerdict.kind or 'error' for an unexpected throw.
 * `reason` = 'none' for a real verdict, otherwise a bounded failure reason.
 */
export function emitLlmCheckMetric(metrics, verdict, reason, startedAtMs) {
    if (!metrics)
        return;
    metrics.histogram('permission_llm_check_duration_ms', Date.now() - startedAtMs);
    metrics.counter('permission_llm_check_total', 1, { verdict, reason });
}
const SESSION_KIND_LABELS = ['conversation', 'task', 'peek', 'channel', 'cron'];
/** Session kinds outside the known set, or an unresolved lookup, report `unknown`. */
function sessionKindLabel(sessionKind) {
    return SESSION_KIND_LABELS.find((known) => known === sessionKind) ?? 'unknown';
}
/** Upper bounds (exclusive) of the wait ranges; anything longer is `gt_4h`. */
const ASK_WAIT_RANGES = [
    [60_000, 'lt_1m'],
    [300_000, '1m_5m'],
    [900_000, '5m_15m'],
    [3_600_000, '15m_1h'],
    [14_400_000, '1h_4h'],
];
function askWaitRange(waitMs) {
    return ASK_WAIT_RANGES.find(([limit]) => waitMs < limit)?.[1] ?? 'gt_4h';
}
/** New ask card announced (fingerprint-deduped asks do not re-emit). */
export function emitAskShownMetric(metrics, input) {
    metrics?.counter('permission_ask_shown_total', 1, {
        mode: input.mode,
        tool_kind: permissionToolKind(input.toolName),
        platform: permissionPlatformLabel(process.platform),
        sessionKind: sessionKindLabel(input.sessionKind),
    });
}
/** Reply settle at the shared UI + IM choke point. */
export function emitAskReplyMetric(metrics, decision, sessionKind) {
    metrics?.counter('permission_ask_reply_total', 1, {
        clkType: { allowOnce: 'allow_session', allowAlways: 'allow_global', deny: 'deny' }[decision],
        sessionKind: sessionKindLabel(sessionKind),
    });
}
/**
 * Shown → settle wait duration. `replied` = an explicit UI/IM decision;
 * `abandoned` = dismissed card, session abort, or turn-signal abort. Histograms
 * reach the store without appVersion, so a range counter carries the long tail
 * per release.
 */
export function emitAskWaitMetric(metrics, input) {
    if (!metrics)
        return;
    const sessionKind = sessionKindLabel(input.sessionKind);
    metrics.histogram('permission_ask_wait_ms', input.waitMs, {
        outcome: input.outcome,
        tool_kind: permissionToolKind(input.toolName),
        platform: permissionPlatformLabel(process.platform),
        sessionKind,
    });
    incrementMetric(metrics, 'permission_ask_wait_range_total', 1, {
        outcome: input.outcome,
        range: askWaitRange(input.waitMs),
        sessionKind,
    });
}
//# sourceMappingURL=permission-metrics.js.map