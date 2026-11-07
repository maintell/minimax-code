/**
 * Allowlist for `browser.*` observability events. Every field is an enum,
 * bounded number or boolean; URLs, hosts, titles, page content and raw tab or
 * session ids can never pass this boundary, whatever the emitter sends.
 */

const BACKENDS = new Set(['web-contents-view', 'webview']);
const SURFACE_KINDS = new Set(['browser', 'miniapp']);
const PRESENTATIONS = new Set(['panel', 'detached', 'background', 'hidden']);
const LAUNCH_SOURCES = new Set(['cached', 'remote', 'unavailable']);
const URL_SCHEMES = new Set(['http', 'https', 'file', 'about', 'data', 'blob', 'chrome', 'other']);
export let BROWSER_URL_SCHEMES = URL_SCHEMES;
const CRASH_REASONS = new Set([
    'abnormal-exit',
    'killed',
    'crashed',
    'oom',
    'launch-failed',
    'integrity-failure',
    'memory-eviction',
]);
const REBUILD_TRIGGERS = new Set(['detach', 'attach', 'host_reset', 'crash', 'on_demand']);
const REBUILD_RESULTS = new Set(['recovered', 'failed', 'busy', 'cancelled']);
const ATTACH_STAGES = new Set([
    'attach_timeout',
    'layout_timeout',
    'host_unavailable',
    'capacity',
    'cancelled',
    'rejected',
    'destroyed',
]);
const HOST_KINDS = new Set(['main', 'miniapp_window']);
const HOST_RESET_CAUSES = new Set(['navigation', 'crash']);
const LAYOUT_COMMANDS = new Set(['show', 'setBounds', 'hide']);
const TAB_OPEN_RESULTS = new Set(['loaded', 'failed', 'closed_before_load', 'create_failed']);
const SUMMARY_REASONS = new Set(['quit', 'idle', 'segment']);
const AGENT_ACTIONS = new Set([
    'navigate',
    'screenshot',
    'snapshot',
    'click',
    'type',
    'scroll',
    'evaluate',
    'other',
]);
export let BROWSER_AGENT_ACTIONS = AGENT_ACTIONS;
/** Fields every browser event may carry. */
const COMMON_ENUMS = {
    renderer_backend: BACKENDS,
    surface_kind: SURFACE_KINDS,
    presentation: PRESENTATIONS,
    launch_backend: BACKENDS,
    launch_source: LAUNCH_SOURCES,
};
const COMMON_NUMBERS = ['policy_revision', 'suppressed_count'];
const COMMON_BOOLEANS = ['pending_restart'];
const EVENT_SHAPES = {
    'browser.backend_launch': {
        enums: { backend: BACKENDS, latest_backend: BACKENDS },
        numbers: ['wait_ms'],
    },
    'browser.page_crash': {
        enums: { reason: CRASH_REASONS, url_scheme: URL_SCHEMES },
        numbers: ['exit_code', 'page_age_ms'],
        booleans: ['was_visible', 'agent_operation_active'],
    },
    'browser.page_unresponsive': {
        enums: { url_scheme: URL_SCHEMES },
        booleans: ['was_visible', 'agent_operation_active'],
    },
    'browser.page_recovered': { numbers: ['unresponsive_ms'] },
    'browser.guest_rebuild': {
        enums: { trigger: REBUILD_TRIGGERS, result: REBUILD_RESULTS },
        numbers: ['duration_ms', 'guest_generation'],
    },
    'browser.guest_attach_failed': { enums: { stage: ATTACH_STAGES, host_kind: HOST_KINDS } },
    'browser.host_reset': {
        enums: { cause: HOST_RESET_CAUSES, host_kind: HOST_KINDS },
        numbers: ['guest_count'],
    },
    'browser.load_failed': {
        enums: { url_scheme: URL_SCHEMES },
        numbers: ['error_code'],
        booleans: ['is_initial_load'],
    },
    'browser.layout_failed': { enums: { command: LAYOUT_COMMANDS }, numbers: ['attempts'] },
    'browser.tab_open': {
        enums: { result: TAB_OPEN_RESULTS, url_scheme: URL_SCHEMES },
        numbers: ['create_ms', 'attach_ms', 'cold_wait_ms', 'first_load_ms'],
        booleans: ['restored'],
    },
    'browser.session_summary': {
        enums: { summary_reason: SUMMARY_REASONS },
        numbers: [
            'duration_ms',
            'tabs_created',
            'tabs_max_concurrent',
            'guests_max',
            'suspend_count',
            'resume_count',
            'detach_count',
            'crash_count',
            'unresponsive_count',
            'unresponsive_total_ms',
            'rebuild_count',
            'rebuild_failed_count',
            'attach_failed_count',
            'load_failed_count',
            'layout_failed_count',
            'browser_rss_mb_p50',
            'browser_rss_mb_p95',
            'browser_rss_mb_max',
            'browser_cpu_pct_p50',
            'browser_cpu_pct_p95',
            'browser_cpu_pct_max',
            'main_rss_mb_max',
            'sample_count',
            'layout_roundtrip_ms_p50',
            'layout_roundtrip_ms_p95',
            'layout_command_count',
            'drag_count',
            'drag_lag_frames_p95',
            'drag_long_frames',
            'freeze_count',
            'native_menu_count',
            'parking_count',
            'resize_relay_count',
            'overlay_capture_count',
            'agent_op_count',
            'agent_op_failed',
            ...[...AGENT_ACTIONS].flatMap((action) => [
                `agent_${action}_count`,
                `agent_${action}_failed`,
                `agent_${action}_p50_ms`,
                `agent_${action}_p95_ms`,
                `agent_${action}_background_count`,
            ]),
        ],
    },
};
export let BROWSER_TELEMETRY_EVENT_NAMES = Object.keys(EVENT_SHAPES);
const MAX_NUMBER = 1e12;
function boundedEnum(value, allowed) {
    return typeof value === 'string' && allowed.has(value) ? value : 'other';
}
function boundedNumber(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return undefined;
    // Numbers keep their type so Guance aggregates them; clamp absurd values.
    return Math.max(-MAX_NUMBER, Math.min(MAX_NUMBER, Math.round(value * 100) / 100));
}
/** Sanitizes a browser event; unknown event names keep only common metadata. */
export function sanitizeBrowserTelemetryPayload(eventName, payload, common) {
    const sanitized = { ...common, domain: 'browser' };
    const shape = EVENT_SHAPES[eventName] ?? {};
    const enums = { ...COMMON_ENUMS, ...shape.enums };
    for (const [field, allowed] of Object.entries(enums)) {
        if (payload[field] !== undefined)
            sanitized[field] = boundedEnum(payload[field], allowed);
    }
    for (const field of [...COMMON_NUMBERS, ...(shape.numbers ?? [])]) {
        const value = boundedNumber(payload[field]);
        if (value !== undefined)
            sanitized[field] = value;
    }
    for (const field of [...COMMON_BOOLEANS, ...(shape.booleans ?? [])]) {
        if (typeof payload[field] === 'boolean')
            sanitized[field] = payload[field];
    }
    return sanitized;
}
