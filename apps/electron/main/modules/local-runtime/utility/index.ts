/**
 * Utility-process runtime wiring for Electron main.
 *
 * Bridges the always-on utility-process runtime into the existing local-runtime
 * module surface:
 * - `ensureUtilityRuntimeStarted` / `stopUtilityRuntime` own the singleton
 *   `LocalRuntimeUtilityProcessManager`.
 * - `fetchViaUtilityRuntime` gives each main-process consumer its own lazy
 *   MessagePort into the utility so app:// protocol traffic and Remote
 *   Control cannot head-of-line block each other. The protocol handler keeps
 *   serving element-src binaries
 *   (plane B) and any stray API calls during the transition. This is a
 *   TRANSITIONAL forward: the endgame per proposal §2.2 (B1) is main
 *   reading assets from disk directly; renderer JS traffic already rides
 *   its own direct port and never passes through here.
 * - `connectRendererToUtilityRuntime` hands a fresh MessagePort pair to a
 *   renderer (invoked from the RUNTIME_TRANSPORT_REQUEST_PORT IPC handler).
 * - On unexpected utility exit the manager refork kicks in and
 *   RUNTIME_TRANSPORT_LOST is broadcast so renderers fail in-flight
 *   streams and re-request ports.
 */

import { getConfig } from "@mavis/config";
import { DEFAULT_COLLECTION_POLICY } from "@mavis/shared/collection-policy";
import logger from "../../../utils/logger";
import { destroyAllManagedMiniAppTabs } from "../../browser/embedded-browser-manager";
import { enqueueElectronObservabilityEvent, isElectronObservabilityShuttingDown, getElectronObservabilityAppInstanceId } from "../../observability/outbox";
import { recordElectronStartupRuntimeReady } from "../../observability/startup-performance";
import { resolveLocalRuntimeDataDir } from "../data-dir";
import { prepareLocalRuntimeNativeSqliteEnv } from "../native-sqlite-env";
import { resolveLocalRuntimeLaunchPlan } from "../test-data-isolation";
import { resetUtilityRuntimeStartBlockForTests, isUtilityRuntimeStartBlocked } from "../runtime-start-guard";
export { blockUtilityRuntimeStart, isUtilityRuntimeStartBlocked } from "../runtime-start-guard";

import { LocalRuntimeUtilityProcessManager } from "./utility-process-manager";
import { releaseComputerUseLease, resetComputerUseRuntimeForTests, takeComputerUseChannel, ensureComputerUseUtilityStarted as computerUseEnsureComputerUseUtilityStarted, attachPendingComputerUseChannel, stopComputerUseUtility } from "../computer-use";
export { releaseComputerUseLease };
import { createExecutionContinuity } from "./execution-continuity";
import { RUNTIME_TRANSPORT_LOST_CHANNEL } from "./control";
import { serveUtilityPlaneBRequest } from "./plane-b";
import { resolveUtilityProxyEnv } from "./proxy-env";
import { UtilityRuntimeObserver } from "./utility-runtime-observer";
import { configureUtilityRuntimeDiagnosticsLogger, utilityRuntimeDiagnostics } from "./utility-runtime-diagnostics";
import { DEFAULT_RUNTIME_MEMORY_MONITOR_INTERVAL_MS, MIN_RUNTIME_MEMORY_MONITOR_INTERVAL_MS, MAX_RUNTIME_MEMORY_MONITOR_INTERVAL_MS } from "./runtime-memory-monitor-contract";
let hooks = null;
let routingContext;
configureUtilityRuntimeDiagnosticsLogger(logger);
export function registerUtilityRuntimeMainHooks(next) {
    hooks = next;
}
/** Test-only: reset manager singletons. */
export function resetUtilityRuntimeForTests() {
    manager = null;
    resetComputerUseRuntimeForTests();
    executionContinuityController?.dispose();
    executionContinuityController = null;
    mainFetchPromises.clear();
    mainLinkGenerations.clear();
    mainLinkSequence += 1;
    runtimeFailReason = null;
    runtimeNotificationQueue = Promise.resolve();
    resetUtilityRuntimeStartBlockForTests();
    routingContext = undefined;
    runtimeMemoryRecording = false;
    runtimeMemoryIntervalMs = DEFAULT_RUNTIME_MEMORY_MONITOR_INTERVAL_MS;
    runtimeMemorySamples = [];
    runtimeHeapSamplingStartedAtMs = null;
    lastRuntimeHeapProfile = null;
    utilityRuntimeDiagnostics.reset();
}
let manager = null;
let executionContinuityController = null;
const DEFAULT_TRANSPORT_CONSUMER = 'default';
const mainFetchPromises = new Map();
const mainLinkGenerations = new Map();
let mainLinkSequence = 0;
let runtimeFailReason = null;
let runtimeNotificationQueue = Promise.resolve();
const MAX_RUNTIME_MEMORY_SAMPLES = 1200;
let runtimeMemoryRecording = false;
let runtimeMemoryIntervalMs = DEFAULT_RUNTIME_MEMORY_MONITOR_INTERVAL_MS;
let runtimeMemorySamples = [];
let runtimeHeapSamplingStartedAtMs = null;
let lastRuntimeHeapProfile = null;
let runtimeTransportModulePromise = null;
function appendRuntimeMemorySample(sample) {
    const { type: _type, ...persisted } = sample;
    runtimeMemorySamples.push(persisted);
    if (runtimeMemorySamples.length > MAX_RUNTIME_MEMORY_SAMPLES) {
        runtimeMemorySamples = runtimeMemorySamples.slice(-MAX_RUNTIME_MEMORY_SAMPLES);
    }
}
function rememberRuntimeHeapProfile(profile) {
    const summary = {
        profilePath: profile.profilePath,
        sampleCount: profile.sampleCount,
        sampledBytes: profile.sampledBytes,
        startedAtMs: profile.startedAtMs,
        stoppedAtMs: profile.stoppedAtMs,
    };
    lastRuntimeHeapProfile = summary;
    return summary;
}
function importEsm(specifier) {
    if (process.env.VITEST === 'true') {
        return import(specifier);
    }
    // eslint-disable-next-line no-new-func -- Preserve native dynamic import in Electron's CJS main process.
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    return dynamicImport(specifier);
}
/**
 * Lazy dynamic import for `@mavis/shared/runtime-transport`: `@mavis/shared`
 * is ESM-only while Electron main is compiled to CommonJS, so a static value
 * import would become `require(...)` and crash at main-process module load.
 */
function loadRuntimeTransportModule() {
    if (!runtimeTransportModulePromise) {
        runtimeTransportModulePromise = importEsm('@mavis/shared/runtime-transport');
    }
    return runtimeTransportModulePromise;
}
/**
 * Serializes renderer lifecycle pushes in manager callback order. Manager
 * callbacks are synchronous, but both delivery paths cross lazy async module
 * boundaries; without one queue a terminal failure can overtake runtime-lost.
 */
function enqueueRuntimeNotification(label, send) {
    runtimeNotificationQueue = runtimeNotificationQueue.then(send).catch(() => {
        logger.error(`[UtilityRuntime] ${label} broadcast failed`);
    });
}
function broadcastRuntimeLost(info) {
    mainFetchPromises.clear();
    mainLinkGenerations.clear();
    mainLinkSequence += 1;
    // Lazy electron import: a static one would throw at module load in
    // binary-less environments (CI unit runners) via electron/index.js.
    enqueueRuntimeNotification('runtime-lost', async () => {
        const { BrowserWindow } = await import('electron');
        for (const window of BrowserWindow.getAllWindows()) {
            try {
                window.webContents.send(RUNTIME_TRANSPORT_LOST_CHANNEL, info);
            }
            catch {
                logger.warn('[UtilityRuntime] runtime-lost broadcast failed');
            }
        }
    });
}
/**
 * Pushes a terminal supervisor verdict to every open window. The startup path
 * sends RUNTIME_FAILED once from window creation; a mid-session latch
 * (crash-loop breaker) happens long after that, so without this push the
 * renderer would only ever see a generic transport-lost and keep polling a
 * runtime that is not coming back.
 */
function broadcastRuntimeFailed(failReason) {
    if (!hooks) {
        // Only reachable when this module is driven directly (unit tests); in the
        // app the local-runtime module registers hooks at import time. Log rather
        // than drop silently — an unreported terminal verdict is the exact
        // failure mode the crash-loop breaker exists to eliminate.
        logger.error(`[UtilityRuntime] terminal verdict not broadcast (no main hooks): ${failReason.message}`);
        return;
    }
    const registeredHooks = hooks;
    enqueueRuntimeNotification('runtime-failed', () => registeredHooks.broadcastRuntimeFailed(failReason));
}
function failureTypeForReasonCode(reasonCode) {
    if (reasonCode === 'crash_loop')
        return 'runtime_crash_loop';
    if (reasonCode === 'memory_pressure' ||
        reasonCode === 'runtime_unresponsive' ||
        reasonCode === 'oom') {
        return 'runtime_recovery_failed';
    }
    return 'startup_error';
}
function getManager() {
    if (manager)
        return manager;
    const launchPlan = resolveLocalRuntimeLaunchPlan(process.env.NEXT_PUBLIC_BUILD_ENV, process.env.MAVIS_LOCAL_RUNTIME_ISOLATION);
    const lifecycleObserver = new UtilityRuntimeObserver({
        emit: enqueueElectronObservabilityEvent,
        isQuitInProgress: isElectronObservabilityShuttingDown,
    });
    executionContinuityController ?? (executionContinuityController = createExecutionContinuity());
    manager = new LocalRuntimeUtilityProcessManager({
        bootstrapTimeoutMs: launchPlan.utilityBootstrapTimeoutMs,
        ...(isUtilityRuntimeHealthRecoveryDisabled() ? { runtimeHealthTimeoutMs: false } : {}),
        executionContinuity: executionContinuityController.continuity,
        resolveDataDir: resolveLocalRuntimeDataDir,
        buildEnv: async () => {
            await hooks?.prepareForkEnv();
            try {
                prepareLocalRuntimeNativeSqliteEnv();
            }
            catch {
                logger.warn('[UtilityRuntime] native sqlite env prepare failed');
            }
            // Managed-env / sqlite mutations above land on process.env (merged by
            // the manager); the proxy env is fork-specific (§2.6): OS/PAC proxy
            // resolved once through Chromium, loopback pinned into NO_PROXY.
            return resolveUtilityProxyEnv(undefined, process.env, (message) => logger.warn(`[UtilityRuntime] ${message}`));
        },
        getAuthContext: () => hooks?.getAuthContext(),
        recoverAuthContext: (rejectedAccessToken, loginEpoch) => hooks?.recoverAuthContext?.(rejectedAccessToken, loginEpoch),
        getPromptConfigKey: () => hooks?.getPromptConfigKey?.(),
        getRoutingContext: () => routingContext,
        getContextWindowUsageEnabled: () => hooks?.getContextWindowUsageEnabled?.() === true,
        getComputerUseChannel: takeComputerUseChannel,
        ensureComputerUseReady: () => computerUseEnsureComputerUseUtilityStarted({
            canAcceptRuntimeChannel: () => manager?.canAcceptComputerUseChannel() ?? false,
            connectRuntimeChannel: (channel) => manager?.connectComputerUseChannel(channel) ?? false,
        }),
        getRunawayGuardConfig: () => hooks?.getRunawayGuardConfig?.() ?? {},
        getPromptSuggestionPolicy: () => hooks?.getPromptSuggestionPolicy?.() ?? {},
        getToolResultCompactionConfig: () => hooks?.getToolResultCompactionConfig?.() ?? {},
        getCollectionPolicy: () => hooks?.getCollectionPolicy?.() ?? DEFAULT_COLLECTION_POLICY,
        getStartupExecutionPolicy: () => hooks?.getStartupExecutionPolicy?.(),
        getAppVersion: () => hooks?.getAppVersion() ?? 'unknown',
        appInstanceId: getElectronObservabilityAppInstanceId(),
        resolveIsEnglishLocale: () => hooks?.isEnglishLocale?.() ?? true,
        getEvalCaptureConfig: () => hooks?.getEvalCaptureConfig(),
        getBrowserAdapter: () => hooks?.getBrowserAdapter(),
        ...(hooks?.openMiniAppSurface ? { openMiniAppSurface: hooks.openMiniAppSurface } : {}),
        ...(hooks?.closeMiniAppSurface ? { closeMiniAppSurface: hooks.closeMiniAppSurface } : {}),
        ...(hooks?.requestMiniAppToolApproval
            ? { requestMiniAppToolApproval: hooks.requestMiniAppToolApproval }
            : {}),
        isMiniAppSurfaceEnabled: () => getConfig().beta.filePanelBrowser === true,
        onMiniAppGenerationLost: () => {
            destroyAllManagedMiniAppTabs();
        },
        getHostDiagnosticsProvider: () => hooks?.getHostDiagnosticsProvider(),
        onRuntimeMemorySample: appendRuntimeMemorySample,
        onRuntimeHealthSample: (sample) => utilityRuntimeDiagnostics.recordHealth(sample),
        onSkillRegistryDiagnostic: (diagnostic) => utilityRuntimeDiagnostics.recordSkillRegistryDiagnostic(diagnostic),
        onWorkspaceIndexingObservation: ({ ownerUserId, event }) => {
            const auth = hooks?.getAuthContext();
            if (!auth ||
                typeof auth !== 'object' ||
                !('realUserID' in auth) ||
                auth.realUserID !== ownerUserId)
                return;
            enqueueElectronObservabilityEvent('workspace_indexing.state', {
                ...event,
                owner_user_id: ownerUserId,
            });
        },
        onRuntimeReady: () => {
            runtimeFailReason = null;
            // CUA may finish first while local-runtime is still starting. Reconcile
            // the pending transferred port as soon as the runtime publishes ready;
            // otherwise the CUA activation would report success but leave v2 on the
            // unavailable client until a later activation.
            attachPendingComputerUseChannel({
                canAcceptRuntimeChannel: () => manager?.canAcceptComputerUseChannel() ?? false,
                connectRuntimeChannel: (channel) => manager?.connectComputerUseChannel(channel) ?? false,
            });
            if (runtimeMemoryRecording) {
                void manager
                    ?.configureRuntimeMemoryMonitoring(true, runtimeMemoryIntervalMs)
                    .catch(() => logger.warn('[UtilityRuntime] memory monitor resume failed'));
            }
            recordElectronStartupRuntimeReady();
        },
        onRuntimeFailed: ({ message, terminal, reasonCode }) => {
            runtimeFailReason = message;
            // A terminal verdict must reach windows that are already open; the
            // once-per-window startup push cannot see a mid-session latch.
            if (terminal) {
                broadcastRuntimeFailed({
                    type: failureTypeForReasonCode(reasonCode),
                    message,
                });
            }
        },
        onRuntimeLost: (info) => {
            runtimeHeapSamplingStartedAtMs = null;
            broadcastRuntimeLost(info);
            utilityRuntimeDiagnostics.writeSnapshot('runtime_lost');
        },
        lifecycleObserver,
        logger: logger,
    });
    return manager;
}
const UTILITY_RUNTIME_HEALTH_RECOVERY_KILL_SWITCH = 'MAVIS_ELECTRON_DISABLE_UTILITY_HEALTH_RECOVERY';
/** Emergency rollback only: `1` disables post-ready no-health recycling. */
export function isUtilityRuntimeHealthRecoveryDisabled(env = process.env) {
    return env[UTILITY_RUNTIME_HEALTH_RECOVERY_KILL_SWITCH] === '1';
}
export async function ensureUtilityRuntimeStarted(options = {}) {
    if (isUtilityRuntimeStartBlocked())
        return false;
    return getManager().ensureStarted(options);
}
/** Lazily starts the sibling CUA utility after a conversation explicitly opts
 * into Computer Use. Failure is soft: local-runtime-v2 remains healthy. */
export async function ensureComputerUseUtilityStarted() {
    if (isUtilityRuntimeStartBlocked())
        return false;
    return computerUseEnsureComputerUseUtilityStarted({
        canAcceptRuntimeChannel: () => getManager().canAcceptComputerUseChannel(),
        connectRuntimeChannel: (channel) => getManager().connectComputerUseChannel(channel),
    });
}
export async function requestUtilityMiniApp(method, pluginId, signal) {
    assertMiniAppRuntimeStartable();
    return getManager().requestMiniApp(method, pluginId, signal);
}
export async function setUtilityMiniAppPermission(input) {
    assertMiniAppRuntimeStartable();
    return getManager().setMiniAppPermission(input);
}
export async function runUtilityMiniAppAgent(input, options) {
    assertMiniAppRuntimeStartable();
    return getManager().runMiniAppAgent(input, options);
}
export async function replyUtilityMiniAppAgent(input) {
    assertMiniAppRuntimeStartable();
    return getManager().replyMiniAppAgent(input);
}
export async function openUtilityMiniAppAgent(input) {
    assertMiniAppRuntimeStartable();
    return getManager().openMiniAppAgent(input);
}
export async function modelsUtilityMiniAppAgent(input) {
    assertMiniAppRuntimeStartable();
    return getManager().modelsMiniAppAgent(input);
}
export async function agentsUtilityMiniAppAgent(input) {
    assertMiniAppRuntimeStartable();
    return getManager().agentsMiniAppAgent(input);
}
/** Page-path `tool.request`; `pluginId` was resolved by Main from the sending tab. */
export async function requestUtilityMiniAppTools(input) {
    assertMiniAppRuntimeStartable();
    return getManager().requestMiniAppTools(input);
}
export async function createUtilityMiniAppAgent(input) {
    assertMiniAppRuntimeStartable();
    return getManager().createMiniAppAgent(input);
}
/** Host side panel now shows `sessionId`, so its asks can wait for an answer there. */
export async function panelOpenedUtilityMiniAppAgent(input) {
    assertMiniAppRuntimeStartable();
    return getManager().reportMiniAppAgentPanel('agent.panelOpened', input);
}
/** Host side panel no longer shows `sessionId`. */
export async function panelClosedUtilityMiniAppAgent(input) {
    assertMiniAppRuntimeStartable();
    return getManager().reportMiniAppAgentPanel('agent.panelClosed', input);
}
export async function answerUtilityMiniAppAgent(input, options) {
    assertMiniAppRuntimeStartable();
    return getManager().answerMiniAppAgent(input, options);
}
/** Page-path observer; settles when the subscription ends. */
export async function observeUtilityMiniAppAgent(input, options) {
    assertMiniAppRuntimeStartable();
    return getManager().observeMiniAppAgent(input, options);
}
export async function listUtilityMiniAppAgentSessions(input) {
    assertMiniAppRuntimeStartable();
    return getManager().listMiniAppAgentSessions(input);
}
export async function getUtilityMiniAppAgentSession(input) {
    assertMiniAppRuntimeStartable();
    return getManager().getMiniAppAgentSession(input);
}
function assertMiniAppRuntimeStartable() {
    if (isUtilityRuntimeStartBlocked()) {
        throw Object.assign(new Error('Mini App runtime is unavailable'), {
            code: 'runtime_unavailable',
        });
    }
}
export function isUtilityRuntimeReady() {
    return manager?.isReady() ?? false;
}
export function getUtilityRuntimeStartupToken() {
    return manager?.getStartupToken() ?? null;
}
export function getUtilityRuntimeProcessId() {
    return manager?.getProcessId() ?? null;
}
export function getUtilityRuntimeMemoryMonitorState() {
    return {
        ready: manager?.isReady() ?? false,
        recording: runtimeMemoryRecording,
        intervalMs: runtimeMemoryIntervalMs,
        processId: manager?.getProcessId() ?? null,
        startupToken: manager?.getStartupToken() ?? null,
        heapSamplingStartedAtMs: runtimeHeapSamplingStartedAtMs,
        lastProfile: lastRuntimeHeapProfile ? { ...lastRuntimeHeapProfile } : null,
        samples: runtimeMemorySamples.map((sample) => ({ ...sample })),
    };
}
export async function setUtilityRuntimeMemoryRecording(enabled, intervalMs = DEFAULT_RUNTIME_MEMORY_MONITOR_INTERVAL_MS) {
    if (!Number.isSafeInteger(intervalMs) ||
        intervalMs < MIN_RUNTIME_MEMORY_MONITOR_INTERVAL_MS ||
        intervalMs > MAX_RUNTIME_MEMORY_MONITOR_INTERVAL_MS) {
        throw new Error('invalid local runtime memory monitor interval');
    }
    runtimeMemoryIntervalMs = intervalMs;
    if (enabled) {
        const ready = await ensureUtilityRuntimeStarted();
        if (!ready)
            throw new Error('local runtime is not ready');
        await getManager().configureRuntimeMemoryMonitoring(true, intervalMs);
        runtimeMemoryRecording = true;
    }
    else {
        runtimeMemoryRecording = false;
        if (manager?.isReady()) {
            await manager.configureRuntimeMemoryMonitoring(false, intervalMs);
        }
    }
    return getUtilityRuntimeMemoryMonitorState();
}
export function clearUtilityRuntimeMemorySamples() {
    runtimeMemorySamples = [];
    return getUtilityRuntimeMemoryMonitorState();
}
export async function startUtilityRuntimeHeapSampling() {
    const ready = await ensureUtilityRuntimeStarted();
    if (!ready)
        throw new Error('local runtime is not ready');
    const started = await getManager().startRuntimeHeapSampling();
    runtimeHeapSamplingStartedAtMs = started.startedAtMs;
    return getUtilityRuntimeMemoryMonitorState();
}
export async function stopUtilityRuntimeHeapSampling() {
    if (!manager?.isReady())
        throw new Error('local runtime is not ready');
    const stopped = await manager.stopRuntimeHeapSampling();
    runtimeHeapSamplingStartedAtMs = null;
    rememberRuntimeHeapProfile(stopped);
    return getUtilityRuntimeMemoryMonitorState();
}
export function getUtilityRuntimeFailReason() {
    // A latched terminal failure outranks the transient message variable:
    // stopUtilityRuntime() clears the latter, but a latched manager is still
    // not coming back — losing the reason would leave the UI loading forever.
    return manager?.getTerminalFailure()?.message ?? runtimeFailReason;
}
/**
 * Structured terminal verdict (crash-loop breaker, init-failure latch), or
 * null while the runtime is not terminally failed. Unlike the string fail
 * reason this survives stop()/start cycles for as long as the latch does.
 */
export function getUtilityRuntimeTerminalFailure() {
    return manager?.getTerminalFailure() ?? null;
}
export async function setUtilityRuntimeAuthContext(authContext) {
    await manager?.setAuthContext(authContext);
}
/** Updates the main-owned managed-backend routing snapshot and live utility. */
export function setUtilityRuntimeRoutingContext(next) {
    routingContext = next;
    manager?.setRoutingContext(next);
}
export function setUtilityRuntimeContextWindowUsageEnabled(enabled) {
    manager?.setContextWindowUsageEnabled(enabled);
}
export function setUtilityRuntimeRunawayGuardConfig(config) {
    manager?.setRunawayGuardConfig(config);
}
export function setUtilityRuntimePromptSuggestionPolicy(policy) {
    manager?.setPromptSuggestionPolicy(policy);
}
export function setUtilityRuntimeToolResultCompactionConfig(config) {
    manager?.setToolResultCompactionConfig(config);
}
/** Publishes the main-owned effective collection policy to the live utility. */
export function setUtilityRuntimeCollectionPolicy(policy) {
    manager?.setCollectionPolicy(policy);
}
/**
 * Flushes the utility-owned disk log transports before a feedback upload
 * reads the log directory. Resolves `false` when no utility runtime is
 * running (nothing to flush) or the flush ACK misses its deadline; the
 * upload proceeds either way.
 */
export async function flushUtilityRuntimeLogs() {
    if (!manager)
        return false;
    return manager.flushLogs();
}
export async function collectUtilityRuntimeSessionReport(sessionId) {
    if (!manager)
        throw new Error('session_report_runtime_unavailable');
    return manager.collectSessionReport(sessionId);
}
export async function stopUtilityRuntime() {
    if (!manager) {
        stopComputerUseUtility();
        runtimeFailReason = null;
        runtimeHeapSamplingStartedAtMs = null;
        return { status: 'exited' };
    }
    try {
        return await manager.stop();
    }
    finally {
        stopComputerUseUtility();
        runtimeFailReason = null;
        runtimeHeapSamplingStartedAtMs = null;
    }
}
/**
 * Renderer port hand-off: returns whether a MessagePort pair was delivered.
 * The renderer resolves its `requestPort()` bridge call against this result
 * and then waits for the port on RUNTIME_TRANSPORT_PORT_CHANNEL.
 * `terminal: true` tells the renderer the runtime is latched failed and
 * reconnect polling is pointless (RUNTIME_FAILED owns the user-facing UX).
 */
export async function connectRendererToUtilityRuntime(target) {
    if (isUtilityRuntimeStartBlocked()) {
        return { enabled: true, connected: false };
    }
    const currentManager = getManager();
    const connected = await currentManager.connectRenderer(target);
    if (connected)
        return { enabled: true, connected: true };
    if (currentManager.getTerminalFailure() !== null) {
        return { enabled: true, connected: false, terminal: true };
    }
    return { enabled: true, connected: false };
}
export function disconnectRendererFromUtilityRuntime(rendererId, reason) {
    if (!manager)
        return;
    logger.info(`[UtilityRuntime] renderer ${rendererId} disconnected (${reason})`);
    manager.disconnectRenderer(rendererId);
}
/**
 * Main's own transport connection into the utility runtime. Used by the
 * app:// protocol handler while plane-B disk serving (§2.2 B1) is pending,
 * so previews/avatars keep working in utility mode. Rebuilt after a crash
 * refork (the broadcast handler drops the stale fetch).
 */
export async function fetchViaUtilityRuntime(request, consumer = DEFAULT_TRANSPORT_CONSUMER) {
    if (isUtilityRuntimeStartBlocked()) {
        return new Response(JSON.stringify({ error: 'local_runtime_unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    // Plane B (§2.2 B1): element-src binaries are read from disk in main —
    // no byte ferrying out of the utility process for <img>/<video> loads.
    try {
        const planeB = await serveUtilityPlaneBRequest(request.method, new URL(request.url));
        if (planeB)
            return planeB;
    }
    catch {
        logger.warn('[UtilityRuntime] plane-B disk serve failed');
    }
    const ready = await ensureUtilityRuntimeStarted();
    if (!ready) {
        return new Response(JSON.stringify({ error: 'local_runtime_unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    // Single-flight link creation per consumer: concurrent requests from one
    // owner share a connection, while unrelated long-lived streams cannot
    // head-of-line block another owner's command traffic.
    let activePromise = mainFetchPromises.get(consumer);
    if (!activePromise) {
        activePromise = createMainTransportFetch(consumer);
        mainFetchPromises.set(consumer, activePromise);
    }
    const mainFetch = await activePromise;
    if (!mainFetch) {
        if (mainFetchPromises.get(consumer) === activePromise) {
            mainFetchPromises.delete(consumer);
        }
        return new Response(JSON.stringify({ error: 'local_runtime_unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    return mainFetch(request);
}
async function createMainTransportFetch(consumer) {
    const [{ createRuntimeTransportFetch }, link] = await Promise.all([
        loadRuntimeTransportModule(),
        createMainTransportLink(consumer),
    ]);
    if (!link)
        return null;
    return createRuntimeTransportFetch({ link });
}
async function createMainTransportLink(consumer) {
    // Dynamic import keeps `MessageChannelMain` construction inside a function
    // for testability; `electron` itself is already a static dependency.
    const [{ MessageChannelMain }, { isRuntimeTransportServerFrame }] = await Promise.all([
        import('electron'),
        loadRuntimeTransportModule(),
    ]);
    const activeManager = getManager();
    const { port1, port2 } = new MessageChannelMain();
    // Generation stamp: a stale port's late close event must not tear down a
    // freshly rebuilt connection.
    const generation = ++mainLinkSequence;
    mainLinkGenerations.set(consumer, generation);
    const frameListeners = new Set();
    const lostListeners = new Set();
    port2.on('message', (event) => {
        if (!isRuntimeTransportServerFrame(event.data))
            return;
        for (const listener of [...frameListeners])
            listener(event.data);
    });
    port2.on('close', () => {
        if (mainLinkGenerations.get(consumer) === generation) {
            mainFetchPromises.delete(consumer);
            mainLinkGenerations.delete(consumer);
        }
        for (const listener of [...lostListeners]) {
            listener({ message: 'runtime transport port closed' });
        }
    });
    port2.start();
    const delivered = activeManager.deliverPortToUtility(port1);
    if (!delivered) {
        port2.close();
        return null;
    }
    return {
        post: (frame) => port2.postMessage(frame),
        subscribe: (listener) => {
            frameListeners.add(listener);
            return () => frameListeners.delete(listener);
        },
        subscribeLost: (listener) => {
            lostListeners.add(listener);
            return () => lostListeners.delete(listener);
        },
    };
}
