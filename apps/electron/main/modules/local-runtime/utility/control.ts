import { isCollectionPolicy } from "@mavis/shared/collection-policy";
import { parseWorkspaceIndexingObservation } from "../../observability/workspace-indexing";
/** IPC channel used to deliver a transport MessagePort to a renderer. */
export let RUNTIME_TRANSPORT_PORT_CHANNEL = 'runtime:transport-port';
/** IPC channels used to release the renderer's runtime startup gate. */
export let RUNTIME_READY_CHANNEL = 'runtime:ready';
export let RUNTIME_FAILED_CHANNEL = 'runtime:failed';
/**
 * IPC channel broadcast to renderers when the utility process is lost.
 * Mirrored as `IPC_CHANNELS.RUNTIME_TRANSPORT_LOST` in config/constants.ts
 * and the preload's inlined channel table — this module is the canonical
 * value (kept import-free of Electron-main config so runtime modules can be
 * unit-tested without an `app` global).
 */
export let RUNTIME_TRANSPORT_LOST_CHANNEL = 'runtime:transport-lost';
/** `serviceName` for the forked utility process (crash filtering). */
export let LOCAL_RUNTIME_UTILITY_SERVICE_NAME = 'mavis-local-runtime';
/**
 * Bootstrap milestones reported by the child, coarsest first. Main's stall
 * watchdog treats a FIRST-SEEN stage as proof the child is still doing work,
 * so the no-progress window restarts.
 *
 * `modules-runtime-v2-done` and `modules-common-done` report the two heavy ESM
 * graphs the child loads in a single Promise.all. Their completion order is
 * nondeterministic, so they deliberately share a rank (see
 * {@link utilityBootstrapStageRank}) and main must not treat either arrival
 * order as going backwards. `modules-loaded` stays as the terminal marker of
 * that phase, keeping the ordering contract with `sqlite-ready` intact.
 *
 * Keep this list short. Every stage is one more re-arm the watchdog grants,
 * which is why total bootstrap tolerance stays bounded by
 * (distinct stages + 1) x window instead of growing with the number of pings.
 */
export let UTILITY_BOOTSTRAP_STAGES = [
    'node-entry',
    'modules-runtime-v2-done',
    'modules-common-done',
    'modules-loaded',
    'sqlite-ready',
];
/**
 * The two module substages that make up the `modules-loaded` phase, in a fixed
 * declaration order so a stall diagnostic reads the same regardless of which
 * import actually won the race.
 */
export let UTILITY_MODULE_SUBSTAGES = [
    'modules-runtime-v2-done',
    'modules-common-done',
];
/**
 * Monotonic ordering used for forward-progress checks. NOT the array index:
 * the two module substages share a rank on purpose, because they resolve out
 * of one Promise.all and either may land first. Anything that ranks stages by
 * position in {@link UTILITY_BOOTSTRAP_STAGES} would discard the later of the
 * two arrivals as out-of-order and kill a child that was still making
 * progress.
 */
const UTILITY_BOOTSTRAP_STAGE_RANKS = {
    'node-entry': 0,
    'modules-runtime-v2-done': 1,
    'modules-common-done': 1,
    'modules-loaded': 2,
    'sqlite-ready': 3,
};
export function utilityBootstrapStageRank(stage) {
    return UTILITY_BOOTSTRAP_STAGE_RANKS[stage];
}
/**
 * Bound for {@link RuntimeInitFailedMessage.detail}. Shared with the
 * utility-side diagnostic formatter so the sender can never produce a value
 * the validator rejects (a rejected init-failed message would downgrade the
 * failure into a slower bootstrap-timeout recovery).
 */
export let MAX_RUNTIME_INIT_FAILURE_DETAIL_LENGTH = 2048;
export let DIAGNOSTICS_BROKER_METHODS = ['uploadDiagnosticBundle'];
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
const MAX_CLONE_DEPTH = 32;
const MAX_CLONE_NODES = 100000;
const MAX_CLONE_STRING_LENGTH = 16 * 1024 * 1024;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_APP_INSTANCE_ID = /^app_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
}
function hasMessageKeys(value, required, optional = []) {
    return (hasOnlyKeys(value, [...required, ...optional]) &&
        required.every((key) => Object.prototype.hasOwnProperty.call(value, key)));
}
export function isSafeBrokerRequestId(value) {
    return typeof value === 'string' && SAFE_REQUEST_ID.test(value);
}
function isSafeAppInstanceId(value) {
    return typeof value === 'string' && SAFE_APP_INSTANCE_ID.test(value);
}
/**
 * Accepts only what the utility-side diagnostic formatter can emit: a
 * non-empty single-line string without control characters, bounded by
 * {@link MAX_RUNTIME_INIT_FAILURE_DETAIL_LENGTH}.
 */
export function isSafeRuntimeInitFailureDetail(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_RUNTIME_INIT_FAILURE_DETAIL_LENGTH &&
        !/[\u0000-\u001f\u007f]/.test(value));
}
/**
 * The marker carries no free-form text on purpose, so validation reduces to
 * the pid. It stays optional (the conflict is proven by the fence, not by a
 * readable lease file), but a present pid must be a real one: main renders it
 * into an instruction naming the process the user should quit.
 */
export function isRuntimeInitOwnerConflictMarker(value) {
    if (!isRecord(value))
        return false;
    if (!hasMessageKeys(value, [], ['holderPid']))
        return false;
    return value.holderPid === undefined || isPositiveSafeInteger(value.holderPid);
}
/**
 * Broker payloads intentionally use a JSON-like subset of structured clone.
 * This excludes accessors, custom prototypes, cycles and executable values,
 * while retaining every value shape used by Browser and diagnostics results.
 */
export function isStrictStructuredCloneValue(value) {
    const ancestors = new Set();
    let nodes = 0;
    const visit = (candidate, depth) => {
        nodes += 1;
        if (nodes > MAX_CLONE_NODES || depth > MAX_CLONE_DEPTH)
            return false;
        if (candidate === null || candidate === undefined)
            return true;
        if (typeof candidate === 'string')
            return candidate.length <= MAX_CLONE_STRING_LENGTH;
        if (typeof candidate === 'boolean')
            return true;
        if (typeof candidate === 'number')
            return Number.isFinite(candidate);
        if (typeof candidate !== 'object')
            return false;
        if (ancestors.has(candidate))
            return false;
        if (Array.isArray(candidate)) {
            ancestors.add(candidate);
            const valid = candidate.every((item) => visit(item, depth + 1));
            ancestors.delete(candidate);
            return valid;
        }
        const prototype = Object.getPrototypeOf(candidate);
        if (prototype !== Object.prototype && prototype !== null)
            return false;
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        ancestors.add(candidate);
        for (const descriptor of Object.values(descriptors)) {
            if (!('value' in descriptor) || !visit(descriptor.value, depth + 1)) {
                ancestors.delete(candidate);
                return false;
            }
        }
        ancestors.delete(candidate);
        return true;
    };
    try {
        return visit(value, 0);
    }
    catch {
        return false;
    }
}
export function isStrictStructuredCloneRecord(value) {
    return isRecord(value) && !Array.isArray(value) && isStrictStructuredCloneValue(value);
}
function isRuntimeRoutingContext(value) {
    if (value === undefined)
        return true;
    if (!isRecord(value) || Array.isArray(value))
        return false;
    if (!hasOnlyKeys(value, ['bedrockLane']))
        return false;
    return value.bedrockLane === undefined || typeof value.bedrockLane === 'string';
}
function isUtilityEvalCaptureConfig(value) {
    if (value === undefined)
        return true;
    if (!isRecord(value) || !hasOnlyKeys(value, ['endpoint', 'sessionClioEnabled']))
        return false;
    if (typeof value.endpoint !== 'string')
        return false;
    if (value.sessionClioEnabled !== undefined && typeof value.sessionClioEnabled !== 'boolean') {
        return false;
    }
    try {
        return new URL(value.endpoint).protocol === 'https:';
    }
    catch {
        return false;
    }
}
function isUtilityRunawayGuardConfig(value) {
    return (isRecord(value) &&
        !Array.isArray(value) &&
        hasOnlyKeys(value, ['enabled']) &&
        (value.enabled === undefined || typeof value.enabled === 'boolean'));
}
/**
 * Main parses fields with `parsePromptSuggestionRemotePolicy` before posting,
 * so the utility boundary only checks the envelope shape. Staying lenient keeps
 * a newer field from failing `runtime-init` and blocking the runtime start.
 */
function isUtilityPromptSuggestionPolicy(value) {
    return isRecord(value) && !Array.isArray(value);
}
function isUtilityToolResultCompactionConfig(value) {
    if (value === undefined)
        return true;
    if (!isRecord(value) ||
        !hasOnlyKeys(value, [
            'enabled',
            'maxInlineBytes',
            'mcpDetailsMaxInlineBytes',
            'watermarkBytes',
            'minSavingsBytes',
            'minCandidateBytes',
            'keepRecentRounds',
            'checkpointSharedPrefix',
        ])) {
        return false;
    }
    return ((value.enabled === undefined || typeof value.enabled === 'boolean') &&
        (value.maxInlineBytes === undefined || isPositiveSafeInteger(value.maxInlineBytes)) &&
        (value.mcpDetailsMaxInlineBytes === undefined ||
            isPositiveSafeInteger(value.mcpDetailsMaxInlineBytes)) &&
        (value.watermarkBytes === undefined || isPositiveSafeInteger(value.watermarkBytes)) &&
        (value.minSavingsBytes === undefined || isPositiveSafeInteger(value.minSavingsBytes)) &&
        (value.minCandidateBytes === undefined || isPositiveSafeInteger(value.minCandidateBytes)) &&
        (value.keepRecentRounds === undefined || isPositiveSafeInteger(value.keepRecentRounds)) &&
        (value.checkpointSharedPrefix === undefined ||
            typeof value.checkpointSharedPrefix === 'boolean'));
}
function isPromptConfigKey(value) {
    return (value === undefined ||
        (Array.isArray(value) &&
            value.length === 32 &&
            value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)));
}
export function isUtilityControlMessage(value) {
    if (!isRecord(value))
        return false;
    switch (value.type) {
        case 'runtime-init':
            return (hasMessageKeys(value, ['type', 'dataDir', 'runtimeStartupToken', 'appVersion', 'hostCapabilities'], [
                'authContext',
                'promptConfigKey',
                'routingContext',
                'evalCapture',
                'contextWindowUsageEnabled',
                'toolResultCompactionConfig',
                'runawayGuardConfig',
                'promptSuggestionPolicy',
                'startupExecutionPolicy',
                'collectionPolicy',
                'computerUseGeneration',
            ]) &&
                typeof value.dataDir === 'string' &&
                value.dataDir.length > 0 &&
                typeof value.runtimeStartupToken === 'string' &&
                value.runtimeStartupToken.length > 0 &&
                typeof value.appVersion === 'string' &&
                value.appVersion.length > 0 &&
                (value.startupExecutionPolicy === undefined ||
                    value.startupExecutionPolicy === 'enabled' ||
                    value.startupExecutionPolicy === 'quarantined') &&
                isRecord(value.hostCapabilities) &&
                hasMessageKeys(value.hostCapabilities, ['browser', 'diagnostics'], ['miniAppSurface']) &&
                typeof value.hostCapabilities.browser === 'boolean' &&
                typeof value.hostCapabilities.diagnostics === 'boolean' &&
                (value.hostCapabilities.miniAppSurface === undefined ||
                    typeof value.hostCapabilities.miniAppSurface === 'boolean') &&
                isStrictStructuredCloneValue(value.authContext) &&
                isPromptConfigKey(value.promptConfigKey) &&
                isRuntimeRoutingContext(value.routingContext) &&
                isUtilityEvalCaptureConfig(value.evalCapture) &&
                isUtilityToolResultCompactionConfig(value.toolResultCompactionConfig) &&
                (value.runawayGuardConfig === undefined ||
                    isUtilityRunawayGuardConfig(value.runawayGuardConfig)) &&
                (value.promptSuggestionPolicy === undefined ||
                    isUtilityPromptSuggestionPolicy(value.promptSuggestionPolicy)) &&
                (value.collectionPolicy === undefined || isCollectionPolicy(value.collectionPolicy)) &&
                (value.contextWindowUsageEnabled === undefined ||
                    typeof value.contextWindowUsageEnabled === 'boolean') &&
                (value.computerUseGeneration === undefined ||
                    isPositiveSafeInteger(value.computerUseGeneration)));
        case 'runtime-auth-context':
            return (hasMessageKeys(value, ['type', 'requestId'], ['authContext']) &&
                isSafeBrokerRequestId(value.requestId) &&
                isStrictStructuredCloneValue(value.authContext));
        case 'runtime-routing-context':
            return (hasMessageKeys(value, ['type'], ['routingContext']) &&
                isRuntimeRoutingContext(value.routingContext));
        case 'runtime-shutdown':
            return (hasMessageKeys(value, ['type'], ['app_instance_id']) &&
                (value.app_instance_id === undefined || isSafeAppInstanceId(value.app_instance_id)));
        case 'runtime-context-window-usage':
            return hasMessageKeys(value, ['type', 'enabled']) && typeof value.enabled === 'boolean';
        case 'runtime-computer-use-connect':
            return (hasMessageKeys(value, ['type', 'generation']) && isPositiveSafeInteger(value.generation));
        case 'runtime-runaway-guard-config':
            return hasMessageKeys(value, ['type', 'config']) && isUtilityRunawayGuardConfig(value.config);
        case 'runtime-prompt-suggestion-policy':
            return (hasMessageKeys(value, ['type', 'policy']) && isUtilityPromptSuggestionPolicy(value.policy));
        case 'runtime-tool-result-compaction-config':
            return (hasMessageKeys(value, ['type', 'config']) &&
                isUtilityToolResultCompactionConfig(value.config));
        case 'runtime-collection-policy':
            return hasMessageKeys(value, ['type', 'policy']) && isCollectionPolicy(value.policy);
        case 'runtime-flush-logs':
            return hasMessageKeys(value, ['type', 'requestId']) && isSafeBrokerRequestId(value.requestId);
        case 'runtime-session-report-request':
            return (hasMessageKeys(value, ['type', 'requestId', 'sessionId']) &&
                isSafeBrokerRequestId(value.requestId) &&
                typeof value.sessionId === 'string' &&
                value.sessionId.length > 0 &&
                value.sessionId.length <= 512);
        case 'runtime-port-connect':
        case 'runtime-port-disconnect':
            return (hasMessageKeys(value, ['type', 'connectionId']) && isSafeBrokerRequestId(value.connectionId));
        default:
            return false;
    }
}
function isSkillRegistryDiagnosticEvent(value) {
    if (!isRecord(value))
        return false;
    if (!isNonNegativeSafeInteger(value.registryCacheCount))
        return false;
    switch (value.type) {
        case 'skill_registry_lru_close_begin':
            return hasMessageKeys(value, ['type', 'registryCacheCount']);
        case 'skill_registry_lru_close_end':
            return (hasMessageKeys(value, ['type', 'registryCacheCount', 'durationMs']) &&
                isNonNegativeSafeInteger(value.durationMs));
        default:
            return false;
    }
}
function isWorkspaceIndexingObservationMessage(value) {
    return (hasMessageKeys(value, ['type', 'ownerUserId', 'event']) &&
        typeof value.ownerUserId === 'string' &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(value.ownerUserId) &&
        isRecord(value.event) &&
        hasMessageKeys(value.event, ['stage', 'outcome', 'timestampMs'], ['kind', 'durationMs', 'fileCount', 'totalBytes']) &&
        parseWorkspaceIndexingObservation(value.event) !== undefined);
}
export function isUtilityStatusMessage(value) {
    if (!isRecord(value))
        return false;
    switch (value.type) {
        case 'runtime-ready':
        case 'runtime-drained':
            return hasMessageKeys(value, ['type']);
        case 'runtime-health':
            return (hasMessageKeys(value, ['type', 'sequence', 'heapUsedBytes', 'heapTotalBytes', 'heapSizeLimitBytes', 'rssBytes'], ['timestampMs', 'externalBytes', 'arrayBuffersBytes', 'cpuUserMicros', 'cpuSystemMicros']) &&
                isNonNegativeSafeInteger(value.sequence) &&
                (value.timestampMs === undefined || isPositiveSafeInteger(value.timestampMs)) &&
                isNonNegativeSafeInteger(value.heapUsedBytes) &&
                isNonNegativeSafeInteger(value.heapTotalBytes) &&
                isPositiveSafeInteger(value.heapSizeLimitBytes) &&
                isNonNegativeSafeInteger(value.rssBytes) &&
                (value.externalBytes === undefined || isNonNegativeSafeInteger(value.externalBytes)) &&
                (value.arrayBuffersBytes === undefined ||
                    isNonNegativeSafeInteger(value.arrayBuffersBytes)) &&
                (value.cpuUserMicros === undefined || isNonNegativeSafeInteger(value.cpuUserMicros)) &&
                (value.cpuSystemMicros === undefined || isNonNegativeSafeInteger(value.cpuSystemMicros)));
        case 'runtime-skill-registry-diagnostic':
            return (hasMessageKeys(value, ['type', 'event']) && isSkillRegistryDiagnosticEvent(value.event));
        case 'runtime-workspace-indexing-observation':
            return isWorkspaceIndexingObservationMessage(value);
        case 'runtime-database-migration':
            return (hasMessageKeys(value, ['type', 'event']) && isDatabaseMigrationObservation(value.event));
        case 'runtime-bootstrap-progress':
            return (hasMessageKeys(value, ['type', 'stage']) &&
                UTILITY_BOOTSTRAP_STAGES.includes(value.stage));
        case 'runtime-init-failed':
            return (hasMessageKeys(value, ['type', 'message'], ['detail', 'ownerConflict']) &&
                value.message === 'utility runtime initialization failed' &&
                (value.detail === undefined || isSafeRuntimeInitFailureDetail(value.detail)) &&
                (value.ownerConflict === undefined || isRuntimeInitOwnerConflictMarker(value.ownerConflict)));
        case 'runtime-auth-context-applied':
            return hasMessageKeys(value, ['type', 'requestId']) && isSafeBrokerRequestId(value.requestId);
        case 'runtime-logs-flushed':
            return hasMessageKeys(value, ['type', 'requestId']) && isSafeBrokerRequestId(value.requestId);
        case 'runtime-session-report-result':
            return (hasMessageKeys(value, ['type', 'requestId', 'report']) &&
                isSafeBrokerRequestId(value.requestId) &&
                isStrictStructuredCloneRecord(value.report));
        case 'runtime-session-report-error':
            return (hasMessageKeys(value, ['type', 'requestId', 'message']) &&
                isSafeBrokerRequestId(value.requestId) &&
                typeof value.message === 'string' &&
                value.message.length > 0 &&
                value.message.length <= 2048);
        case 'runtime-port-disconnected':
            return (hasMessageKeys(value, ['type', 'connectionId', 'released', 'abortedRequests']) &&
                isSafeBrokerRequestId(value.connectionId) &&
                typeof value.released === 'boolean' &&
                typeof value.abortedRequests === 'number' &&
                Number.isInteger(value.abortedRequests) &&
                value.abortedRequests >= 0);
        default:
            return false;
    }
}
function isNonNegativeSafeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isPositiveSafeInteger(value) {
    return isNonNegativeSafeInteger(value) && value > 0;
}
export let BROWSER_BROKER_ACTIONS = [
    'inspect',
    'query',
    'navigate',
    'open_tab',
    'back',
    'forward',
    'reload',
    'click',
    'click_and_wait_for_navigation',
    'double_click',
    'triple_click',
    'drag',
    'fill',
    'type',
    'press_key',
    'check',
    'uncheck',
    'select_option',
    'scroll',
    'hover',
    'wait',
    'wait_for',
    'get_dom',
    'screenshot',
    'upload_files',
    'paste',
    'verify_text',
    'inspect_editable_targets',
];
const BROWSER_ACTIONS = new Set(BROWSER_BROKER_ACTIONS);
export function isBrowserBrokerAction(value) {
    return (typeof value === 'string' && BROWSER_ACTIONS.has(value));
}
export function isBrowserBrokerRequestMessage(value) {
    if (!isRecord(value) || value.type !== 'browser-request')
        return false;
    if (!hasMessageKeys(value, ['type', 'requestId', 'context', 'action', 'input']))
        return false;
    if (!isSafeBrokerRequestId(value.requestId))
        return false;
    if (!isRecord(value.context) || Array.isArray(value.context))
        return false;
    if (!hasMessageKeys(value.context, ['sessionId', 'turnId'], ['toolCallId', 'browserAssets'])) {
        return false;
    }
    if (typeof value.context.sessionId !== 'string' || value.context.sessionId.length === 0) {
        return false;
    }
    if (typeof value.context.turnId !== 'string' || value.context.turnId.length === 0)
        return false;
    if (value.context.toolCallId !== undefined && typeof value.context.toolCallId !== 'string') {
        return false;
    }
    if (value.context.browserAssets !== undefined) {
        if (!Array.isArray(value.context.browserAssets) || value.context.browserAssets.length > 20) {
            return false;
        }
        for (const asset of value.context.browserAssets) {
            if (!isRecord(asset) || Array.isArray(asset))
                return false;
            if (!hasMessageKeys(asset, ['filePath', 'fileName', 'mimeType']))
                return false;
            if (typeof asset.filePath !== 'string' ||
                asset.filePath.length === 0 ||
                typeof asset.fileName !== 'string' ||
                asset.fileName.length === 0 ||
                typeof asset.mimeType !== 'string') {
                return false;
            }
        }
    }
    return (typeof value.action === 'string' &&
        isBrowserBrokerAction(value.action) &&
        isStrictStructuredCloneRecord(value.input));
}
export function isBrowserBrokerAbortMessage(value) {
    return (isRecord(value) &&
        value.type === 'browser-abort' &&
        hasMessageKeys(value, ['type', 'requestId']) &&
        isSafeBrokerRequestId(value.requestId));
}
export function isBrowserBrokerResultMessage(value) {
    return (isRecord(value) &&
        value.type === 'browser-result' &&
        hasMessageKeys(value, ['type', 'requestId', 'result']) &&
        isSafeBrokerRequestId(value.requestId) &&
        Object.prototype.hasOwnProperty.call(value, 'result') &&
        isStrictStructuredCloneValue(value.result));
}
const BROWSER_ERROR_CODES = new Set([
    'aborted',
    'ambiguous_target',
    'browser_action_failed',
    'browser_operation_timeout',
    'browser_result_too_large',
    'browser_session_poisoned',
    'background_render_busy',
    'background_render_operation_timeout',
    'background_render_queue_timeout',
    'browser_unavailable',
    'current_tab_occupied',
    'duplicate_request',
    'frame_coordinates_unavailable',
    'invalid_request',
    'invalid_result',
    'snapshot_continuation_mismatch',
    'snapshot_kind_mismatch',
    'stale_element_ref',
    'stale_snapshot',
]);
const BROWSER_ERROR_MESSAGES = {
    aborted: 'Operation aborted',
    ambiguous_target: 'AMBIGUOUS_TARGET: Browser target is not unique; inspect and narrow it',
    browser_action_failed: 'Browser action failed in Electron main',
    browser_operation_timeout: 'Browser action timed out',
    browser_result_too_large: 'BROWSER_RESULT_TOO_LARGE: Browser result exceeded the safe response budget',
    browser_session_poisoned: 'BROWSER_SESSION_POISONED: Browser recovery could not isolate the previous action; open a new Browser tab and inspect it before continuing',
    background_render_busy: 'Background Browser render queue is busy',
    background_render_operation_timeout: 'Background Browser action timed out',
    background_render_queue_timeout: 'Background Browser render queue wait timed out',
    browser_unavailable: 'Browser broker is unavailable',
    current_tab_occupied: 'CURRENT_TAB_OCCUPIED: Current Browser tab already has a loaded page; retry with open_tab, or set replaceCurrentTab=true only when the user explicitly asked to reuse the current tab',
    duplicate_request: 'Duplicate Browser broker request',
    frame_coordinates_unavailable: 'FRAME_COORDINATES_UNAVAILABLE: Browser cannot safely address this frame by viewport coordinates; inspect the current page and choose a main-frame target',
    invalid_request: 'Invalid Browser broker request',
    invalid_result: 'Invalid Browser broker result',
    snapshot_continuation_mismatch: 'SNAPSHOT_CONTINUATION_MISMATCH: Continue with the exact nextOffset returned by Browser',
    snapshot_kind_mismatch: 'SNAPSHOT_KIND_MISMATCH: Continue the observation with its original Browser action',
    stale_element_ref: 'STALE_ELEMENT_REF: Browser target expired; inspect the current page again',
    stale_snapshot: 'STALE_SNAPSHOT: Browser observation expired; inspect the current page again',
};
export function isBrowserBrokerErrorMessage(value) {
    return (isRecord(value) &&
        value.type === 'browser-error' &&
        hasMessageKeys(value, ['type', 'requestId', 'code', 'message'], ['label', 'timeoutMs']) &&
        isSafeBrokerRequestId(value.requestId) &&
        typeof value.code === 'string' &&
        BROWSER_ERROR_CODES.has(value.code) &&
        value.message === BROWSER_ERROR_MESSAGES[value.code] &&
        (value.label === undefined ||
            (typeof value.label === 'string' && value.label.length > 0 && value.label.length <= 200)) &&
        (value.timeoutMs === undefined ||
            (typeof value.timeoutMs === 'number' &&
                Number.isFinite(value.timeoutMs) &&
                value.timeoutMs > 0)));
}
export function isDiagnosticsBrokerRequestMessage(value) {
    return (isRecord(value) &&
        value.type === 'diagnostics-request' &&
        hasMessageKeys(value, ['type', 'requestId', 'method'], ['body']) &&
        isSafeBrokerRequestId(value.requestId) &&
        typeof value.method === 'string' &&
        value.method.length > 0 &&
        (value.body === undefined || isStrictStructuredCloneRecord(value.body)));
}
export function isDiagnosticsBrokerResultMessage(value) {
    return (isRecord(value) &&
        value.type === 'diagnostics-result' &&
        hasMessageKeys(value, ['type', 'requestId', 'result']) &&
        isSafeBrokerRequestId(value.requestId) &&
        isStrictStructuredCloneRecord(value.result));
}
const DIAGNOSTICS_ERROR_CODES = new Set([
    'diagnostics_request_failed',
    'duplicate_request',
    'invalid_request',
    'invalid_result',
    'unsupported_method',
]);
const DIAGNOSTICS_ERROR_MESSAGES = {
    diagnostics_request_failed: 'Electron diagnostics request failed',
    duplicate_request: 'Duplicate diagnostics broker request',
    invalid_request: 'Invalid diagnostics broker request',
    invalid_result: 'Invalid diagnostics broker result',
    unsupported_method: 'Unsupported diagnostics broker method',
};
export function isDiagnosticsBrokerErrorMessage(value) {
    return (isRecord(value) &&
        value.type === 'diagnostics-error' &&
        hasMessageKeys(value, ['type', 'requestId', 'code', 'message']) &&
        isSafeBrokerRequestId(value.requestId) &&
        typeof value.code === 'string' &&
        DIAGNOSTICS_ERROR_CODES.has(value.code) &&
        value.message === DIAGNOSTICS_ERROR_MESSAGES[value.code]);
}
export function isAuthRecoveryRequestMessage(value) {
    return (isRecord(value) &&
        hasMessageKeys(value, ['type', 'requestId', 'rejectedAccessToken'], ['loginEpoch']) &&
        value.type === 'auth-recovery-request' &&
        isSafeBrokerRequestId(value.requestId) &&
        typeof value.rejectedAccessToken === 'string' &&
        value.rejectedAccessToken.length > 0 &&
        value.rejectedAccessToken.length <= 16384 &&
        (value.loginEpoch === undefined ||
            (typeof value.loginEpoch === 'string' &&
                value.loginEpoch.length > 0 &&
                value.loginEpoch.length <= 256)));
}
export function isAuthRecoveryResultMessage(value) {
    return (isRecord(value) &&
        hasMessageKeys(value, ['type', 'requestId'], ['authContext']) &&
        value.type === 'auth-recovery-result' &&
        isSafeBrokerRequestId(value.requestId) &&
        isStrictStructuredCloneValue(value.authContext));
}
export function isAuthRecoveryErrorMessage(value) {
    return (isRecord(value) &&
        hasMessageKeys(value, ['type', 'requestId', 'message']) &&
        value.type === 'auth-recovery-error' &&
        isSafeBrokerRequestId(value.requestId) &&
        value.message === 'Desktop auth recovery failed');
}
function isDatabaseMigrationObservation(value) {
    if (!isRecord(value))
        return false;
    if (!hasMessageKeys(value, ['phase', 'startedAtEpochMs', 'pendingMigrationCount'], ['durationMs']))
        return false;
    if (typeof value.startedAtEpochMs !== 'number' ||
        !Number.isFinite(value.startedAtEpochMs) ||
        value.startedAtEpochMs < 0)
        return false;
    if (!isNonNegativeSafeInteger(value.pendingMigrationCount))
        return false;
    if (value.phase === 'started')
        return value.durationMs === undefined;
    return ((value.phase === 'completed' || value.phase === 'failed') &&
        typeof value.durationMs === 'number' &&
        Number.isFinite(value.durationMs) &&
        value.durationMs >= 0);
}
