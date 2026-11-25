import { LLM_ERROR_REASONS } from '../llm-error-classifier.js';
import { LOCAL_RESOURCE_ERROR_KINDS } from '../local-resource-errors.js';
import { METRICS_DROP_REASONS } from '../metrics-proxy.js';
import { LEGACY_METRIC_NAMES } from './legacy-metric-names.js';
/**
 * Metric registry for the local runtime and the Desktop app (registry as code).
 *
 * Every metric added or changed since the registry was introduced is defined
 * here exactly once: type, unit, help text, consumer, the label keys with the
 * closed set of values each label may take, and the standard bucket set of a
 * histogram. Report through {@link incrementMetric} and {@link observeMetric}:
 * an unregistered name, an unknown or missing label key, or an enumerated
 * label value that is not listed fails to compile. A label in `optionalLabels`
 * may be left out: the series without it carry no such key, never an empty
 * value. The untyped metric calls (`.counter()`, `.histogram()`, `.gauge()`,
 * `.incr()`, `.latency()`) may name only the metrics that predate the registry,
 * listed in `legacy-metric-names.ts`; they migrate here as their call sites
 * change. Lint (`scripts/lint/metric-registry-lint.cjs`) and the registry test
 * check every such call: its name is a listed literal, a const initialized with
 * one, or a parameter typed {@link AllowedMetricName}.
 *
 * Rules every entry follows (unit tests enforce them):
 * - Names are bare `<module>_<metric>_<unit>`; gateway-app prepends
 *   `local_runtime_` on ingest. Counters end in `_total`, after the unit when
 *   they accumulate one (`_ms_total`).
 * - A histogram uses one of {@link STANDARD_BUCKETS} unchanged, so it never has
 *   more than ten boundaries. Changing a definition or its buckets means a new
 *   name; keep the old one until the app versions that emit it retire. A
 *   metric that shipped before the registry keeps its shipped buckets through
 *   {@link legacyBuckets}; only the names frozen in the registry test may.
 * - Adding a label with bounded values keeps the name: sums over the labels
 *   the metric had stay the same, and gateway-app accepts one metric's series
 *   with different label keys (v0.2.51, !222). Changing what it measures or
 *   its buckets needs a new name.
 * - Label values are bounded enums, optional labels included. `model` and
 *   `provider` are the exceptions: clients report the raw value and
 *   gateway-app bounds it on ingest
 *   (`internal/metrics/label_values.go`: vendor groups for `model`; minimax,
 *   minimax_api, openai-codex and custom_provider for `provider`), so they are
 *   marked {@link INGEST_NORMALIZED} instead of enumerated.
 * - Histograms never declare `appVersion`; gateway-app drops it from them.
 *
 * The module is platform neutral (no Node.js APIs) so the renderer can share
 * the definitions.
 */
/** Standard histogram boundaries. Milliseconds unless noted. */
export const STANDARD_BUCKETS = {
    /** Gateway internals, preparation stages, safety first chunk, transport, UI render. */
    FAST: [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 10_000],
    /** First output and response-header waits. */
    TTFT: [500, 1_000, 1_500, 2_000, 3_000, 5_000, 8_000, 10_000, 30_000, 120_000],
    /** First visible output and first paint in the UI. */
    VISIBLE: [2_000, 3_000, 5_000, 8_000, 10_000, 15_000, 20_000, 30_000, 60_000, 120_000],
    /** Whole requests. */
    TOTAL: [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000],
    /**
     * A namespaced builtin tool call or a ui.request round trip: a local read
     * answers in milliseconds, an archive or a UI deadline runs into minutes.
     */
    TOOL_CALL: [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 120_000, 300_000],
    /** Item counts such as queue depth (items, not milliseconds). */
    COUNT: [0, 1, 2, 5, 10, 25, 50, 100, 250, 1_000],
    /** Age of the oldest queued item: one minute to seven days. */
    AGE: [
        60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
        259_200_000, 604_800_000,
    ],
};
/** Marks a label bounded by gateway-app on ingest instead of by this registry. */
export const INGEST_NORMALIZED = Object.freeze({ normalizedOnIngest: true });
/**
 * Keep the boundaries a histogram shipped with before the registry: changing
 * them would need a new name. Only the names frozen in the registry test may
 * use this; every new histogram picks a {@link StandardBucketSet}.
 */
export function legacyBuckets(bounds) {
    return Object.freeze({ legacy: Object.freeze([...bounds]) });
}
function enumValues(...lists) {
    return [...new Set(lists.flat())];
}
const SUPERVISOR_OS = ['darwin', 'win32', 'linux'];
/** `RunTurnCaller` plus the `unknown` fallback of turn metrics. */
const PI_CALLERS = [
    'chat',
    'cron',
    'channel_feishu',
    'team',
    'compact',
    'permission_llm',
    'unknown',
];
/**
 * `SafetyStage` in packages/harness/src/agent-host/safety/contracts.ts, in the
 * snake_case the registry requires: the harness stage vocabulary uses hyphens
 * and maps them onto these values at the emit site.
 */
const SAFETY_METRIC_STAGES = ['input', 'output', 'thinking', 'tool_args', 'tool_result'];
/** `ToolReviewStage`: the two stages the harness reviews around a tool call. */
const TOOL_REVIEW_METRIC_STAGES = ['tool_args', 'tool_result'];
/** `SafetyVerdict['kind']` in packages/harness/src/agent-host/safety/contracts.ts. */
const SAFETY_METRIC_VERDICTS = ['pass', 'block', 'regenerate', 'unavailable'];
/** The two Hosts that run harness content safety; `unknown` when a Host names none. */
const SAFETY_METRIC_HOSTS = ['cloud', 'desktop', 'unknown'];
/** `PtcChildFullOutputOutcome` in packages/agent-tools/src/core-tools/bash-tool.ts. */
const PTC_CHILD_FULL_OUTPUT_OUTCOMES = ['restored', 'over_limit', 'unavailable'];
/**
 * `ModelCallRoute` in packages/config/src/model-availability.ts, plus
 * `unknown` for calls whose host does not resolve one (title generation and
 * other helper calls). The cloud runtime reports none of the route labels: it
 * keeps the Pi metrics it shipped before the registry.
 */
export const MODEL_CALL_ROUTE_LABELS = [
    'managed_token_plan',
    'minimax_api_key',
    'custom_provider',
    'configured_provider',
    'unknown',
];
/** Copies `UtilityRuntimeRecoveryReasonCode` in apps/electron utility-runtime-observer.ts. */
const RUNTIME_RECOVERY_REASONS = [
    'process_exit',
    'init_failed',
    'bootstrap_timeout',
    'handshake_failed',
    'env_prepare_failed',
    'memory_pressure',
    'runtime_unresponsive',
    'oom',
    'network_service_lost',
    'crash_loop',
    'runtime_owner_conflict',
    'unknown',
];
/** Copies `TurnErrorSource` in agent-core pi-turn-runner/metrics.ts. */
const TURN_ERROR_SOURCES = [
    'llm',
    'before_llm_hook',
    'tool',
    'history',
    'event_bridge',
    'message_identity',
    'event_writer',
    'turn_end_hook',
    'runner',
    'unknown',
];
/** Copies `NonLLMTurnErrorKind` in agent-core pi-turn-runner/metrics.ts. */
const NON_LLM_TURN_ERROR_KINDS = [
    'hook_error',
    'persistence',
    'translation',
    'identity',
    'delivery',
    'runtime_error',
    'unknown',
];
const TURN_FAILURE_ERROR_KINDS = enumValues(LLM_ERROR_REASONS, NON_LLM_TURN_ERROR_KINDS, LOCAL_RESOURCE_ERROR_KINDS);
/** Copies `WorkspaceIndexingStage` in local-runtime-v2 workspace/indexing/scan/metrics.ts. */
const WORKSPACE_INDEXING_STAGES = [
    'scan',
    'archive',
    'prepare',
    'upload',
    'register',
    'remote_wait',
    'download',
    'install',
    'ready',
    'search',
];
const WORKSPACE_INDEXING_OS = ['darwin', 'linux', 'win32', 'other'];
const BOOLEAN_VALUES = ['true', 'false'];
/** Copies `LLMCallScope` in agent-core pi-turn-runner/llm-retry.ts (shipped values). */
const LLM_CALL_SCOPES = [
    'agent',
    'compaction',
    'title',
    'archive-title',
    'memory',
    'goal-evaluator',
    'miniapp-ideas',
    'handoff-recommendation',
    'handoff-summary',
    'ppt',
    'probe',
    'advisor',
    'extension',
];
/** `LLMCallErrorKind` in agent-core pi-turn-runner/llm-retry.ts. */
const LLM_CALL_ERROR_KINDS = enumValues(LLM_ERROR_REASONS, LOCAL_RESOURCE_ERROR_KINDS, [
    'none',
]);
/**
 * Long-tail latency boundaries the Pi request histograms and local-runtime-v2
 * host-metrics.ts shipped with before the registry: up to 5 minutes, so
 * multi-minute turns and compactions stay resolvable. New histograms use a
 * {@link StandardBucketSet}.
 */
export const LONG_TAIL_HISTOGRAM_BOUNDS = Object.freeze([
    100, 250, 500, 1_000, 2_500, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
]);
const LONG_TAIL_BUCKETS = legacyBuckets(LONG_TAIL_HISTOGRAM_BOUNDS);
/**
 * `agentKind` of the turns of Bunny: its own conversation (`bunny_main`) and
 * the tasks it assigned (`bunny_task`). Other turns carry no `agentKind`;
 * query them with `agentKind=""`.
 */
export const AGENT_KIND_LABELS = ['bunny_main', 'bunny_task'];
const AGENT_KIND_LABEL = { agentKind: AGENT_KIND_LABELS };
/**
 * `wake` of the turn-level first-output metrics: `user` when a person
 * started any input of the turn's starting batch in a client (a message from
 * the composer, the TUI, an ACP client or IM, a questionnaire answer, an
 * edited and resent message, a Mini App action, /review), otherwise
 * `system` (task reports, cron runs, finished background tasks, messages
 * from other sessions, Goal continuations, unknown producers).
 */
export const TURN_WAKE_LABELS = ['user', 'system'];
/**
 * `conversation` of the turn-level first-output metrics: `new` when the
 * session history before the turn's own input holds no user, assistant or
 * compaction summary message, otherwise `existing`. A continuation appends
 * no input, so its whole history counts. Hosts that do not say get `existing`.
 */
export const TURN_CONVERSATION_LABELS = ['new', 'existing'];
/** Copies the components of `PluginSystemMetrics.snapshot` in local-runtime-v2. */
const PLUGIN_SNAPSHOT_COMPONENTS = [
    'official_plugin',
    'local_plugin',
    'enabled_plugin',
    'app_provider',
    'skill',
    'mcp_server',
    'mcp_tool',
    'diagnostic',
];
/**
 * `PtcSurface` in local-runtime-v2
 * service/turn-system/agent-host/runner/ptc/ptc-observability.ts: the product
 * surface a PTC Turn runs on. `other` is the fallback of a host that names none.
 */
const PTC_SURFACES = ['desktop', 'tui', 'other'];
/** Who reads the PTC session-store metrics. */
const PTC_STORE_CONSUMER = 'PTC owners, for run_code store adoption watch and store investigations';
/** Who reads every Bunny metric. */
const BUNNY_CONSUMER = 'Grafana dashboard MiniMax Code · Bunny (uid minimax-code-bunny); Bunny owners for rollout watch and investigations';
/** Copies `BunnySteerOutcome` in local-runtime-v2 application/session/bunny-steer-timing.ts. */
const BUNNY_STEER_OUTCOMES = [
    'preempted',
    'merged',
    'waited',
    'preempt_failed',
    'handed_back',
    'turn_ended',
];
/** Copies `ContextCompactionPhase` in harness compaction/host-contracts.ts. */
const CONTEXT_COMPACTION_PHASES = ['initial', 'iteration', 'manual'];
/** Copies `SegmentCompactionTrigger` in local-runtime-v2 compaction/segment/trace.ts. */
const BUNNY_COMPACTION_TRIGGERS = [
    'soft_line',
    'tool_result_watermark',
    'hard_line',
    'mid_turn_hard_line',
    'manual',
    'model_switch',
    'provider_recovery',
];
/** Compaction outcomes Bunny's telemetry counts: the ends of an attempt, and a skip at the failure limit. */
const BUNNY_COMPACTION_OUTCOMES = [
    'committed',
    'failed',
    'voided',
    'merged',
    'delegated',
    'skipped',
];
/** Close states of a Bunny task; anything else is `other`. */
const BUNNY_TASK_CLOSE_STATES = ['completed', 'cancelled', 'taken_over', 'other'];
/**
 * `code` of `bunny_failure_total`: SQLite result codes (an extended code
 * counts as its primary one), file system codes and the error classes Bunny's
 * failures carry, as lower snake_case. Anything else is `other`; the raw code
 * stays in the warn log.
 */
export const BUNNY_FAILURE_CODES = [
    'sqlite_busy',
    'sqlite_locked',
    'sqlite_corrupt',
    'sqlite_notadb',
    'sqlite_full',
    'sqlite_ioerr',
    'sqlite_cantopen',
    'sqlite_readonly',
    'sqlite_constraint',
    'enoent',
    'eacces',
    'eperm',
    'enospc',
    'emfile',
    'enfile',
    'ebusy',
    'eexist',
    'eisdir',
    'enotdir',
    'erofs',
    'eio',
    'type_error',
    'range_error',
    'syntax_error',
    'abort_error',
    'bunny_memory_format_error',
    'bunny_memory_state_error',
    'conversation_search_scope_error',
    'other',
];
/**
 * `event` of `bunny_trace_overhead_ms`: every event Bunny reports through its
 * trace sink, without the `bunny.` or `bunny_` prefix. Anything else is `other`.
 */
export const BUNNY_TRACE_EVENTS = [
    'state_injected',
    'turn_ended',
    'steer_precheck',
    'compaction',
    'segment',
    'idle',
    'emergency',
    'context_reset',
    'context_config',
    'round_budget_turn_summary',
    'other',
];
/** Copies `EmergencyFailureCategory` in local-runtime-v2 compaction/segment/ports.ts. */
const BUNNY_EMERGENCY_CATEGORIES = [
    'context_overflow',
    'request_too_large',
    'image_limit',
    'safety',
    'bad_request',
    'server_error',
    'incomplete_stream',
    'empty_response',
    'unknown',
    'host_internal',
    'output_limit_exhausted',
    'history_corrupted',
    'builtin_config_corrupted',
    'optional_injection',
];
/** Copies `SidebarSectionsImportStatus` in local-runtime-v2 service/sidebar-sections/contracts.ts. */
const SIDEBAR_SECTIONS_IMPORT_STATUSES = ['imported', 'merged', 'already_done', 'failed'];
/**
 * The `namespace` label every namespaced-tool metric carries:
 * `BuiltinToolNamespace` in agent-tools src/shared/builtin-tool-namespaces.ts
 * with the dot of a dotted wire name written as an underscore, because registry
 * label values are snake_case. `other` covers every namespace that is not one
 * of them. Reporters map a wire name onto these through `namespaceMetricLabel`
 * in agent-tools, so one map serves every metric.
 */
export const NAMESPACE_METRIC_LABELS = [
    'sidebar_section',
    'sidebar_project',
    'sidebar_view',
    'session_manage',
    'session_dispatch',
    'panel',
    'app',
    'agent',
    'mcp',
    'cron',
    'memory',
    'bunny_task',
    'other',
];
/** Copies `NamespaceSearchObservation['match']` in agent-tools src/mcp-disclosure/bounded-tool-search.ts. */
const TOOL_SEARCH_NAMESPACE_MATCHES = ['exact', 'prefix', 'none'];
/** Copies `mavisToolMovedGroup` in agent-tools src/desktop/local-mavis-namespaced-tools.ts. */
const MAVIS_TOOL_MOVED_GROUPS = ['agent', 'session', 'mcp', 'other'];
/**
 * The `tool` label of the managed-tool metrics: every name in
 * `BUILTIN_NAMESPACED_TOOL_NAMES` (agent-tools
 * src/shared/builtin-tool-namespaces.ts), plus the `other` an unregistered
 * namespaced tool reports under.
 */
export const MANAGED_TOOL_LABELS = [
    'section_create',
    'section_delete',
    'section_list',
    'section_move_project',
    'section_move_session',
    'section_rename',
    'section_reorder',
    'project_archive_sessions',
    'project_create',
    'project_list',
    'project_remove',
    'project_rename',
    'sidebar_read',
    'sidebar_pin',
    'pinned_reorder',
    'session_mark_read',
    'sidebar_preferences_update',
    'session_list',
    'session_get',
    'session_update',
    'session_messages',
    'session_open',
    'session_fork',
    'session_create',
    'session_send',
    'session_interrupt',
    'session_wait',
    'panel_open_file',
    'panel_open_review',
    'usage_get',
    'app_update_check',
    'plugin_list',
    'plugin_set_enabled',
    'plugin_uninstall',
    'agent_list',
    'agent_get',
    'agent_create',
    'agent_update',
    'agent_delete',
    'mcp_server_list',
    'mcp_server_get',
    'mcp_server_create',
    'mcp_server_update',
    'mcp_server_delete',
    'cron_create',
    'cron_read',
    'cron_update',
    'cron_delete',
    'self_reminder',
    'other',
];
/**
 * The `tool` label of a namespaced builtin tool. An unregistered name is
 * `other`, which is what keeps the label a bounded enum; the raw name travels
 * beside it as `tool_name` in the log line.
 */
export function managedToolLabel(name) {
    return MANAGED_TOOL_LABELS.includes(name)
        ? name
        : 'other';
}
/**
 * Copies `DESKTOP_TOOL_ERROR_CODES` in agent-tools
 * src/desktop/desktop-tool-result.ts, lower snake_case because registry label
 * values are snake_case; the log line keeps the desktop code verbatim.
 */
const MANAGED_TOOL_ERROR_CODES = [
    'skill_required',
    'ui_unavailable',
    'ui_request_failed',
    'session_not_active',
    'content_blocked',
    'content_review_unavailable',
    'not_found',
    'invalid_argument',
    'conflict',
    'internal',
    'session_create_no_caller',
    'session_create_invalid_content',
    'session_create_invalid_location',
    'session_create_invalid_argument',
    'session_create_invalid_workspace',
    'session_create_unknown_project',
    'session_create_unknown_agent',
    'session_create_model_unresolved',
    'session_create_admission_failed',
    'session_create_unexpected_error',
];
/**
 * The `error_code` label of a desktop tool failure. The wire code is upper
 * snake_case, which registry label values are not, so the label is its lower
 * snake_case form; the log line keeps the wire code verbatim.
 */
export function managedToolErrorCodeLabel(code) {
    const lowered = code.toLowerCase();
    return MANAGED_TOOL_ERROR_CODES.includes(lowered)
        ? lowered
        : 'internal';
}
const MANAGED_SKILL_GATE_OUTCOMES = ['blocked', 'receipt', 'shared_read'];
const MANAGED_SKILL_APPEND_OUTCOMES = ['already_loaded', 'no_tools', 'appended'];
const MANAGED_TOOL_CALL_STATUSES = ['skill_required', 'ok', 'failed'];
const MANAGED_TOOL_CALL_MODES = ['ptc', 'non_ptc'];
/**
 * Copies `GlobalUiRequestOperation` in shared src/global-events.ts with the dot
 * of a dotted operation written as an underscore, because registry label values
 * are snake_case.
 */
const UI_REQUEST_OPERATIONS = [
    'session_open',
    'session_mark_read',
    'sidebar_preferences_update',
    'usage_get',
    'app_update_check',
    'panel_open_file',
    'panel_open_review',
];
const UI_REQUEST_STATUSES = ['ok', 'timeout', 'failed'];
/**
 * `PermissionMode` of @mavis/permission in snake_case. The legacy
 * `permission_ask_shown_total` predates the registry and keeps reporting the
 * camelCase value.
 */
export const PERMISSION_MODE_LABELS = [
    'default',
    'accept_edits',
    'bypass_permissions',
    'auto',
    'dont_ask',
    'off',
];
/** Copies `PermissionDecisionSource` in local-runtime-v2 permission-metrics.ts. */
const PERMISSION_DECISION_SOURCES = [
    'boundary_deny',
    'mode_off',
    'store_unhealthy',
    'rule_allow',
    'rule_ask',
    'rule_deny',
    'local_policy',
    'engine_allow',
    'engine_ask',
    'engine_deny',
    'mode_dont_ask',
    'classifier_allow',
    'classifier_confirm',
    'classifier_block',
    'classifier_error',
    'ask_gate_bypass',
    'unknown',
];
/**
 * `kind` of `permission_fast_allow_total`: the allow-path safetyCheck
 * categories of @mavis/permission in snake_case, the reason codes of
 * local-runtime-v2 decision-attribution.ts, `mixed` for bash subcommands that
 * disagree and `other` for anything else.
 */
export const PERMISSION_FAST_ALLOW_KINDS = [
    'authorized_local_script',
    'authorized_write_redirect',
    'authorized_powershell_copy_move',
    'bypass_allow',
    'help_flag_fast_allow',
    'known_safe_command',
    'known_safe_powershell_command',
    'pure_read_fast_allow',
    'source_local_allow',
    'write_authorized_target',
    'persisted_rule',
    'safety_check',
    'working_directory_boundary',
    'internal_whitelist',
    'session_owned_readable_path',
    'trusted_exact_write',
    'temp_directory',
    'sandbox',
    'permission_mode',
    'path_validation',
    'dangerous_removal',
    'subcommand_results',
    'recoverable_delete_rewrite',
    'mixed',
    'other',
];
const PERMISSION_TOOL_KINDS = ['bash', 'fs_read', 'fs_write', 'web', 'mcp', 'other'];
const PERMISSION_PLATFORMS = ['win32', 'darwin', 'linux', 'other'];
const PERMISSION_SESSION_KINDS = [
    'conversation',
    'task',
    'peek',
    'channel',
    'cron',
    'unknown',
];
/** Who reads the permission metrics. */
const PERMISSION_CONSUMER = 'Permission owners, for ask-rate and fast-allow coverage panels';
/** Labels of the physical LLM request metrics. */
const MERGE_REQUEST_CONSUMER = 'Merge request panel: review of the refresh interval, the hourly request budget per host, and how long the panel waits';
const MERGE_REQUEST_PLATFORMS = ['gitlab', 'github'];
const MERGE_REQUEST_CLI_OUTCOMES = [
    'ok',
    'cli_missing',
    'not_authenticated',
    'rate_limited',
    'timeout',
    'not_found',
    'forbidden',
    'upstream',
    // Writes: the head moved before a merge, the platform refused to merge, a check
    // cannot rerun, the branch already has a merge request, or the platform refused
    // the request as it stands.
    'head_changed',
    'not_mergeable',
    'cannot_retry',
    'already_exists',
    'invalid',
];
const LLM_REQUEST_LABELS = {
    provider: INGEST_NORMALIZED,
    model: INGEST_NORMALIZED,
    caller: PI_CALLERS,
    route: MODEL_CALL_ROUTE_LABELS,
};
/** Who reads the skill catalog metrics. */
const SKILL_CATALOG_CONSUMER = 'MiniMax Code skill catalog owners: window freeze rollout and catalog budget tuning';
/** Values of `SKILL_CATALOG_WINDOW_REASON_LABELS` in agent-tools skill-catalog-window. */
const SKILL_CATALOG_WINDOW_REASONS = [
    'first',
    'compaction',
    'context_window',
    'upstream_changed',
    'no_state',
    'error',
];
/** Copies the result of `skillCatalogListing` in agent-tools skill-catalog-window. */
const SKILL_CATALOG_LISTINGS = ['described', 'name_only', 'notice', 'unlisted'];
export const METRIC_DEFINITIONS = {
    browser_run_script_total: {
        type: 'counter',
        unit: 'count',
        help: 'Browser provider run_script calls, classified by observed keyboard or mouse use.',
        consumer: 'Browser automation input usage dashboard',
        labels: { input: ['none', 'keyboard_mouse', 'unknown'] },
    },
    browser_write_action_total: {
        type: 'counter',
        unit: 'count',
        help: 'Browser page input actions by their provider outcome.',
        consumer: 'Browser automation write success dashboard',
        labels: { outcome: ['ok', 'error'] },
    },
    browser_post_action_screenshot_duration_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'FAST',
        help: 'From a Browser action result to its automatic screenshot settling, including queueing and compression.',
        consumer: 'Browser screenshot latency dashboard',
        labels: { outcome: ['attached', 'deduplicated', 'empty', 'failed', 'timeout'] },
    },
    browser_post_action_screenshot_stage_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'FAST',
        help: 'Components of the automatic screenshot wait for attached or deduplicated Browser screenshots.',
        consumer: 'Browser screenshot latency breakdown dashboard',
        labels: { phase: ['queue', 'capture', 'encode', 'transfer', 'compress', 'provider'] },
    },
    browser_turn_opened_tabs_items: {
        type: 'histogram',
        unit: 'items',
        buckets: 'COUNT',
        help: 'Tabs opened by the Agent during a completed Turn with at least one Browser action.',
        consumer: 'Browser automation tab usage dashboard',
        labels: {},
    },
    // Electron main process: local runtime supervision.
    supervisor_runtime_start_total: {
        type: 'counter',
        unit: 'count',
        help: 'Local runtime launch attempts of the Electron main process, by outcome: ready, or a startup failure. Each attempt counts once; nothing is counted while the app quits.',
        consumer: 'Desktop runtime stability dashboard',
        labels: { result: ['ready', 'startup_failed'], os: SUPERVISOR_OS },
    },
    supervisor_runtime_exit_total: {
        type: 'counter',
        unit: 'count',
        help: 'Launch attempts that ended without the app asking: a startup failure (its reason code), a ready runtime that exited (process_exit) or one the supervisor recycled (memory_pressure, runtime_unresponsive, oom, network_service_lost). Each attempt counts once; nothing is counted while the app quits.',
        consumer: 'Desktop runtime stability dashboard and alerts',
        labels: { reason: RUNTIME_RECOVERY_REASONS, os: SUPERVISOR_OS },
    },
    supervisor_runtime_restart_total: {
        type: 'counter',
        unit: 'count',
        help: 'Automatic recoveries the supervisor started on a ready runtime (runtime-recovery-started: memory_pressure, runtime_unresponsive, oom, network_service_lost). Crash restarts show as supervisor_runtime_exit_total{reason="process_exit"}.',
        consumer: 'Desktop runtime stability dashboard',
        labels: { reason: RUNTIME_RECOVERY_REASONS },
    },
    // Local runtime turns.
    pi_turn_failure_total: {
        type: 'counter',
        unit: 'count',
        help: 'Failed turns by error source and kind; local_* kinds come from the system error code.',
        consumer: 'Turn failure dashboard and alerts',
        labels: {
            caller: PI_CALLERS,
            errorSource: TURN_ERROR_SOURCES,
            errorKind: TURN_FAILURE_ERROR_KINDS,
        },
        optionalLabels: AGENT_KIND_LABEL,
    },
    pi_turn_busy_ms_total: {
        type: 'counter',
        unit: 'ms',
        help: 'Running turns times elapsed ms, added every report cycle and at turn end; rate()/1000 is the average concurrent turns. Replaces pi_active_turns.',
        consumer: 'Turn concurrency panels',
        labels: { caller: PI_CALLERS },
    },
    metrics_client_dropped_points_total: {
        type: 'counter',
        unit: 'count',
        help: 'Points the Desktop metrics client dropped: non_retryable_status for a batch the endpoint answered with a status other than 429, 502, 503 or 504; series_limit for new series a failed batch could not put back (maxCarryOverSeries or maxSeries). Sent in a request of its own; like every counter of this client, a request that timed out after the server processed it is sent again and counted twice.',
        consumer: 'Telemetry completeness checks',
        labels: { reason: METRICS_DROP_REASONS },
    },
    // LLM requests (shipped before the registry; route added).
    pi_llm_request_total: {
        type: 'counter',
        unit: 'count',
        help: 'Physical provider requests started by a turn; every retry attempt counts. route tells the managed Token Plan from BYOK calls.',
        consumer: 'LLM request success-rate panels',
        labels: LLM_REQUEST_LABELS,
        optionalLabels: AGENT_KIND_LABEL,
    },
    pi_llm_response_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: LONG_TAIL_BUCKETS,
        help: 'Physical provider request from start to settlement (done, error or abort), by route.',
        consumer: 'LLM latency panels',
        labels: LLM_REQUEST_LABELS,
        optionalLabels: AGENT_KIND_LABEL,
    },
    pi_llm_first_token_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: LONG_TAIL_BUCKETS,
        help: 'Deprecated, replaced by pi_llm_first_output_ms. Physical provider request from start to its first text, thinking or tool-call event, block starts included.',
        consumer: 'Legacy first-token panels until they move to pi_llm_first_output_ms',
        labels: { provider: INGEST_NORMALIZED, model: INGEST_NORMALIZED, caller: PI_CALLERS },
        optionalLabels: AGENT_KIND_LABEL,
        deprecated: 'pi_llm_first_output_ms',
    },
    pi_llm_logical_call_total: {
        type: 'counter',
        unit: 'count',
        help: 'Final outcome of each logical LLM call, after its automatic retries, by route.',
        consumer: 'LLM success-after-retry panels and alerts',
        labels: {
            ...LLM_REQUEST_LABELS,
            scope: LLM_CALL_SCOPES,
            outcome: ['success', 'error', 'abort'],
            errorKind: LLM_CALL_ERROR_KINDS,
            retryTriggered: BOOLEAN_VALUES,
        },
        optionalLabels: AGENT_KIND_LABEL,
    },
    // First output. A first output is the first non-empty text, thinking or
    // tool-call argument fragment; block-start events do not count (the check of
    // biz-gateway open_platform_direct_support.go). A request starts when the
    // turn's metrics wrapper is invoked for it, right before the provider builds
    // and sends it.
    pi_turn_first_output_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'TTFT',
        help: "From the runtime accepting the user message (durable admission, acceptedAtMs) to the first output of the turn's first model request, any of its retries. compacted: an automatic compaction request was sent before it. wake: user when a person started any input of the turn's starting batch in a client (composer, TUI, ACP, IM, questionnaire answer, edit and resend, Mini App, /review), otherwise system. conversation: new when the session history before the turn's own input holds no user, assistant or compaction summary message (a continuation counts its whole history), otherwise existing.",
        consumer: 'Desktop first-output dashboard',
        labels: {
            route: MODEL_CALL_ROUTE_LABELS,
            model: INGEST_NORMALIZED,
            caller: PI_CALLERS,
            compacted: BOOLEAN_VALUES,
            wake: TURN_WAKE_LABELS,
            conversation: TURN_CONVERSATION_LABELS,
        },
        optionalLabels: AGENT_KIND_LABEL,
    },
    pi_turn_first_visible_text_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'TOTAL',
        help: 'From the runtime accepting the user message (acceptedAtMs, as pi_turn_first_output_ms) to the first assistant text of the turn the user can see: streamed or settled body text, or delivered send_to_user content, as it leaves output review and the display projection. Text that output review held counts from its release. At most once per turn; a turn that shows no text records nothing. compacted, wake and conversation as pi_turn_first_output_ms.',
        consumer: 'Desktop first-output dashboard; MiniMax Code · Bunny dashboard (uid minimax-code-bunny) for Bunny first visible text',
        labels: {
            route: MODEL_CALL_ROUTE_LABELS,
            model: INGEST_NORMALIZED,
            caller: PI_CALLERS,
            compacted: BOOLEAN_VALUES,
            wake: TURN_WAKE_LABELS,
            conversation: TURN_CONVERSATION_LABELS,
        },
        optionalLabels: AGENT_KIND_LABEL,
    },
    pi_turn_prepare_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'FAST',
        help: 'Contiguous runtime stages from the runtime accepting the user message to the first model request: accepted (until the agent host starts the turn), assembling (session, agent and history reads, model and credential resolution, runtime assembly), preparing (plugin hooks, tools, prompt and reminders), persisting (until the running status is written), dispatching (until the first request; dropped when automatic compaction ran first). UI send to runtime acceptance is not timed yet: the UI also marks a send accepted when it keeps a composer steer that never reached the runtime while a Goal runs. wake as pi_turn_first_output_ms.',
        consumer: 'Turn preparation latency investigation',
        labels: {
            stage: ['accepted', 'assembling', 'preparing', 'persisting', 'dispatching'],
            caller: PI_CALLERS,
            wake: TURN_WAKE_LABELS,
        },
        optionalLabels: AGENT_KIND_LABEL,
    },
    pi_llm_first_output_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'TTFT',
        help: 'Per model request of a turn, every retry included, from its start to its first output. Replaces pi_llm_first_token_ms. Automatic compaction requests are not recorded.',
        consumer: 'Request-level first output',
        labels: {
            route: MODEL_CALL_ROUTE_LABELS,
            model: INGEST_NORMALIZED,
            caller: PI_CALLERS,
            phase: ['initial', 'iteration'],
        },
        optionalLabels: AGENT_KIND_LABEL,
    },
    pi_llm_response_header_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'TTFT',
        help: 'Per model request of a turn, from its start to the provider handing over the response headers (onResponse). The Google providers only get the response with the first stream chunk, so theirs ends at that chunk. Automatic compaction requests are not recorded.',
        consumer: 'Transport time derivation with Server-Timing',
        labels: { route: MODEL_CALL_ROUTE_LABELS, model: INGEST_NORMALIZED, caller: PI_CALLERS },
    },
    pi_llm_transport_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'FAST',
        help: 'Managed Token Plan requests only: pi_llm_response_header_ms of the request minus the Server-Timing gw and up of its response. Not recorded when the header is missing or malformed or the result is negative.',
        consumer: 'Upload, network and ingress proxy latency',
        labels: { model: INGEST_NORMALIZED, caller: PI_CALLERS },
    },
    output_safety_first_chunk_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'FAST',
        help: "The first body-text window of a turn's first attempt under output review: buffer_wait from its first text entering the window to its review starting (80 characters, a boundary or the final message), check for that review.",
        consumer: 'Output safety impact on first output',
        labels: { stage: ['buffer_wait', 'check'], caller: PI_CALLERS },
    },
    session_title_review_total: {
        type: 'counter',
        unit: 'count',
        help: '回复落库后的会话标题处理结果。mode=review 是自动标题的一次复核；mode=fallback 是对仍显示截断兜底标题的会话按首轮内容补命名，每个会话最多 3 轮。',
        consumer: '会话标题维护者用于复核效果、补命名成功率与失败率排查',
        labels: {
            outcome: ['kept', 'updated', 'invalid_output', 'failed', 'skipped_race'],
            mode: ['review', 'fallback'],
        },
    },
    ui_first_visible_response_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'VISIBLE',
        help: 'From pressing send to the first business chunk in the UI; resumed streams are excluded.',
        consumer: 'User-perceived first output',
        labels: {
            content_type: ['text', 'thinking', 'tool'],
            route: MODEL_CALL_ROUTE_LABELS,
            model: INGEST_NORMALIZED,
        },
    },
    ui_first_render_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'FAST',
        help: 'From the first business chunk to the next painted frame (two animation frames; approximate). Not recorded when the window is hidden at the chunk or before those frames: a hidden window does not paint.',
        consumer: 'UI stalls on first output',
        labels: {},
    },
    ui_first_paint_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'VISIBLE',
        help: 'Migrated client_first_paint_ms: from send to the first text delta reaching the client.',
        consumer: 'First paint panels',
        labels: { visibility: ['visible', 'hidden'] },
    },
    ui_axios_401_total: {
        type: 'counter',
        unit: 'count',
        help: 'Migrated axios_401: UI API calls rejected with 401. The raw URL is not a label.',
        consumer: 'Login health panels',
        labels: {},
    },
    ui_login_modal_total: {
        type: 'counter',
        unit: 'count',
        help: 'Migrated electron_login_modal: the Desktop login modal was opened.',
        consumer: 'Login health panels',
        labels: {},
    },
    // Plugin snapshot gauge replaced (R4).
    plugin_snapshot_component_items: {
        type: 'histogram',
        unit: 'items',
        buckets: 'COUNT',
        help: 'Components in each published plugin snapshot, one observation per component and publication. Replaces plugin_snapshot_component_count.',
        consumer: 'MiniMax Code dashboard: plugin snapshot capability counts',
        labels: { component: PLUGIN_SNAPSHOT_COMPONENTS },
    },
    // Workspace indexing gauges replaced (R4).
    workspace_indexing_busy_ms_total: {
        type: 'counter',
        unit: 'ms',
        help: 'In-flight indexing operations times elapsed ms per stage, added every report cycle. Replaces workspace_indexing_inflight.',
        consumer: 'Workspace indexing dashboards',
        labels: { stage: WORKSPACE_INDEXING_STAGES, os: WORKSPACE_INDEXING_OS },
    },
    workspace_indexing_backlog_items: {
        type: 'histogram',
        unit: 'items',
        buckets: 'COUNT',
        help: 'Durable remote indexing queue depth, observed once per report cycle. Replaces workspace_indexing_backlog.',
        consumer: 'Workspace indexing dashboards',
        labels: { os: WORKSPACE_INDEXING_OS },
    },
    workspace_indexing_backlog_head_age_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'AGE',
        help: 'Age of the oldest due revision in the durable queue, observed once per report cycle. Replaces workspace_indexing_backlog_oldest_age_ms.',
        consumer: 'Workspace indexing dashboards',
        labels: { os: WORKSPACE_INDEXING_OS },
    },
    // Bunny. Its first output and first visible text are the shared turn metrics
    // above with agentKind; these are what only Bunny has.
    bunny_enabled_state_total: {
        type: 'counter',
        unit: 'count',
        help: "Bunny's switch as the host config boundary resolves it, by the rule that decided it: once at the first resolution of a runtime, then on every change of (enabled, source).",
        consumer: BUNNY_CONSUMER,
        labels: {
            enabled: BOOLEAN_VALUES,
            source: ['force_disabled', 'local', 'rollout', 'default', 'build'],
        },
    },
    bunny_store_open_total: {
        type: 'counter',
        unit: 'count',
        help: "The Bunny store's first open in a runtime process: ok, rebuilt from a damaged or mismatched file (reason), or unavailable and replaced by an empty in-memory store.",
        consumer: BUNNY_CONSUMER,
        labels: {
            outcome: ['ok', 'rebuilt', 'unavailable'],
            reason: ['none', 'integrity_check_failed', 'schema_mismatch', 'open_error'],
        },
    },
    bunny_turn_total: {
        type: 'counter',
        unit: 'count',
        help: "Turns of Bunny's main conversation at their end. primary_wake: the first of user, user_answer, task_report, cron, self_reminder, background_task, peer among the Turn's wake reasons, none without one. silent: the Turn ended silent. model: the model ID it ran on, unknown when it resolved none.",
        consumer: BUNNY_CONSUMER,
        labels: {
            primary_wake: [
                'user',
                'user_answer',
                'task_report',
                'cron',
                'self_reminder',
                'background_task',
                'peer',
                'none',
            ],
            silent: BOOLEAN_VALUES,
            model: INGEST_NORMALIZED,
        },
    },
    bunny_compaction_total: {
        type: 'counter',
        unit: 'count',
        help: "Compactions of Bunny's main conversation that ended (committed, failed, voided, merged, delegated) or were skipped at the failure limit, by trigger and outcome.",
        consumer: BUNNY_CONSUMER,
        labels: { trigger: BUNNY_COMPACTION_TRIGGERS, outcome: BUNNY_COMPACTION_OUTCOMES },
    },
    bunny_compaction_run_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'TOTAL',
        help: "Duration of a compaction of Bunny's main conversation counted in bunny_compaction_total, when it has one, by outcome. Replaces bunny_compaction_duration_ms.",
        consumer: BUNNY_CONSUMER,
        labels: { outcome: BUNNY_COMPACTION_OUTCOMES },
    },
    bunny_turn_compaction_wait_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'TOTAL',
        help: "How long a Bunny Turn's model request was held for a foreground compaction it had to wait for: from the before-request decision to the request going out or the Turn giving up. phase: initial (the Turn's first request) or iteration (a later one). result: replaced, continued, skipped, aborted, other, or error when the decision threw. Replaces bunny_compaction_wait_ms.",
        consumer: BUNNY_CONSUMER,
        labels: {
            phase: ['initial', 'iteration'],
            result: ['replaced', 'continued', 'skipped', 'aborted', 'other', 'error'],
        },
    },
    bunny_compaction_before_tokens_total: {
        type: 'counter',
        unit: 'count',
        help: 'Tokens of the conversation before each committed Bunny compaction that reported both its tokens before (above 0) and after. Saved share: 1 - after / before.',
        consumer: BUNNY_CONSUMER,
        labels: {},
    },
    bunny_compaction_after_tokens_total: {
        type: 'counter',
        unit: 'count',
        help: 'Tokens of the conversation after each compaction counted in bunny_compaction_before_tokens_total.',
        consumer: BUNNY_CONSUMER,
        labels: {},
    },
    bunny_memory_write_total: {
        type: 'counter',
        unit: 'count',
        help: "Writes to Bunny's memory that finished: remember's add, update and forget, the user's edit in settings, background capture and lint.",
        consumer: BUNNY_CONSUMER,
        labels: {
            op: ['add', 'update', 'forget', 'edit', 'capture', 'lint'],
            outcome: ['ok', 'duplicate', 'skipped', 'failed'],
        },
    },
    bunny_conversation_tool_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'FAST',
        help: 'One conversation_search or conversation_read call of Bunny, called directly or from run_code. Replaces bunny_search_duration_ms.',
        consumer: BUNNY_CONSUMER,
        labels: { tool: ['conversation_search', 'conversation_read'] },
    },
    bunny_failure_total: {
        type: 'counter',
        unit: 'count',
        help: "Failures of Bunny's modules by scope and code, from a closed list (BUNNY_FAILURE_CODES); anything else is other and the raw code is in the bunny.failure warn line.",
        consumer: BUNNY_CONSUMER,
        labels: {
            scope: ['memory', 'ledger', 'search', 'delivery_baseline', 'first_use'],
            code: BUNNY_FAILURE_CODES,
        },
    },
    bunny_trace_overhead_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'FAST',
        help: 'Building and reporting one Bunny trace event, by event (BUNNY_TRACE_EVENTS). Most take well under 5 ms; read the total overhead from the sum. Replaces bunny_trace_cost_ms.',
        consumer: BUNNY_CONSUMER,
        labels: { event: BUNNY_TRACE_EVENTS },
    },
    bunny_assignment_total: {
        type: 'counter',
        unit: 'count',
        help: "Bunny's assignment calls that succeeded, other than creates (bunny_task_created_total): a send admitted by its task (reason rework, supplement or decision, none otherwise), a cancel of its own task, a stop that took effect. Direct or from run_code.",
        consumer: BUNNY_CONSUMER,
        labels: {
            action: ['send', 'cancel', 'stop'],
            reason: ['rework', 'supplement', 'decision', 'none'],
        },
    },
    bunny_task_created_total: {
        type: 'counter',
        unit: 'count',
        help: "Tasks Bunny created, from their task.opened history event, by where and why they were dispatched; unknown when the history lacks it. Bunny's task count.",
        consumer: BUNNY_CONSUMER,
        labels: {
            exec_location: ['project', 'space', 'unknown'],
            trigger: ['user', 'cron', 'task_report', 'other', 'unknown'],
        },
    },
    bunny_task_abnormal_total: {
        type: 'counter',
        unit: 'count',
        help: "Bunny's tasks that went wrong, one per history event: error (a round failed), network (failed on a lost connection), stopped, restart (the app's restart cut a round off), stalled.",
        consumer: BUNNY_CONSUMER,
        labels: { kind: ['error', 'network', 'stopped', 'restart', 'stalled'] },
    },
    bunny_task_tokens_total: {
        type: 'counter',
        unit: 'count',
        help: 'Input plus output tokens of each closed Bunny task that recorded them, by close state. Divided by bunny_task_closed_total: the average tokens per task.',
        consumer: BUNNY_CONSUMER,
        labels: { state: BUNNY_TASK_CLOSE_STATES },
    },
    bunny_task_closed_total: {
        type: 'counter',
        unit: 'count',
        help: 'Bunny tasks closed, one per task.closed history event, by close state.',
        consumer: BUNNY_CONSUMER,
        labels: { state: BUNNY_TASK_CLOSE_STATES },
    },
    bunny_steer_total: {
        type: 'counter',
        unit: 'count',
        help: "User messages typed from a client composer into a running Turn of Bunny's main conversation, one each: when the Turn takes it, or when the Turn ends without taking it (handed_back, turn_ended).",
        consumer: BUNNY_CONSUMER,
        labels: { outcome: BUNNY_STEER_OUTCOMES },
    },
    bunny_steer_pickup_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'TTFT',
        help: "From a running Bunny Turn admitting a typed message to processing it starting: the Turn's next model request taking it, or for handed_back the follow-up Turn starting. turn_ended messages have none. Replaces bunny_steer_wait_ms.",
        consumer: BUNNY_CONSUMER,
        labels: {
            outcome: ['preempted', 'merged', 'waited', 'preempt_failed', 'handed_back'],
        },
    },
    bunny_emergency_rebuild_total: {
        type: 'counter',
        unit: 'count',
        help: 'Emergency handlings of a Bunny Turn that was about to fail, once each result is known, by failure category, action, rebuild level and result.',
        consumer: BUNNY_CONSUMER,
        labels: {
            category: BUNNY_EMERGENCY_CATEGORIES,
            action: ['resend', 'rebuild', 'history_repair', 'config_rewrite'],
            level: ['standard', 'image', 'tight', 'safety', 'none'],
            result: [
                'recovered',
                'retry_failed',
                'rebuild_failed',
                'stopped',
                'limit_reached',
                'fixed_prefix_over_limit',
            ],
        },
    },
    bunny_context_reset_total: {
        type: 'counter',
        unit: 'count',
        help: "Context resets the user asked for in Bunny's main conversation, by result; forced: the running Turn did not stop in time and was ended by force.",
        consumer: BUNNY_CONSUMER,
        labels: { result: ['completed', 'failed'], forced: BOOLEAN_VALUES },
    },
    bunny_telemetry_dropped_total: {
        type: 'counter',
        unit: 'count',
        help: 'Bunny task telemetry facts the outbox dropped, by why: outbox_full for rows deleted past the outbox row limit, write_failed for a telemetry write that threw and was contained so the task mutation still succeeded.',
        consumer: BUNNY_CONSUMER,
        labels: { reason: ['outbox_full', 'write_failed'] },
    },
    // Skill catalog: system prompt prefix stability, the per-window catalog freeze and skill loads.
    prompt_section_change_total: {
        type: 'counter',
        unit: 'count',
        help: "Local Turns whose final system prompt changed a section's bytes from the Session's previous prepared request: across_turn against the previous Turn, within_turn when the same Turn prepared again. Committed compactions reset the baseline. A change breaks the provider prompt cache from that section on.",
        consumer: SKILL_CATALOG_CONSUMER,
        labels: {
            section: ['skills', 'memory', 'other'],
            scope: ['across_turn', 'within_turn'],
        },
    },
    skill_catalog_window_total: {
        type: 'counter',
        unit: 'count',
        help: 'Skill catalog windows a local Turn started (first window of the Session, after a compaction) or resynced (context window or the system prompt before the catalog changed). shadow: skills.freezeCatalog is off, so every Turn renders the live catalog and the window is only measured.',
        consumer: SKILL_CATALOG_CONSUMER,
        labels: {
            event: ['started', 'resynced'],
            reason: SKILL_CATALOG_WINDOW_REASONS,
            shadow: BOOLEAN_VALUES,
        },
    },
    skill_catalog_window_deviation_total: {
        type: 'counter',
        unit: 'count',
        help: "Skills added, removed or with a changed description since the Session's previous committed local Turn while a window continues, added to by the number of skills of each kind. Without the freeze each such Turn would have changed the catalog and broken the prompt cache; shadow=true measures that before the freeze is on. Turns that start or resync a window count nothing: their prefix changes anyway.",
        consumer: SKILL_CATALOG_CONSUMER,
        labels: { kind: ['added', 'removed', 'changed'], shadow: BOOLEAN_VALUES },
    },
    skill_catalog_skill_items: {
        type: 'histogram',
        unit: 'items',
        buckets: 'COUNT',
        help: 'Skills listed in the catalog of each window a local Turn started or resynced. Names are never dropped, so this is every enabled Skill.',
        consumer: SKILL_CATALOG_CONSUMER,
        labels: { shadow: BOOLEAN_VALUES },
    },
    skill_catalog_tokens_total: {
        type: 'counter',
        unit: 'count',
        help: 'Estimated tokens of the catalog of each window a local Turn started or resynced. Divided by skill_catalog_window_total: the average catalog size.',
        consumer: SKILL_CATALOG_CONSUMER,
        labels: { shadow: BOOLEAN_VALUES },
    },
    skill_catalog_descriptions_dropped_total: {
        type: 'counter',
        unit: 'count',
        help: 'Skills listed by name only because their description did not fit the catalog budget, added to per window a local Turn started or resynced. Replaces skill_catalog_overflow_observed_total.',
        consumer: SKILL_CATALOG_CONSUMER,
        labels: { shadow: BOOLEAN_VALUES },
    },
    skill_catalog_description_cap_total: {
        type: 'counter',
        unit: 'count',
        help: 'Windows a local Turn started or resynced whose catalog cut some description at 1,024 code points. Replaces skill_catalog_description_cap_observed_total.',
        consumer: SKILL_CATALOG_CONSUMER,
        labels: { shadow: BOOLEAN_VALUES },
    },
    skill_load_total: {
        type: 'counter',
        unit: 'count',
        help: "Calls of the local `skill` tool, by result (unavailable: the Skill was in this window's catalog or announced but is gone now) and by how the window listed the requested name. No skill name label: names are unbounded.",
        consumer: SKILL_CATALOG_CONSUMER,
        labels: {
            status: ['ok', 'not_found', 'unavailable', 'error'],
            listing: SKILL_CATALOG_LISTINGS,
        },
    },
    // Permission decisions. The other permission_* metrics predate the registry
    // and stay in legacy-metric-names.ts until their call sites change.
    permission_check_total: {
        type: 'counter',
        unit: 'count',
        help: 'Final permission decisions at the facade and Mini App exits, by mode, result, the layer that decided (source), tool kind and platform. Asks the Turn gate raises without a facade decision are not counted; see permission_ask_shown_total.',
        consumer: PERMISSION_CONSUMER,
        labels: {
            mode: PERMISSION_MODE_LABELS,
            result: ['allow', 'ask', 'deny'],
            source: PERMISSION_DECISION_SOURCES,
            tool_kind: PERMISSION_TOOL_KINDS,
            platform: PERMISSION_PLATFORMS,
        },
    },
    permission_fast_allow_total: {
        type: 'counter',
        unit: 'count',
        help: 'Deterministic engine allows (source engine_allow), by the fast path that allowed them (kind) and platform.',
        consumer: PERMISSION_CONSUMER,
        labels: { kind: PERMISSION_FAST_ALLOW_KINDS, platform: PERMISSION_PLATFORMS },
    },
    permission_mode_change_total: {
        type: 'counter',
        unit: 'count',
        help: 'Effective profile permission-mode changes, from one mode to another; writes that keep the mode are not counted.',
        consumer: PERMISSION_CONSUMER,
        labels: { from: PERMISSION_MODE_LABELS, to: PERMISSION_MODE_LABELS },
    },
    permission_ask_wait_range_total: {
        type: 'counter',
        unit: 'count',
        help: 'Settled permission asks by how long the card waited (range, up to gt_4h), outcome (replied or abandoned) and session kind. Carries the long tail of permission_ask_wait_ms per release, which histograms cannot.',
        consumer: PERMISSION_CONSUMER,
        labels: {
            outcome: ['replied', 'abandoned'],
            range: ['lt_1m', '1m_5m', '5m_15m', '15m_1h', '1h_4h', 'gt_4h'],
            sessionKind: PERMISSION_SESSION_KINDS,
        },
    },
    // Context compaction over a history whose tool calls did not pair.
    compact_history_repaired_total: {
        type: 'counter',
        unit: 'count',
        help: 'Compactions that ran on a history whose tool calls and results did not pair (legacy v1 histories, interrupted turns) and summarized only the paired part instead of failing, one per compaction. phase: initial or iteration for automatic compaction before a model request of the turn, manual for /compact.',
        consumer: 'Context compaction owners, for legacy history repair watch',
        labels: { phase: CONTEXT_COMPACTION_PHASES },
    },
    // PTC (run_code) session store. The other ptc_* metrics predate the registry
    // and stay in legacy-metric-names.ts until their call sites change.
    ptc_store_write_total: {
        type: 'counter',
        unit: 'count',
        help: 'Values a finished run_code program persisted to its Session store, one per key it wrote; a program that stored nothing records nothing. Writes the host refused are not counted here. surface: the product surface of the Turn.',
        consumer: PTC_STORE_CONSUMER,
        labels: { surface: PTC_SURFACES },
    },
    ptc_store_load_total: {
        type: 'counter',
        unit: 'count',
        help: 'load() calls of a finished run_code program that reached the host, whether or not the key existed; a program that loaded nothing records nothing. surface: the product surface of the Turn.',
        consumer: PTC_STORE_CONSUMER,
        labels: { surface: PTC_SURFACES },
    },
    // Merge request panel (beta.reviewStatus): the glab / gh requests behind it.
    merge_request_cli_request_total: {
        type: 'counter',
        unit: 'count',
        help: 'glab / gh requests of the merge request panel, one per CLI run that reached the platform, by platform, purpose (refresh: polling and Turn-end records; user: a user action; probe: CLI and host checks) and outcome. CLI and login checks are counted in merge_request_cli_probe_total, budget skips in merge_request_budget_skip_total.',
        consumer: MERGE_REQUEST_CONSUMER,
        labels: {
            platform: MERGE_REQUEST_PLATFORMS,
            purpose: ['refresh', 'user', 'probe'],
            outcome: MERGE_REQUEST_CLI_OUTCOMES,
        },
    },
    merge_request_cli_request_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'TTFT',
        help: 'Duration of each glab / gh request of the merge request panel, from starting the CLI to its exit, by platform and outcome.',
        consumer: MERGE_REQUEST_CONSUMER,
        labels: { platform: MERGE_REQUEST_PLATFORMS, outcome: MERGE_REQUEST_CLI_OUTCOMES },
    },
    merge_request_budget_skip_total: {
        type: 'counter',
        unit: 'count',
        help: 'Background merge request reads skipped because their host used up its hourly request budget; user actions are never skipped.',
        consumer: MERGE_REQUEST_CONSUMER,
        labels: {},
    },
    merge_request_cli_probe_total: {
        type: 'counter',
        unit: 'count',
        help: 'glab / gh checks of the merge request panel, by platform and the state found: ready, not_installed, not_authenticated or unavailable.',
        consumer: MERGE_REQUEST_CONSUMER,
        labels: {
            platform: MERGE_REQUEST_PLATFORMS,
            state: ['ready', 'not_installed', 'not_authenticated', 'unavailable'],
        },
    },
    merge_request_list_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'FAST',
        help: "Time the runtime takes to answer the merge request panel's list read, by how it was served: fresh (data read within the panel's cache window), stale (older data answered at once while a background read refreshes it; merge_request_refresh_ms and merge_request_served_age_ms describe that wait) or fetched (nothing to show yet, or a manual refresh, so the answer waited for GitLab or GitHub).",
        consumer: MERGE_REQUEST_CONSUMER,
        labels: { served: ['fresh', 'stale', 'fetched'] },
    },
    merge_request_refresh_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'TTFT',
        help: 'Background refreshes started by a stale merge request list read, from the stale answer to the new data being ready, by outcome (failed when any host of the round failed).',
        consumer: MERGE_REQUEST_CONSUMER,
        labels: { outcome: ['ok', 'failed'] },
    },
    merge_request_served_age_ms: {
        type: 'histogram',
        unit: 'ms',
        buckets: 'AGE',
        help: 'Age of the oldest platform data in a merge request list answer served stale: how old the shown state is until the background refresh lands.',
        consumer: MERGE_REQUEST_CONSUMER,
        labels: {},
    },
    // Sidebar sections: the one-time import of the renderer's localStorage copy.
    sidebar_sections_import_total: {
        type: 'counter',
        unit: 'count',
        help: 'Attempts to import the sidebar sections the renderer kept in localStorage, by status: imported (the Runtime had none), merged (it had some), already_done (the import marker was already set) or failed (it threw, so the next launch retries).',
        consumer: 'Desktop sidebar owners, for the localStorage import outcome mix',
        labels: { status: SIDEBAR_SECTIONS_IMPORT_STATUSES },
    },
    // tool_search namespace discovery.
    tool_search_namespace_total: {
        type: 'counter',
        unit: 'count',
        help: 'tool_search calls that carried a namespace argument, one per call. namespace: the builtin namespace it resolved to, or other. match: exact names an indexed namespace, prefix only reaches the groups below it, none reaches neither. with_query: the same call also ranked by keyword; without both, a rising count cannot tell discovery from guessing.',
        consumer: 'Tool search owners, for namespace discovery adoption and guessing watch',
        labels: {
            namespace: NAMESPACE_METRIC_LABELS,
            match: TOOL_SEARCH_NAMESPACE_MATCHES,
            with_query: BOOLEAN_VALUES,
        },
    },
    // Namespaced builtin tools: the Skill gate, the calls it lets through and the
    // Skill-result append.
    managed_skill_gate_total: {
        type: 'counter',
        unit: 'count',
        help: 'Gate decisions for an on-demand namespaced builtin tool, one per call attempt. namespace: the tool builtin namespace, or other. outcome: blocked (no Skill receipt unlocked it), receipt (its own Skill was loaded) or shared_read (another namespace Skill listing it in sharedReads was).',
        consumer: 'Namespaced tool owners, for Skill gate adoption and blocked-call watch',
        labels: { namespace: NAMESPACE_METRIC_LABELS, outcome: MANAGED_SKILL_GATE_OUTCOMES },
    },
    managed_skill_append_total: {
        type: 'counter',
        unit: 'count',
        help: 'Skill reads whose result carried the unlocked-tools block, one per read of a Skill that owns a namespace. namespace: the namespace that Skill owns. outcome: appended (the block listed tools), already_loaded (the namespace only has default-loaded tools) or no_tools (this turn has no tool of that namespace).',
        consumer: 'Namespaced tool owners, for the unlocked-tools append outcome mix',
        labels: { namespace: NAMESPACE_METRIC_LABELS, outcome: MANAGED_SKILL_APPEND_OUTCOMES },
    },
    managed_tool_call_total: {
        type: 'counter',
        unit: 'count',
        help: 'Calls of a namespaced builtin tool, one per attempt, the ones the Skill gate refused included. namespace: the tool builtin namespace, or other. tool: the tool, or other when its name is not registered. status: skill_required (the gate refused it), ok or failed. mode: ptc when the Turn ran run_code.',
        consumer: 'Namespaced tool owners, for per-tool call volume and gate refusals',
        labels: {
            namespace: NAMESPACE_METRIC_LABELS,
            tool: MANAGED_TOOL_LABELS,
            status: MANAGED_TOOL_CALL_STATUSES,
            mode: MANAGED_TOOL_CALL_MODES,
        },
    },
    managed_tool_error_total: {
        type: 'counter',
        unit: 'count',
        help: 'Failed calls of a namespaced builtin tool, one per failure, counted beside managed_tool_call_total{status="failed"}. namespace and tool match that metric. error_code: the stable desktop tool code in lower snake_case.',
        consumer: 'Namespaced tool owners, for the per-tool failure mix',
        labels: {
            namespace: NAMESPACE_METRIC_LABELS,
            tool: MANAGED_TOOL_LABELS,
            error_code: MANAGED_TOOL_ERROR_CODES,
        },
    },
    managed_tool_call_duration_ms: {
        type: 'histogram',
        unit: 'ms',
        help: 'Wall time of a namespaced builtin tool call the Skill gate let through, from the gate decision to the result. namespace and status match managed_tool_call_total.',
        consumer: 'Namespaced tool owners, for per-namespace call latency',
        labels: { namespace: NAMESPACE_METRIC_LABELS, status: ['ok', 'failed'] },
        buckets: 'TOOL_CALL',
    },
    // mavis commands that moved to a namespaced builtin tool.
    mavis_tool_moved_total: {
        type: 'counter',
        unit: 'count',
        help: 'Legacy mavis({ command }) calls answered with the moved-command refusal, one per call. group: which group the model still reached for through mavis.',
        consumer: 'Namespaced tool owners, for the mavis migration tail',
        labels: { group: MAVIS_TOOL_MOVED_GROUPS },
    },
    // The Runtime asking the desktop UI to run something it owns.
    ui_request_total: {
        type: 'counter',
        unit: 'count',
        help: 'ui.request round trips the Runtime settled, one per request. operation: what it asked the UI to do, with the dot of a dotted operation written as an underscore. status: ok, timeout (nothing answered before the deadline) or failed.',
        consumer: 'Desktop UI channel owners, for the ui.request outcome mix',
        labels: { operation: UI_REQUEST_OPERATIONS, status: UI_REQUEST_STATUSES },
    },
    ui_request_duration_ms: {
        type: 'histogram',
        unit: 'ms',
        help: 'Wall time of one ui.request round trip, from publishing the event to the first reply that settled it. operation matches ui_request_total.',
        consumer: 'Desktop UI channel owners, for ui.request latency',
        labels: { operation: UI_REQUEST_OPERATIONS },
        buckets: 'TOOL_CALL',
    },
    // Harness content safety, and the PTC child calls it does not review. The
    // harness reports these through its own counter sink and cannot import this
    // registry, so its emit site maps the hyphenated stage vocabulary onto the
    // snake_case label values below.
    safety_check_total: {
        type: 'counter',
        unit: 'count',
        help: 'Settled content-safety checks of the harness, retries included, so a stage that retried an unavailable review counts each attempt. stage: the stage that ran. verdict: pass, block, regenerate, or unavailable when the review service gave none. host: the Host that ran it, unknown when it names none.',
        consumer: 'Content-safety owners, for verdict-rate and stage-coverage panels',
        labels: {
            stage: SAFETY_METRIC_STAGES,
            verdict: SAFETY_METRIC_VERDICTS,
            host: SAFETY_METRIC_HOSTS,
        },
    },
    safety_unavailable_total: {
        type: 'counter',
        unit: 'count',
        help: 'Stages that failed closed because the review service stayed unavailable through every retry, by stage and Host; the subset of safety_check_total{verdict="unavailable"} whose retries ran out.',
        consumer: 'Content-safety owners, for review-service availability alerts',
        labels: { stage: SAFETY_METRIC_STAGES, host: SAFETY_METRIC_HOSTS },
    },
    ptc_child_review_skipped_total: {
        type: 'counter',
        unit: 'count',
        help: 'run_code child calls whose tool stage the harness deliberately did not send for review, by the stage (tool_args or tool_result) and the Host. Only a stage the safety policy enables is counted, so this is the review a PTC child call does not get.',
        consumer: 'Content-safety owners, for the PTC child review coverage gap',
        labels: { stage: TOOL_REVIEW_METRIC_STAGES, host: SAFETY_METRIC_HOSTS },
    },
    ptc_child_bash_full_output_total: {
        type: 'counter',
        unit: 'count',
        help: 'Bash calls of a run_code child by what happened to their full output: restored (the child got all of it), over_limit (past PTC_CHILD_FULL_OUTPUT_MAX_BYTES, so it keeps the capped preview), or unavailable (nothing could be read back).',
        consumer: 'PTC owners, for full-output restore rate and limit investigations',
        labels: { outcome: PTC_CHILD_FULL_OUTPUT_OUTCOMES },
    },
};
export { LEGACY_METRIC_NAMES } from './legacy-metric-names.js';
/**
 * Add `delta` to a registered counter. A missing sink is a no-op and a
 * throwing sink is contained: metrics never break the caller.
 */
export function incrementMetric(sink, name, delta, labels) {
    if (!sink)
        return;
    try {
        sink.counter(name, delta, labels);
    }
    catch {
        // Metrics are a weak dependency.
    }
}
/** Record one observation of a registered histogram; fail-open like {@link incrementMetric}. */
export function observeMetric(sink, name, value, labels) {
    if (!sink)
        return;
    try {
        sink.histogram(name, value, labels);
    }
    catch {
        // Metrics are a weak dependency.
    }
}
/**
 * Busy time of concurrent operations as a registered `ms` counter, so its
 * `rate()` / 1000 is the average number running: on every change and every
 * report cycle (`onCollect`), add running operations × ms since the previous
 * accrual, per label set. A crash loses at most one report cycle; a gauge of
 * the running count would keep only the last client's value on the server.
 * Without a sink nothing is reported; a sink without `onCollect` accrues on
 * changes only. Never throws.
 */
export function createBusyTimeAccumulator(name, options) {
    const { sink, nowMs } = options;
    const running = new Map();
    let accruedAtMs = nowMs();
    const accrue = () => {
        try {
            const now = nowMs();
            const elapsedMs = now - accruedAtMs;
            accruedAtMs = now;
            if (!(elapsedMs > 0))
                return;
            for (const { labels, count } of running.values())
                incrementMetric(sink, name, count * elapsedMs, labels);
        }
        catch {
            // Metrics are a weak dependency.
        }
    };
    if (typeof sink?.onCollect === 'function')
        sink.onCollect(accrue);
    return {
        set(labels, count) {
            accrue();
            const key = JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
            if (count > 0)
                running.set(key, { labels, count });
            else
                running.delete(key);
        },
    };
}
/** The boundaries of a histogram definition. */
export function histogramBounds(definition) {
    return typeof definition.buckets === 'string'
        ? STANDARD_BUCKETS[definition.buckets]
        : definition.buckets.legacy;
}
/** Per-name bucket overrides for the registered histograms, for MetricsClient. */
export function registeredHistogramBucketsByName() {
    const buckets = {};
    for (const [name, definition] of Object.entries(METRIC_DEFINITIONS)) {
        if (definition.type !== 'histogram')
            continue;
        buckets[name] = [...histogramBounds(definition)];
    }
    return buckets;
}
//# sourceMappingURL=metric-registry.js.map