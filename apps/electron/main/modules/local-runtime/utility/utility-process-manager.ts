/**
 * Local-runtime utility process lifecycle manager (Electron main side).
 *
 * Owns the single utility process per dataDir (proposal §2.8 hard
 * constraint: multiple windows connect multiple MessagePorts to the SAME
 * utility), its spawn/ready/exit lifecycle, crash recovery with backoff
 * refork, renderer port hand-off, and the graceful drain-then-kill quit
 * path (§2.5).
 *
 * Recovery is bounded in BOTH directions, because a supervisor must not
 * restart a deterministically failing child forever: MAX_INIT_FAILURES
 * latches repeated pre-ready failures, and MAX_CRASH_LOOP_REFORKS latches
 * repeated post-ready crashes (the ready-then-crash loop that no
 * init-failure counter can see). Both land in the same terminal phase
 * 'failed' with an attributable onRuntimeFailed reason.
 *
 * Main never sits on the data plane: `connectRenderer` creates a
 * MessageChannelMain, transfers one end to the utility process and the
 * other to the renderer, then drops both references.
 *
 * State modeling: the mutable lifecycle lives in ONE discriminated union
 * (`ManagerState`) so illegal field combinations — the root of this MR's
 * review-history bugs (a "stopped" manager still holding a zombie child,
 * a fork racing a not-yet-exited predecessor) — are unrepresentable.
 * Time-ordering hazards that types cannot encode are handled by exactly
 * two mechanisms: `ownsChild` identity checks on every child event (a stale
 * child cannot touch the current state) and two fork gates (`stopPromise`,
 * quarantined `actualExit`) that make every fork wait for the previous
 * process's real exit (§2.8 single-writer ordering).
 */

import path from "path";
import { randomUUID } from "crypto";
import { boundFailureDetail } from "../../observability/failure-detail";
import { utilityBootstrapStageRank, UTILITY_MODULE_SUBSTAGES, RUNTIME_TRANSPORT_PORT_CHANNEL, LOCAL_RUNTIME_UTILITY_SERVICE_NAME, isUtilityStatusMessage } from "./control";
import { MainOwnedBrowserBroker } from "./browser-broker";
import { MainOwnedDiagnosticsBroker } from "./diagnostics-broker";
import { MainOwnedAuthRecoveryBroker } from "./auth-recovery-broker";
import { MainMiniAppBrokerClient } from "./miniapp-broker";
import { MainOwnedMiniAppSurfaceBroker } from "./miniapp-surface-broker";
import { MainMiniAppToolBroker } from "./miniapp-tool-broker";
import { describeRuntimeOwnerConflict } from "./runtime-owner-conflict";
import { DEFAULT_RUNTIME_MEMORY_MONITOR_INTERVAL_MS, DEFAULT_HEAP_SAMPLING_INTERVAL_BYTES, DEFAULT_HEAP_SAMPLING_STACK_DEPTH, isRuntimeMemorySampleMessage, isRuntimeMemoryMonitorResponse } from "./runtime-memory-monitor-contract";
import { isRuntimeComputerUseRequiredMessage } from "./computer-use-broker";
const DEFAULT_DRAIN_GRACE_MS = 9000;
/** Extra wait after kill() before giving up (kill() can return false). */
const KILL_CONFIRM_TIMEOUT_MS = 2000;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 30000;
/**
 * Post-fork window the child may spend WITHOUT reporting a new bootstrap
 * stage. It is not a total-bootstrap budget: every forward stage re-arms it.
 *
 * Database backup, integrity checks and migrations run between the
 * modules-loaded and sqlite-ready checkpoints without reporting progress.
 * Large databases need a longer window to finish that work. The stage list
 * is finite (control.ts), so the worst-case total stays bounded at
 * (stages + 1) x this window.
 */
const BOOTSTRAP_STALL_TIMEOUT_MS = 600000;
const DEFAULT_MAX_BACKOFF_MS = 10000;
const DEFAULT_STABLE_UPTIME_MS = 30000;
const DEFAULT_AUTH_ROTATION_TIMEOUT_MS = 30000;
const DEFAULT_FLUSH_LOGS_TIMEOUT_MS = 3000;
const DEFAULT_RUNTIME_HEALTH_TIMEOUT_MS = 45000;
const DEFAULT_MEMORY_PRESSURE_THRESHOLD = 0.8;
const DEFAULT_MEMORY_PRESSURE_CONSECUTIVE_SAMPLES = 2;
const DEFAULT_PROACTIVE_RECOVERY_MAX_ATTEMPTS = 5;
const DEFAULT_PROACTIVE_RECOVERY_COOLDOWN_MS = 60000;
const MAX_PROACTIVE_RECOVERY_COOLDOWN_MS = 10 * 60000;
const RUNTIME_MEMORY_MONITOR_REQUEST_TIMEOUT_MS = 10000;
const SESSION_REPORT_REQUEST_TIMEOUT_MS = 30000;
const BACKOFF_BASE_MS = 250;
/** Consecutive runtime-init failures before the manager stops retrying. */
const MAX_INIT_FAILURES = 3;
/**
 * Consecutive crash reforks (no stable run in between) before the manager
 * stops reforking. This is a product safety policy, not caller configuration.
 */
const MAX_CRASH_LOOP_REFORKS = 5;
const noopLogger = {
    info: () => { },
    warn: () => { },
    error: () => { },
};
/**
 * CSI escape sequences (colors, cursor movement). The utility's pino-pretty
 * stdout is colorized in dev; without stripping, the piped copy pollutes
 * `main-*.log` with raw `\x1b[32m...` bytes.
 */
const ANSI_CSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const SYSTEM_CA_NODE_OPTION_PATTERN = /^--use-system-ca(?:=.*)?$/;
function stripAnsi(text) {
    return text.includes('\u001b') ? text.replace(ANSI_CSI_PATTERN, '') : text;
}
/**
 * Attribution for a stall inside the two-import `modules-loaded` phase, which
 * used to be a single black box. Returns null once the phase is provably past
 * (or before the child said anything at all), so the clause only ever shows up
 * where it carries information.
 */
function formatModulesPhaseClause(reachedStages) {
    if (reachedStages.length === 0)
        return null;
    const maxRank = Math.max(...reachedStages.map(({ stage }) => utilityBootstrapStageRank(stage)));
    if (maxRank >= utilityBootstrapStageRank('modules-loaded'))
        return null;
    const reached = new Set(reachedStages.map(({ stage }) => stage));
    // Declaration order, not arrival order: the diagnostic must read identically
    // for both Promise.all completion orders.
    const completed = UTILITY_MODULE_SUBSTAGES.filter((stage) => reached.has(stage));
    const pending = UTILITY_MODULE_SUBSTAGES.filter((stage) => !reached.has(stage));
    if (completed.length === 0)
        return 'modules: none of modules-* completed';
    const missing = pending.length === 0 ? ['modules-loaded'] : pending;
    return `modules: ${completed.join(' + ')} completed, ${missing.join(' + ')} pending`;
}
/** Safe bootstrap progress summary: fixed stage names and relative milliseconds only. */
function formatBootstrapProgress(reachedStages) {
    const timings = reachedStages.length === 0
        ? 'no stage reported'
        : reachedStages.map(({ stage, elapsedMs }) => `${stage}+${elapsedMs}ms`).join(', ');
    const modulesClause = formatModulesPhaseClause(reachedStages);
    return `${timings}${modulesClause ? `; ${modulesClause}` : ''}`;
}
/**
 * Sanitized stall diagnostic: the stage the child got stuck AT plus the
 * relative timing of the stages it did reach, and — while the module-loading
 * phase is still open — which of the two ESM graphs finished and which did
 * not. Stage names and integers only — no paths, no child output — and bounded
 * by the (short) stage list, so it always fits the failure_detail budget.
 */
function formatBootstrapStallDetail(stalledStage, stallTimeoutMs, reachedStages) {
    return (`utility bootstrap stalled at stage ${stalledStage} after ${stallTimeoutMs}ms ` +
        `without progress (${formatBootstrapProgress(reachedStages)})`);
}
/**
 * A pre-ready process exit otherwise has only an opaque numeric code. Include
 * the last safe bootstrap checkpoint and elapsed time so production incidents
 * remain attributable without reporting stderr, paths, or user data.
 */
function formatBootstrapExitDetail(exitCode, elapsedMs, reachedStages) {
    const lastStage = reachedStages.at(-1)?.stage ?? 'fork';
    return (`utility exited before ready at stage ${lastStage} after ${elapsedMs}ms ` +
        `(code=${exitCode}; ${formatBootstrapProgress(reachedStages)})`);
}
/**
 * Removes only system-CA option tokens while preserving the original quoting
 * and escaping of every other NODE_OPTIONS argument. NODE_OPTIONS accepts
 * quoted values (for example, a --require path containing spaces), so a
 * split-and-join rewrite would change valid child-process arguments.
 */
function removeSystemCaNodeOptions(nodeOptions) {
    const removals = [];
    let tokenStart = -1;
    let tokenStartsQuoted = false;
    let quote = null;
    let escaped = false;
    const flushToken = (tokenEnd) => {
        if (tokenStart < 0)
            return;
        const token = nodeOptions.slice(tokenStart, tokenEnd);
        if (!tokenStartsQuoted && SYSTEM_CA_NODE_OPTION_PATTERN.test(token)) {
            // Consume one separator after the removed token when present. This
            // keeps the surrounding options readable without rewriting any other
            // whitespace in the original string.
            const end = /\s/.test(nodeOptions[tokenEnd] ?? '') ? tokenEnd + 1 : tokenEnd;
            removals.push([tokenStart, end]);
        }
        tokenStart = -1;
        tokenStartsQuoted = false;
        quote = null;
        escaped = false;
    };
    for (let index = 0; index <= nodeOptions.length; index += 1) {
        const character = nodeOptions[index];
        if (tokenStart < 0) {
            if (character === undefined || /\s/.test(character))
                continue;
            tokenStart = index;
            tokenStartsQuoted = character === '"' || character === "'";
        }
        if (character === undefined) {
            flushToken(index);
            break;
        }
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (character === quote)
                quote = null;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (/\s/.test(character))
            flushToken(index);
    }
    if (removals.length === 0)
        return nodeOptions;
    let result = '';
    let cursor = 0;
    for (const [start, end] of removals) {
        result += nodeOptions.slice(cursor, start);
        cursor = end;
    }
    return result + nodeOptions.slice(cursor);
}
/**
 * Removes the macOS system-CA switches from an environment passed to a
 * child process. On the Electron/Node versions affected by the macOS
 * Keychain crash, inheriting either switch can terminate the utility before
 * it becomes ready. Keep this at the child-env boundary so the main process
 * and non-macOS children retain their existing environment semantics.
 *
 * `NODE_EXTRA_CA_CERTS` is deliberately left untouched: an explicitly
 * configured PEM remains the supported enterprise-CA escape hatch.
 */
export function scrubMacSystemCaEnv(env, platform = process.platform) {
    if (platform !== 'darwin')
        return;
    delete env.NODE_USE_SYSTEM_CA;
    const nodeOptions = env.NODE_OPTIONS;
    if (nodeOptions === undefined)
        return;
    const remainingNodeOptions = removeSystemCaNodeOptions(nodeOptions);
    const trimmedNodeOptions = remainingNodeOptions.trim();
    if (trimmedNodeOptions.length === 0) {
        delete env.NODE_OPTIONS;
    }
    else {
        env.NODE_OPTIONS = trimmedNodeOptions;
    }
}
export class LocalRuntimeUtilityProcessManager {
    constructor(options) {
        this.options = options;
        this.state = { phase: 'stopped' };
        /** Single-flight stop; also a fork gate (see ensureStarted). */
        this.stopPromise = null;
        /** Reforks actually performed; used only as the recovery backoff exponent. */
        this.restartAttempts = 0;
        /**
         * Reforks caused by unexpected post-ready exits since the last stable run
         * or deliberate stop. Proactive health/OOM recycle is intentionally kept
         * out: otherwise periodic healthy recoveries make the next ordinary crash
         * look like a multi-exit crash loop.
         */
        this.crashLoopReforks = 0;
        this.initFailureCount = 0;
        /**
         * True while a recovery incident is open, i.e. the manager has failed at
         * least once since the last ready/stop. Scopes the init-failure latch to a
         * single incident (see openIncident).
         */
        this.incidentOpen = false;
        this.restartTimer = null;
        this.runtimeHealthTimer = null;
        this.runtimeHealthChild = null;
        this.lastRuntimeHealthSequence = -1;
        this.consecutiveMemoryPressureSamples = 0;
        this.proactiveRecoveryAttempts = 0;
        this.pendingAuthRotations = new Map();
        this.pendingLogFlushes = new Map();
        this.pendingSessionReports = new Map();
        this.pendingRuntimeMemoryMonitorRequests = new Map();
        this.rendererConnectionIds = new Map();
        this.rendererGenerations = new Map();
        this.activeAppVersion = 'unknown';
        this.miniAppBroker = new MainMiniAppBrokerClient();
        this.miniAppToolBroker = new MainMiniAppToolBroker({
            requestApproval: async (input) => (await this.options.requestMiniAppToolApproval?.(input)) ?? 'unavailable',
        });
        this.revokedMiniAppGenerations = new WeakSet();
        this.routingContext = options.getRoutingContext?.();
        this.browserBroker = new MainOwnedBrowserBroker({
            getAdapter: () => this.activeBrowserAdapter,
            onDeliveryFailure: ({ requestId, messageType, error }) => {
                (this.options.logger ?? noopLogger).error(`[UtilityRuntime] Browser broker ${messageType} delivery failed requestId=${requestId}: ${error}`);
            },
        });
        this.diagnosticsBroker = new MainOwnedDiagnosticsBroker({
            getProvider: () => this.activeHostDiagnosticsProvider,
        });
        this.authRecoveryBroker = new MainOwnedAuthRecoveryBroker({
            recoverAuthContext: (rejectedAccessToken, loginEpoch) => {
                const recover = this.options.recoverAuthContext;
                if (!recover)
                    throw new Error('Desktop auth recovery is unavailable');
                return recover(rejectedAccessToken, loginEpoch);
            },
        });
        this.miniAppSurfaceBroker = new MainOwnedMiniAppSurfaceBroker({
            open: (input) => {
                const open = this.options.openMiniAppSurface;
                if (!open) {
                    throw Object.assign(new Error('Mini App surface is unavailable'), {
                        code: 'runtime_unavailable',
                    });
                }
                return open(input);
            },
            close: (input) => {
                const close = this.options.closeMiniAppSurface;
                if (!close) {
                    throw Object.assign(new Error('Mini App surface cleanup is unavailable'), {
                        code: 'runtime_unavailable',
                    });
                }
                return close(input);
            },
        });
        options.executionContinuity.onGap((observation) => {
            // "Consecutive" memory pressure cannot span a period in which Main did
            // not execute; queued pre-gap samples must not combine with fresh ones.
            this.consecutiveMemoryPressureSamples = 0;
            this.notifyLifecycle({ type: 'execution-gap', ...observation });
        });
    }
    isReady() {
        return this.state.phase === 'ready';
    }
    /** A forked child can safely receive control-plane ports while bootstrap is
     * still in flight; the child latches them and attaches them before ready. */
    canAcceptComputerUseChannel() {
        return this.state.phase === 'starting' || this.state.phase === 'ready';
    }
    /**
     * Why the manager latched 'failed', or null while it has not. The renderer
     * surfacing path reads this instead of a transient message variable so the
     * cause survives stop()/reconnect cycles for as long as the latch does.
     */
    getTerminalFailure() {
        if (this.state.phase === 'failed')
            return this.state.failure;
        if (this.state.phase === 'quarantined')
            return this.state.terminalFailure;
        return null;
    }
    getStartupToken() {
        const state = this.state;
        return state.phase === 'starting' ||
            state.phase === 'ready' ||
            state.phase === 'stopping' ||
            state.phase === 'quarantined'
            ? state.startupToken
            : null;
    }
    /** Internal lifecycle diagnostic used by owner-path smoke tests. */
    getProcessId() {
        const state = this.state;
        if (state.phase !== 'starting' &&
            state.phase !== 'ready' &&
            state.phase !== 'stopping' &&
            state.phase !== 'quarantined') {
            return null;
        }
        const pid = state.child.pid;
        return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
    }
    /** True when `child` is the one the CURRENT state refers to. */
    ownsChild(child) {
        const state = this.state;
        return ((state.phase === 'starting' ||
            state.phase === 'ready' ||
            state.phase === 'stopping' ||
            state.phase === 'quarantined') &&
            state.child === child);
    }
    notifyLifecycle(event) {
        try {
            this.options.lifecycleObserver?.observe(event);
        }
        catch (error) {
            try {
                const detail = boundFailureDetail(error instanceof Error ? error.message : String(error));
                // A dropped 'runtime-failed'/'terminal-failed' means the incident has
                // no terminal summary anywhere; that loss must be attributable.
                const log = this.options.logger ?? noopLogger;
                const message = `[UtilityRuntime] lifecycle observer threw for ${event.type}: ${detail}`;
                if (event.type === 'runtime-failed' || event.type === 'terminal-failed') {
                    log.error(message);
                }
                else {
                    log.warn(message);
                }
            }
            catch {
                // Observability failures must remain outside the runtime control path.
            }
        }
    }
    /**
     * Host callbacks (onRuntimeReady/Lost/Failed) are integration points into
     * main-process wiring; a throwing listener must not derail the state
     * machine — especially in the terminal latch, where a throw between the
     * transport-lost and give-up notifications would swallow the verdict.
     */
    notifyHost(hook, invoke) {
        try {
            invoke();
        }
        catch (error) {
            const detail = boundFailureDetail(error instanceof Error ? error.message : String(error));
            (this.options.logger ?? noopLogger).error(`[UtilityRuntime] ${hook} listener threw: ${detail}`);
        }
    }
    /**
     * Ensures exactly one utility process is running for the dataDir.
     * Concurrent callers share one bootstrap; repeated calls reuse the live
     * child instead of forking another (single-dataDir-single-utility).
     * After MAX_INIT_FAILURES consecutive init failures the manager latches
     * into 'failed' and refuses further forks — renderer reconnect loops must
     * not amplify a persistent bootstrap failure into a fork storm. The
     * crash-loop breaker latches the same way, so a
     * post-ready crash loop is equally immune to reconnect-driven forking.
     */
    async ensureStarted(options = {}) {
        const stopGate = this.stopPromise;
        if (stopGate) {
            await stopGate;
            return this.ensureStarted(options);
        }
        const state = this.state;
        if (state.phase === 'ready')
            return true;
        if (state.phase === 'failed')
            return false;
        if (state.phase === 'cooldown') {
            if (!options.bypassRecoveryCooldown)
                return false;
            this.cancelScheduledRestart();
            return this.ensureStarted(options);
        }
        if (state.phase === 'backoff' || state.phase === 'launching' || state.phase === 'starting') {
            return state.ready;
        }
        // A stop may be draining the previous child, and an init failure may
        // have a killed-but-not-yet-exited child; either way the fork must wait
        // for the old process's exit so its SQLite lock is released first (§2.8).
        if (state.phase === 'stopping') {
            await this.stopPromise;
            return this.ensureStarted(options);
        }
        if (state.phase === 'quarantined') {
            if (options.bypassRecoveryCooldown) {
                this.promoteQuarantineIntent(state, 'retry-bootstrap');
            }
            const exitResult = await state.boundedStopResult;
            if (exitResult.status === 'quarantined' || state.afterExit === 'stay-stopped') {
                return false;
            }
            return this.ensureStarted(options);
        }
        // phase === 'stopped': launch. `ready` is exposed via the launching
        // state before any async work so concurrent callers share this attempt.
        let settle;
        const ready = new Promise((resolve) => {
            settle = resolve;
        });
        this.state = { phase: 'launching', ready };
        void this.launch(ready, settle);
        return ready;
    }
    /**
     * Creates a MessageChannelMain and hands one end to the utility process,
     * the other to the renderer. Main holds no reference afterwards — the
     * data plane is renderer <-> utility only.
     */
    async connectRenderer(target) {
        const generation = this.rendererGenerations.get(target.id) ?? 0;
        const ready = await this.ensureStarted();
        const state = this.state;
        if (!ready ||
            state.phase !== 'ready' ||
            (this.rendererGenerations.get(target.id) ?? 0) !== generation) {
            return false;
        }
        let createChannel = this.options.createMessageChannel;
        if (!createChannel) {
            const electron = await import('electron');
            createChannel = () => new electron.MessageChannelMain();
        }
        const currentState = this.state;
        if (currentState.phase !== 'ready' ||
            currentState.child !== state.child ||
            (this.rendererGenerations.get(target.id) ?? 0) !== generation) {
            return false;
        }
        const connectionId = randomUUID();
        const { port1, port2 } = createChannel();
        this.releaseRendererConnection(target.id);
        const connectMessage = {
            type: 'runtime-port-connect',
            connectionId,
        };
        this.rendererConnectionIds.set(target.id, connectionId);
        try {
            state.child.postMessage(connectMessage, [port1]);
            target.postMessage(RUNTIME_TRANSPORT_PORT_CHANNEL, { connectionId }, [port2]);
            return true;
        }
        catch {
            this.releaseRendererConnection(target.id, connectionId);
            this.closePort(port1);
            this.closePort(port2);
            (this.options.logger ?? noopLogger).warn('[UtilityRuntime] renderer port delivery failed');
            return false;
        }
    }
    /** Attach/replace the CUA data channel without restarting local-runtime-v2.
     * A starting child latches the port and installs it before publishing ready. */
    connectComputerUseChannel(channel) {
        const state = this.state;
        if (state.phase !== 'starting' && state.phase !== 'ready')
            return false;
        try {
            const message = {
                type: 'runtime-computer-use-connect',
                generation: channel.generation,
            };
            state.child.postMessage(message, [channel.transfer]);
            return true;
        }
        catch {
            (this.options.logger ?? noopLogger).warn('[UtilityRuntime] CUA channel delivery failed');
            return false;
        }
    }
    /** Main-owned UI request over the utility control plane. */
    async requestMiniApp(method, pluginId, signal) {
        return this.miniAppBroker.request(await this.readyMiniAppTarget(), method, pluginId, signal);
    }
    /** Plugin-detail permission switch; resolves with the stored list. */
    async setMiniAppPermission(input) {
        return this.miniAppBroker.setPermission(await this.readyMiniAppTarget(), input);
    }
    /** Page-path Agent run; `input.caller` was resolved by Main from the sending tab. */
    async runMiniAppAgent(input, options) {
        return this.miniAppBroker.runAgent(await this.readyMiniAppTarget(), input, options);
    }
    /** Page-path permission decision; `input.caller` was resolved by Main from the sending tab. */
    async replyMiniAppAgent(input) {
        return this.miniAppBroker.replyAgent(await this.readyMiniAppTarget(), input);
    }
    /** Page-path side-panel check; `input.caller` was resolved by Main from the sending tab. */
    async openMiniAppAgent(input) {
        return this.miniAppBroker.openAgent(await this.readyMiniAppTarget(), input);
    }
    /** Page-path model catalog; `input.caller` was resolved by Main from the sending tab. */
    async modelsMiniAppAgent(input) {
        return this.miniAppBroker.modelsAgent(await this.readyMiniAppTarget(), input);
    }
    async agentsMiniAppAgent(input) {
        return this.miniAppBroker.agentsAgent(await this.readyMiniAppTarget(), input);
    }
    /** Page-path session creation without a turn. */
    async createMiniAppAgent(input) {
        return this.miniAppBroker.createAgent(await this.readyMiniAppTarget(), input);
    }
    /** Host-reported side panel change for a Mini App session; no tab caller. */
    async reportMiniAppAgentPanel(method, input) {
        // A panel report describes in-memory runtime state. `panelOpened` follows a successful
        // `open`, so the runtime is up; `panelClosed` must not start a runtime that is not
        // running, since a stopped runtime has nothing left to forget.
        if (method === 'agent.panelClosed' && this.state.phase !== 'ready')
            return;
        return this.miniAppBroker.reportAgentPanel(await this.readyMiniAppTarget(), method, input);
    }
    /** Page-path observer; no deadline, ends on cancel or when the runtime ends it. */
    async observeMiniAppAgent(input, options) {
        return this.miniAppBroker.observeAgent(await this.readyMiniAppTarget(), input, options);
    }
    async listMiniAppAgentSessions(input) {
        return this.miniAppBroker.listAgentSessions(await this.readyMiniAppTarget(), input);
    }
    async getMiniAppAgentSession(input) {
        return this.miniAppBroker.getAgentSession(await this.readyMiniAppTarget(), input);
    }
    /** Page-path questionnaire answer; the continuation turn is followed like `runMiniAppAgent`. */
    async answerMiniAppAgent(input, options) {
        return this.miniAppBroker.answerAgent(await this.readyMiniAppTarget(), input, options);
    }
    /** Page-path `tool.request`; `pluginId` was resolved by Main from the sending tab. */
    async requestMiniAppTools(input) {
        return this.miniAppToolBroker.requestFromPage(await this.readyMiniAppTarget(), input);
    }
    async readyMiniAppTarget() {
        const ready = await this.ensureStarted();
        const state = this.state;
        if (!ready || state.phase !== 'ready') {
            throw Object.assign(new Error('Mini App runtime is unavailable'), {
                code: 'runtime_unavailable',
            });
        }
        return state.child;
    }
    disconnectRenderer(rendererId) {
        this.rendererGenerations.set(rendererId, (this.rendererGenerations.get(rendererId) ?? 0) + 1);
        this.releaseRendererConnection(rendererId);
    }
    releaseRendererConnection(rendererId, expectedConnectionId) {
        const connectionId = this.rendererConnectionIds.get(rendererId);
        if (!connectionId || (expectedConnectionId && connectionId !== expectedConnectionId))
            return;
        this.rendererConnectionIds.delete(rendererId);
        const state = this.state;
        if (state.phase !== 'ready')
            return;
        try {
            const message = {
                type: 'runtime-port-disconnect',
                connectionId,
            };
            state.child.postMessage(message);
        }
        catch {
            (this.options.logger ?? noopLogger).warn('[UtilityRuntime] renderer disconnect post failed');
        }
    }
    closePort(port) {
        try {
            port.close();
        }
        catch {
            // The port may already have transferred to another process.
        }
    }
    /** Forwards a rotated auth context and waits for utility acknowledgement. */
    setAuthContext(authContext) {
        const state = this.state;
        if (state.phase !== 'starting' && state.phase !== 'ready')
            return Promise.resolve();
        const requestId = randomUUID();
        const message = {
            type: 'runtime-auth-context',
            requestId,
            authContext,
        };
        return new Promise((resolve, reject) => {
            const timeoutMs = this.options.authRotationTimeoutMs ?? DEFAULT_AUTH_ROTATION_TIMEOUT_MS;
            const timeout = setTimeout(() => {
                this.pendingAuthRotations.delete(requestId);
                reject(new Error(`utility auth rotation timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pendingAuthRotations.set(requestId, {
                child: state.child,
                resolve,
                reject,
                timeout,
            });
            try {
                state.child.postMessage(message);
            }
            catch {
                this.rejectAuthRotation(requestId, new Error('utility auth rotation post failed'));
            }
        });
    }
    /**
     * Publishes the current managed-backend routing lane without touching auth
     * state. Updates arriving while the child is starting are delivered over
     * the same control channel and latched by the utility server last-writer-
     * wins before its ready signal.
     */
    setRoutingContext(routingContext) {
        this.routingContext = routingContext;
        const state = this.state;
        if (state.phase !== 'starting' && state.phase !== 'ready')
            return;
        const message = {
            type: 'runtime-routing-context',
            ...(routingContext ? { routingContext } : {}),
        };
        try {
            state.child.postMessage(message);
        }
        catch {
            (this.options.logger ?? noopLogger).warn('[UtilityRuntime] routing context post failed');
        }
    }
    setContextWindowUsageEnabled(enabled) {
        const state = this.state;
        if (state.phase !== 'starting' && state.phase !== 'ready')
            return;
        try {
            state.child.postMessage({ type: 'runtime-context-window-usage', enabled });
        }
        catch {
            (this.options.logger ?? noopLogger).warn('[UtilityRuntime] Context Usage preference post failed');
        }
    }
    setRunawayGuardConfig(config) {
        const state = this.state;
        if (state.phase !== 'starting' && state.phase !== 'ready')
            return;
        try {
            state.child.postMessage({ type: 'runtime-runaway-guard-config', config });
        }
        catch {
            (this.options.logger ?? noopLogger).warn('[UtilityRuntime] Runaway Guard config post failed');
        }
    }
    setPromptSuggestionPolicy(policy) {
        const state = this.state;
        if (state.phase !== 'starting' && state.phase !== 'ready')
            return;
        try {
            state.child.postMessage({ type: 'runtime-prompt-suggestion-policy', policy });
        }
        catch {
            (this.options.logger ?? noopLogger).warn('[UtilityRuntime] Prompt suggestion policy post failed');
        }
    }
    setToolResultCompactionConfig(config) {
        const state = this.state;
        if (state.phase !== 'starting' && state.phase !== 'ready')
            return;
        try {
            state.child.postMessage({
                type: 'runtime-tool-result-compaction-config',
                config,
            });
        }
        catch {
            (this.options.logger ?? noopLogger).warn('[UtilityRuntime] ToolResult compaction config post failed');
        }
    }
    setCollectionPolicy(policy) {
        const state = this.state;
        if (state.phase !== 'starting' && state.phase !== 'ready')
            return;
        try {
            state.child.postMessage({ type: 'runtime-collection-policy', policy });
        }
        catch {
            (this.options.logger ?? noopLogger).warn('[UtilityRuntime] collection policy post failed');
        }
    }
    completeAuthRotation(requestId, child) {
        const pending = this.pendingAuthRotations.get(requestId);
        if (!pending || pending.child !== child)
            return;
        clearTimeout(pending.timeout);
        this.pendingAuthRotations.delete(requestId);
        pending.resolve();
    }
    rejectAuthRotation(requestId, error) {
        const pending = this.pendingAuthRotations.get(requestId);
        if (!pending)
            return;
        clearTimeout(pending.timeout);
        this.pendingAuthRotations.delete(requestId);
        pending.reject(error);
    }
    rejectAuthRotationsForChild(child, message) {
        for (const [requestId, pending] of this.pendingAuthRotations) {
            if (pending.child !== child)
                continue;
            this.rejectAuthRotation(requestId, new Error(message));
        }
    }
    /**
     * Asks the utility process to flush its disk log transports
     * (`runtime-*.log` / `im-runtime-*.log`) so a feedback upload reads a
     * complete tail. Best-effort by design: resolves `false` (never rejects)
     * when the runtime is not ready, the post fails, the child exits, or the
     * ACK misses its deadline — the upload proceeds with whatever is on disk.
     */
    flushLogs() {
        const state = this.state;
        if (state.phase !== 'ready')
            return Promise.resolve(false);
        const requestId = randomUUID();
        const message = { type: 'runtime-flush-logs', requestId };
        return new Promise((resolve) => {
            const timeoutMs = this.options.flushLogsTimeoutMs ?? DEFAULT_FLUSH_LOGS_TIMEOUT_MS;
            const timeout = setTimeout(() => {
                this.settleLogFlush(requestId, false);
            }, timeoutMs);
            this.pendingLogFlushes.set(requestId, { child: state.child, settle: resolve, timeout });
            try {
                state.child.postMessage(message);
            }
            catch {
                this.settleLogFlush(requestId, false);
            }
        });
    }
    collectSessionReport(sessionId) {
        const state = this.state;
        if (state.phase !== 'ready') {
            return Promise.reject(new Error('session_report_runtime_unavailable'));
        }
        const requestId = randomUUID();
        const message = {
            type: 'runtime-session-report-request',
            requestId,
            sessionId,
        };
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.rejectSessionReport(requestId, new Error('session_report_request_timeout'));
            }, SESSION_REPORT_REQUEST_TIMEOUT_MS);
            this.pendingSessionReports.set(requestId, { child: state.child, resolve, reject, timeout });
            try {
                state.child.postMessage(message);
            }
            catch {
                this.rejectSessionReport(requestId, new Error('session_report_request_failed'));
            }
        });
    }
    settleSessionReport(response, child) {
        const pending = this.pendingSessionReports.get(response.requestId);
        if (!pending || pending.child !== child)
            return;
        clearTimeout(pending.timeout);
        this.pendingSessionReports.delete(response.requestId);
        if (response.type === 'runtime-session-report-error') {
            pending.reject(new Error(response.message));
            return;
        }
        pending.resolve(response.report);
    }
    rejectSessionReport(requestId, error) {
        const pending = this.pendingSessionReports.get(requestId);
        if (!pending)
            return;
        clearTimeout(pending.timeout);
        this.pendingSessionReports.delete(requestId);
        pending.reject(error);
    }
    rejectSessionReportsForChild(child, message) {
        for (const [requestId, pending] of this.pendingSessionReports) {
            if (pending.child === child)
                this.rejectSessionReport(requestId, new Error(message));
        }
    }
    async configureRuntimeMemoryMonitoring(enabled, intervalMs = DEFAULT_RUNTIME_MEMORY_MONITOR_INTERVAL_MS) {
        const response = await this.requestRuntimeMemoryMonitor({
            type: 'runtime-memory-monitor-configure',
            requestId: randomUUID(),
            enabled,
            intervalMs,
        });
        if (response.type !== 'runtime-memory-monitor-configured') {
            throw new Error(`unexpected utility memory monitor response: ${response.type}`);
        }
        return response;
    }
    async startRuntimeHeapSampling(samplingIntervalBytes = DEFAULT_HEAP_SAMPLING_INTERVAL_BYTES, stackDepth = DEFAULT_HEAP_SAMPLING_STACK_DEPTH) {
        const response = await this.requestRuntimeMemoryMonitor({
            type: 'runtime-heap-sampling-start',
            requestId: randomUUID(),
            samplingIntervalBytes,
            stackDepth,
        });
        if (response.type !== 'runtime-heap-sampling-started') {
            throw new Error(`unexpected utility heap sampling response: ${response.type}`);
        }
        return response;
    }
    async stopRuntimeHeapSampling() {
        const response = await this.requestRuntimeMemoryMonitor({
            type: 'runtime-heap-sampling-stop',
            requestId: randomUUID(),
        });
        if (response.type !== 'runtime-heap-sampling-stopped') {
            throw new Error(`unexpected utility heap sampling response: ${response.type}`);
        }
        return response;
    }
    requestRuntimeMemoryMonitor(message) {
        const state = this.state;
        if (state.phase !== 'ready') {
            return Promise.reject(new Error('utility runtime is not ready'));
        }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.rejectRuntimeMemoryMonitorRequest(message.requestId, new Error('utility runtime memory monitor request timed out'));
            }, RUNTIME_MEMORY_MONITOR_REQUEST_TIMEOUT_MS);
            this.pendingRuntimeMemoryMonitorRequests.set(message.requestId, {
                child: state.child,
                resolve,
                reject,
                timeout,
            });
            try {
                state.child.postMessage(message);
            }
            catch {
                this.rejectRuntimeMemoryMonitorRequest(message.requestId, new Error('utility runtime memory monitor post failed'));
            }
        });
    }
    settleRuntimeMemoryMonitorRequest(response, child) {
        const pending = this.pendingRuntimeMemoryMonitorRequests.get(response.requestId);
        if (!pending || pending.child !== child)
            return;
        clearTimeout(pending.timeout);
        this.pendingRuntimeMemoryMonitorRequests.delete(response.requestId);
        if (response.type === 'runtime-memory-monitor-error') {
            pending.reject(new Error(`utility runtime memory monitor failed: ${response.code}`));
            return;
        }
        pending.resolve(response);
    }
    rejectRuntimeMemoryMonitorRequest(requestId, error) {
        const pending = this.pendingRuntimeMemoryMonitorRequests.get(requestId);
        if (!pending)
            return;
        clearTimeout(pending.timeout);
        this.pendingRuntimeMemoryMonitorRequests.delete(requestId);
        pending.reject(error);
    }
    rejectRuntimeMemoryMonitorRequestsForChild(child, message) {
        for (const [requestId, pending] of this.pendingRuntimeMemoryMonitorRequests) {
            if (pending.child !== child)
                continue;
            this.rejectRuntimeMemoryMonitorRequest(requestId, new Error(message));
        }
    }
    settleLogFlush(requestId, flushed, child) {
        const pending = this.pendingLogFlushes.get(requestId);
        if (!pending || (child && pending.child !== child))
            return;
        clearTimeout(pending.timeout);
        this.pendingLogFlushes.delete(requestId);
        pending.settle(flushed);
    }
    settleLogFlushesForChild(child) {
        for (const [requestId, pending] of this.pendingLogFlushes) {
            if (pending.child !== child)
                continue;
            this.settleLogFlush(requestId, false);
        }
    }
    /**
     * Transfers an already-created MessagePortMain end to the utility process
     * (used for main's own transitional plane-B connection). The caller keeps
     * the sibling port.
     */
    deliverPortToUtility(port) {
        const state = this.state;
        if (state.phase !== 'ready')
            return false;
        const message = {
            type: 'runtime-port-connect',
            connectionId: randomUUID(),
        };
        try {
            state.child.postMessage(message, [port]);
            return true;
        }
        catch {
            (this.options.logger ?? noopLogger).warn('[UtilityRuntime] port delivery failed');
            return false;
        }
    }
    /**
     * Graceful drain then kill (§2.5): ask the utility to stop taking new
     * requests and flush persistence; force-kill when the grace budget runs
     * out. Idempotent; also cancels any pending crash refork. The in-flight
     * stop is tracked so a concurrent ensureStarted() waits for the old
     * child's actual exit instead of forking alongside it. The structured
     * result lets bounded callers continue without weakening that fork gate.
     */
    async stop() {
        if (this.stopPromise)
            return this.stopPromise;
        this.stopPromise = this.doStop().finally(() => {
            this.stopPromise = null;
        });
        return this.stopPromise;
    }
    async doStop() {
        const startedAtMs = Date.now();
        const runtimePid = this.getProcessId();
        try {
            const result = await this.performStop();
            try {
                (this.options.logger ?? noopLogger).info(`[UtilityRuntime] stop completed ${JSON.stringify({
                    ts_ms: Date.now(),
                    runtime_pid: runtimePid,
                    remaining_runtime_pid: this.getProcessId(),
                    duration_ms: Date.now() - startedAtMs,
                    ...result,
                })}`);
            }
            catch {
                // Diagnostics must not change the stop result or lifecycle cleanup.
            }
            return result;
        }
        finally {
            // A deliberate stop ends the supervision session: exits separated by
            // it are not "consecutive", so the crash-loop budget starts fresh on
            // the next start. The terminal latch itself is phase-based and
            // survives this reset (performStop returns early on 'failed').
            this.restartAttempts = 0;
            this.crashLoopReforks = 0;
            this.proactiveRecoveryAttempts = 0;
            // Every stop settles a pending recovery incident (if any) as
            // interrupted; the notification fires after in-flight launches and the
            // child drain so no later lifecycle event reopens the incident.
            this.closeIncident();
            this.notifyLifecycle({ type: 'stopped' });
        }
    }
    async performStop() {
        this.cancelScheduledRestart();
        // A launch/bootstrap may be in flight; wait for it to settle so there
        // is either a live child to drain or nothing to do — stopping in the
        // pre-fork window must not let the impending fork escape the stop.
        for (;;) {
            const state = this.state;
            if (state.phase === 'quarantined') {
                this.promoteQuarantineIntent(state, 'stay-stopped');
                return state.boundedStopResult;
            }
            if (state.phase === 'launching' || state.phase === 'starting') {
                await state.ready;
                continue;
            }
            // A crash can land while this loop is parked on a settling launch
            // (ready then exit before resumption); cancel the refork it scheduled
            // so no timer survives the stop and forks after stop() resolved.
            if (state.phase === 'backoff' || state.phase === 'cooldown') {
                this.cancelScheduledRestart();
                continue;
            }
            if (state.phase === 'stopped' || state.phase === 'failed')
                return { status: 'exited' };
            break; // ready
        }
        const state = this.state;
        if (state.phase !== 'ready')
            return { status: 'exited' };
        const child = state.child;
        this.state = { phase: 'stopping', child, startupToken: state.startupToken };
        this.releaseChildCapabilities(child);
        const graceMs = this.options.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
        const logger = this.options.logger ?? noopLogger;
        const exited = new Promise((resolve) => {
            child.once('exit', () => resolve());
        });
        try {
            const message = {
                type: 'runtime-shutdown',
                ...(this.options.appInstanceId ? { app_instance_id: this.options.appInstanceId } : {}),
            };
            child.postMessage(message);
        }
        catch {
            logger.warn('[UtilityRuntime] shutdown message failed');
        }
        const timedOut = await Promise.race([
            exited.then(() => false),
            new Promise((resolve) => {
                setTimeout(() => resolve(true), graceMs);
            }),
        ]);
        if (timedOut) {
            logger.warn(`[UtilityRuntime] drain exceeded ${graceMs}ms; killing utility process`);
            const quarantine = this.quarantineChild(child, state.startupToken, {
                afterExit: 'stay-stopped',
                terminalFailure: null,
                recoveryReasonCode: null,
            });
            return quarantine.boundedStopResult;
        }
        if (this.ownsChild(child)) {
            this.state = { phase: 'stopped' };
        }
        return { status: 'exited' };
    }
    resolveEntryPath() {
        return this.options.entryPath ?? path.join(__dirname, 'entry.js');
    }
    async buildForkEnv() {
        // buildEnv works partly through process.env side effects (managed env,
        // native sqlite paths), so it must run BEFORE process.env
        // is snapshotted — spreading first would silently drop those writes.
        const extra = (await this.options.buildEnv?.()) ?? {};
        const merged = {
            ...process.env,
            ...extra,
        };
        const env = {};
        for (const [key, value] of Object.entries(merged)) {
            if (value !== undefined)
                env[key] = value;
        }
        // `RuntimeInitMessage.dataDir` configures the host, while @mavis/config
        // independently resolves config.yaml from the process environment. Pin
        // both to the same value, after login-shell env hydration has completed.
        const dataDir = this.options.resolveDataDir();
        env.MINIMAX_DATA_DIR = dataDir;
        env.MAVIS_DATA_DIR = dataDir;
        scrubMacSystemCaEnv(env);
        return { env, dataDir };
    }
    /**
     * Moves a child into quarantine before killing it. `actualExit` is the only
     * fork gate; the 2s timer merely bounds stop callers and emits slow-exit
     * telemetry. Missing an exit event never becomes a terminal verdict.
     */
    discardChild(child, latchFailure, startupToken) {
        this.quarantineChild(child, startupToken, {
            afterExit: 'retry-bootstrap',
            terminalFailure: latchFailure,
            recoveryReasonCode: null,
        });
    }
    quarantineChild(child, startupToken, options) {
        const logger = this.options.logger ?? noopLogger;
        this.rejectAuthRotationsForChild(child, 'utility stopped before auth rotation completed');
        this.settleLogFlushesForChild(child);
        this.releaseChildCapabilities(child);
        const actualExit = new Promise((resolve) => {
            child.once('exit', () => resolve());
        });
        let quarantine;
        let slowExitTimer = null;
        const boundedStopResult = new Promise((resolve) => {
            this.options.executionContinuity.observeNow();
            const capturedEpoch = this.options.executionContinuity.capture();
            slowExitTimer = setTimeout(() => {
                slowExitTimer = null;
                this.options.executionContinuity.observeNow();
                if (this.state !== quarantine)
                    return;
                if (this.options.executionContinuity.isCurrent(capturedEpoch)) {
                    logger.error('[UtilityRuntime] utility process exit still unconfirmed after kill; remaining quarantined');
                    this.notifyLifecycle({
                        type: 'slow-exit',
                        attemptId: startupToken,
                        waitMs: KILL_CONFIRM_TIMEOUT_MS,
                        afterExit: quarantine.afterExit,
                    });
                }
                // This deadline only bounds the caller; it never opens the fork gate.
                // A discontinuous window suppresses slow-exit attribution but must not
                // turn a two-second StopResult into another unbounded wait.
                resolve({ status: 'quarantined', reason: 'exit-unconfirmed' });
            }, KILL_CONFIRM_TIMEOUT_MS);
            actualExit.then(() => {
                if (slowExitTimer)
                    clearTimeout(slowExitTimer);
                slowExitTimer = null;
                resolve({ status: 'exited' });
            });
        });
        quarantine = {
            phase: 'quarantined',
            child,
            startupToken,
            actualExit,
            boundedStopResult,
            afterExit: options.afterExit,
            terminalFailure: options.terminalFailure,
            recoveryReasonCode: options.recoveryReasonCode,
        };
        this.state = quarantine;
        void actualExit.then(() => this.finishQuarantine(quarantine));
        try {
            child.kill();
        }
        catch {
            logger.warn('[UtilityRuntime] kill of quarantined child failed');
        }
        return quarantine;
    }
    promoteQuarantineIntent(quarantine, requested) {
        const priority = {
            restart: 0,
            'retry-bootstrap': 1,
            'stay-stopped': 2,
        };
        if (priority[requested] > priority[quarantine.afterExit]) {
            quarantine.afterExit = requested;
        }
    }
    finishQuarantine(quarantine) {
        if (this.state !== quarantine)
            return;
        if (quarantine.terminalFailure) {
            this.state = { phase: 'failed', failure: quarantine.terminalFailure };
            return;
        }
        this.state = { phase: 'stopped' };
        if (quarantine.afterExit !== 'restart' || !quarantine.recoveryReasonCode)
            return;
        this.scheduleProactiveRestart(quarantine.startupToken, quarantine.recoveryReasonCode);
    }
    /**
     * Locale for user-facing failure text. A throwing resolver (the desktop
     * config store can fail to open) must not take down failure reporting, so it
     * degrades to English rather than propagating.
     */
    resolveIsEnglishLocale() {
        const resolve = this.options.resolveIsEnglishLocale;
        if (!resolve)
            return true;
        try {
            return resolve();
        }
        catch {
            (this.options.logger ?? noopLogger).warn('[UtilityRuntime] locale resolution failed; using English failure text');
            return true;
        }
    }
    /** Registers an init failure and returns whether the latch tripped. */
    countInitFailure() {
        this.openIncident();
        this.initFailureCount += 1;
        return this.initFailureCount >= MAX_INIT_FAILURES;
    }
    /**
     * Marks the start of a recovery incident, mirroring
     * UtilityRuntimeObserver's incident window (first failure while nothing is
     * open; closed by ready / stop / terminal).
     *
     * The latch budget belongs to ONE incident: attempts spent recovering from
     * an earlier, already-closed incident must not be charged to this one.
     * Without the scoping, MAX_INIT_FAILURES behaved as a process-lifetime latch
     * — a session that used 2 attempts and then had its runtime stopped would
     * give up on the FIRST failure of the next incident, reporting a recovery
     * that never attempted anything (attempt_count 0).
     */
    openIncident() {
        if (this.incidentOpen)
            return;
        this.incidentOpen = true;
        this.initFailureCount = 0;
    }
    /** Closes the incident window (recovered / interrupted). */
    closeIncident() {
        this.incidentOpen = false;
    }
    async launch(ready, settle) {
        const logger = this.options.logger ?? noopLogger;
        const startupToken = randomUUID();
        const launchStartedAt = Date.now();
        this.cancelScheduledRestart();
        const preparationTimeoutMs = this.options.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
        let preparationDeadline;
        const preparationTimeout = new Promise((resolve) => {
            const armPreparationDeadline = () => {
                this.options.executionContinuity.observeNow();
                const capturedEpoch = this.options.executionContinuity.capture();
                preparationDeadline = setTimeout(() => {
                    preparationDeadline = undefined;
                    this.options.executionContinuity.observeNow();
                    if (!this.options.executionContinuity.isCurrent(capturedEpoch)) {
                        armPreparationDeadline();
                        return;
                    }
                    resolve({
                        ok: false,
                        message: `utility process preparation timed out after ${preparationTimeoutMs}ms`,
                        reasonCode: 'bootstrap_timeout',
                    });
                }, preparationTimeoutMs);
            };
            armPreparationDeadline();
        });
        const preparation = await Promise.race([
            this.prepareLaunch(logger),
            preparationTimeout,
        ]);
        if (preparationDeadline)
            clearTimeout(preparationDeadline);
        if (!preparation.ok) {
            this.failLaunch(ready, settle, startupToken, preparation.message, preparation.reasonCode);
            return;
        }
        const preparationElapsedMs = Math.max(0, Date.now() - launchStartedAt);
        logger.info(`[UtilityRuntime] bootstrap preparation completed elapsed=${preparationElapsedMs}ms`);
        const { env, dataDir, browserAdapter, hostDiagnosticsProvider, appVersion, fork } = preparation.value;
        this.activeBrowserAdapter = browserAdapter;
        this.activeHostDiagnosticsProvider = hostDiagnosticsProvider;
        this.activeAppVersion = appVersion;
        // Piped stdio: the utility's console diagnostics (SDK fallbacks, seed
        // failures, drain errors) must land in main's file logger — inherited
        // stdio is discarded for packaged apps launched from Finder/Dock.
        let child;
        const bootstrapStartedAt = Date.now();
        try {
            child = fork(this.resolveEntryPath(), {
                serviceName: LOCAL_RUNTIME_UTILITY_SERVICE_NAME,
                env,
                stdio: 'pipe',
            });
        }
        catch {
            this.failLaunch(ready, settle, startupToken, 'utility process launch failed', 'unknown');
            return;
        }
        this.state = { phase: 'starting', child, startupToken, ready, settle };
        let stderrTail = '';
        child.stdout?.on('data', (chunk) => {
            const text = stripAnsi(chunk.toString()).trimEnd();
            if (text)
                logger.info(`[UtilityRuntime:stdout] ${text}`);
        });
        child.stderr?.on('data', (chunk) => {
            const stripped = stripAnsi(chunk.toString());
            const text = stripped.trimEnd();
            if (text)
                logger.warn(`[UtilityRuntime:stderr] ${text}`);
            stderrTail = `${stderrTail}${stripped}`.slice(-512);
            if (/OOM error in V8|JavaScript heap out of memory/i.test(stderrTail)) {
                this.requestRuntimeRecovery(child, startupToken, 'oom', 'V8 OOM detected on stderr');
            }
        });
        // Liveness watchdog: every other recovery path (backoff refork, failure
        // latch) keys off the exit event — a bootstrap that HANGS produces no
        // exit, so it must be killed and folded into the init-failure accounting.
        //
        // What is measured is the ABSENCE OF PROGRESS, not elapsed bootstrap time.
        // The child reports stages (control.ts) and each first-seen stage re-arms
        // the window, so a cold-disk/AV-throttled bootstrap that keeps moving is
        // allowed to finish instead of being killed mid-flight and restarted from
        // zero. The module substages are reported per-import and share a rank, so
        // either Promise.all completion order counts as progress.
        const stallTimeoutMs = this.options.bootstrapTimeoutMs ?? BOOTSTRAP_STALL_TIMEOUT_MS;
        const armedAt = bootstrapStartedAt;
        const reachedStages = [];
        /** First-seen set: makes substage arrival order irrelevant. */
        const reachedStageNames = new Set();
        let maxStageRank = -1;
        /** Duplicate / out-of-order arrivals; log-only attribution. */
        let ignoredProgressCount = 0;
        let stallTimer = null;
        const clearStallTimer = () => {
            if (!stallTimer)
                return;
            clearTimeout(stallTimer);
            stallTimer = null;
        };
        const onBootstrapStall = () => {
            stallTimer = null;
            if (!this.ownsChild(child))
                return;
            const latched = this.countInitFailure();
            const stalledStage = reachedStages.at(-1)?.stage ?? 'fork';
            logger.error(`[UtilityRuntime] bootstrap stalled at stage ${stalledStage} for ${stallTimeoutMs}ms ` +
                `(${this.initFailureCount}/${MAX_INIT_FAILURES}${latched ? ', giving up' : ''}` +
                `${ignoredProgressCount > 0 ? `, ${ignoredProgressCount} non-forward progress messages ignored` : ''}` +
                `); killing utility process`);
            const message = `utility bootstrap timed out after ${stallTimeoutMs}ms`;
            this.discardChild(child, latched ? { message, reasonCode: 'bootstrap_timeout' } : null, startupToken);
            settle(false);
            this.notifyLifecycle({
                type: 'startup-failed',
                attemptId: startupToken,
                reasonCode: 'bootstrap_timeout',
                terminal: latched,
                // Shares reason_code with the pre-fork preparation timeout, so name
                // the sub-cause here: a stalled stage means the child spawned and got
                // that far before going quiet.
                detail: formatBootstrapStallDetail(stalledStage, stallTimeoutMs, reachedStages),
            });
            this.notifyHost('onRuntimeFailed', () => this.options.onRuntimeFailed?.({
                message,
                terminal: latched,
                reasonCode: 'bootstrap_timeout',
            }));
        };
        const armStallTimer = () => {
            clearStallTimer();
            this.options.executionContinuity.observeNow();
            const capturedEpoch = this.options.executionContinuity.capture();
            stallTimer = setTimeout(() => {
                stallTimer = null;
                this.options.executionContinuity.observeNow();
                if (!this.options.executionContinuity.isCurrent(capturedEpoch)) {
                    if (this.ownsChild(child))
                        armStallTimer();
                    return;
                }
                onBootstrapStall();
            }, stallTimeoutMs);
        };
        const noteBootstrapProgress = (stage) => {
            // No armed timer means the bootstrap already settled (ready, failed or
            // discarded); a late ping must not resurrect the watchdog.
            if (!stallTimer || !this.ownsChild(child))
                return;
            this.options.executionContinuity.observeNow();
            const stageRank = utilityBootstrapStageRank(stage);
            // Forward progress is "a known stage seen for the FIRST time", not "a
            // higher index than last time": the two module substages share a rank
            // because they resolve out of one Promise.all in the child, so either
            // arrival order must count. Re-arming still requires rank >= the highest
            // reached, which keeps a genuinely backwards stage (and every duplicate)
            // from letting a chatty stuck child extend its window indefinitely.
            if (reachedStageNames.has(stage) || stageRank < maxStageRank) {
                ignoredProgressCount += 1;
                return;
            }
            reachedStageNames.add(stage);
            maxStageRank = stageRank;
            const elapsedMs = Math.max(0, Date.now() - armedAt);
            const previousElapsedMs = reachedStages.at(-1)?.elapsedMs ?? 0;
            reachedStages.push({ stage, elapsedMs });
            logger.info(`[UtilityRuntime] bootstrap progress stage=${stage} elapsed=${elapsedMs}ms ` +
                `since_previous=${Math.max(0, elapsedMs - previousElapsedMs)}ms`);
            armStallTimer();
        };
        armStallTimer();
        child.on('spawn', () => {
            const state = this.state;
            if (state.phase !== 'starting' || state.child !== child)
                return;
            try {
                const evalCapture = this.options.getEvalCaptureConfig?.();
                const startupExecutionPolicy = this.options.getStartupExecutionPolicy?.();
                const miniAppSurfaceEnabled = this.isMiniAppSurfaceEnabled();
                const runawayGuardConfig = this.options.getRunawayGuardConfig?.();
                const promptSuggestionPolicy = this.options.getPromptSuggestionPolicy?.();
                const toolResultCompactionConfig = this.options.getToolResultCompactionConfig?.();
                const collectionPolicy = this.options.getCollectionPolicy?.();
                const promptConfigKey = this.options.getPromptConfigKey?.();
                const init = {
                    type: 'runtime-init',
                    dataDir,
                    runtimeStartupToken: startupToken,
                    appVersion: this.activeAppVersion,
                    ...(startupExecutionPolicy ? { startupExecutionPolicy } : {}),
                    hostCapabilities: {
                        browser: Boolean(this.activeBrowserAdapter),
                        diagnostics: Boolean(this.activeHostDiagnosticsProvider),
                        ...(miniAppSurfaceEnabled ? { miniAppSurface: true } : {}),
                    },
                    authContext: this.options.getAuthContext?.(),
                    ...(promptConfigKey ? { promptConfigKey: [...promptConfigKey] } : {}),
                    contextWindowUsageEnabled: this.options.getContextWindowUsageEnabled?.() === true,
                    ...(runawayGuardConfig ? { runawayGuardConfig } : {}),
                    ...(promptSuggestionPolicy ? { promptSuggestionPolicy } : {}),
                    ...(toolResultCompactionConfig &&
                        (toolResultCompactionConfig.enabled !== undefined ||
                            toolResultCompactionConfig.maxInlineBytes !== undefined ||
                            toolResultCompactionConfig.mcpDetailsMaxInlineBytes !== undefined ||
                            toolResultCompactionConfig.watermarkBytes !== undefined ||
                            toolResultCompactionConfig.minSavingsBytes !== undefined ||
                            toolResultCompactionConfig.minCandidateBytes !== undefined ||
                            toolResultCompactionConfig.keepRecentRounds !== undefined ||
                            toolResultCompactionConfig.checkpointSharedPrefix !== undefined)
                        ? { toolResultCompactionConfig }
                        : {}),
                    ...(collectionPolicy ? { collectionPolicy } : {}),
                    ...(this.routingContext ? { routingContext: this.routingContext } : {}),
                    ...(evalCapture ? { evalCapture } : {}),
                };
                const computerChannel = this.options.getComputerUseChannel?.();
                if (computerChannel) {
                    child.postMessage({ ...init, computerUseGeneration: computerChannel.generation ?? 1 }, [
                        computerChannel.transfer,
                    ]);
                }
                else {
                    child.postMessage(init);
                }
            }
            catch {
                clearStallTimer();
                const latched = this.countInitFailure();
                const message = 'utility runtime initialization handshake failed';
                this.discardChild(child, latched ? { message, reasonCode: 'handshake_failed' } : null, startupToken);
                settle(false);
                logger.error(`[UtilityRuntime] ${message}`);
                this.notifyLifecycle({
                    type: 'startup-failed',
                    attemptId: startupToken,
                    reasonCode: 'handshake_failed',
                    terminal: latched,
                });
                this.notifyHost('onRuntimeFailed', () => this.options.onRuntimeFailed?.({
                    message,
                    terminal: latched,
                    reasonCode: 'handshake_failed',
                }));
            }
        });
        child.on('message', (raw) => {
            const state = this.state;
            if ((state.phase !== 'starting' && state.phase !== 'ready') || state.child !== child) {
                return;
            }
            if (this.browserBroker.handleMessage(child, raw))
                return;
            if (this.diagnosticsBroker.handleMessage(child, raw))
                return;
            if (isRuntimeComputerUseRequiredMessage(raw)) {
                void this.resolveComputerUseRequirement(child, raw.requestId);
                return;
            }
            if (this.authRecoveryBroker.handleMessage(child, raw))
                return;
            if (this.miniAppSurfaceBroker.handleMessage(child, raw))
                return;
            if (this.miniAppToolBroker.handleMessage(child, raw))
                return;
            if (this.miniAppBroker.handleMessage(child, raw))
                return;
            if (isRuntimeMemorySampleMessage(raw)) {
                this.notifyHost('onRuntimeMemorySample', () => this.options.onRuntimeMemorySample?.({
                    ...raw,
                    startupToken,
                    processId: typeof child.pid === 'number' && Number.isInteger(child.pid) && child.pid > 0
                        ? child.pid
                        : null,
                }));
                return;
            }
            if (isRuntimeMemoryMonitorResponse(raw)) {
                this.settleRuntimeMemoryMonitorRequest(raw, child);
                return;
            }
            if (!isUtilityStatusMessage(raw))
                return;
            if (raw.type === 'runtime-session-report-result' ||
                raw.type === 'runtime-session-report-error') {
                this.settleSessionReport(raw, child);
                return;
            }
            if (raw.type === 'runtime-auth-context-applied') {
                this.completeAuthRotation(raw.requestId, child);
                return;
            }
            if (raw.type === 'runtime-logs-flushed') {
                this.settleLogFlush(raw.requestId, true, child);
                return;
            }
            if (raw.type === 'runtime-port-disconnected')
                return;
            if (raw.type === 'runtime-skill-registry-diagnostic') {
                this.notifyHost('onSkillRegistryDiagnostic', () => this.options.onSkillRegistryDiagnostic?.({
                    ...raw,
                    startupToken,
                    processId: typeof child.pid === 'number' && Number.isInteger(child.pid) && child.pid > 0
                        ? child.pid
                        : null,
                }));
                return;
            }
            if (raw.type === 'runtime-workspace-indexing-observation') {
                this.notifyHost('onWorkspaceIndexingObservation', () => this.options.onWorkspaceIndexingObservation?.(raw));
                return;
            }
            if (raw.type === 'runtime-database-migration') {
                if (state.phase === 'starting') {
                    this.notifyLifecycle({
                        type: 'database-migration',
                        attemptId: startupToken,
                        event: raw.event,
                    });
                }
                return;
            }
            if (raw.type === 'runtime-bootstrap-progress') {
                noteBootstrapProgress(raw.stage);
                return;
            }
            if (raw.type === 'runtime-health') {
                this.noteRuntimeHealth(child, startupToken, raw);
                return;
            }
            if (raw.type === 'runtime-ready') {
                clearStallTimer();
                const readyAt = Date.now();
                this.state = { phase: 'ready', child, startupToken, readyAt };
                this.initFailureCount = 0;
                this.closeIncident();
                this.startRuntimeHealthWatchdog(child, startupToken);
                const bootstrapElapsedMs = Math.max(0, readyAt - bootstrapStartedAt);
                const sinceLastStageMs = Math.max(0, bootstrapElapsedMs - (reachedStages.at(-1)?.elapsedMs ?? 0));
                logger.info(`[UtilityRuntime] ready total=${Math.max(0, readyAt - launchStartedAt)}ms ` +
                    `preparation=${preparationElapsedMs}ms bootstrap=${bootstrapElapsedMs}ms ` +
                    `since_last_stage=${sinceLastStageMs}ms stages=(${formatBootstrapProgress(reachedStages)})`);
                settle(true);
                this.notifyLifecycle({ type: 'ready', attemptId: startupToken });
                this.notifyHost('onRuntimeReady', () => this.options.onRuntimeReady?.());
                return;
            }
            if (raw.type === 'runtime-init-failed') {
                clearStallTimer();
                const ownerConflict = raw.ownerConflict;
                // The budget is still consumed (and the incident still opened) so the
                // bookkeeping reads the same for every init failure; the owner
                // conflict only short-circuits what remains of it.
                const budgetExhausted = this.countInitFailure();
                const latched = budgetExhausted || ownerConflict !== undefined;
                const reasonCode = ownerConflict !== undefined ? 'runtime_owner_conflict' : 'init_failed';
                // For an owner conflict the user-facing string replaces the raw
                // diagnostic: it is the value getRuntimeFailReason() surfaces in the
                // startup-failure UI, and "another client is running, quit it" is the
                // only part of this failure a user can act on. `detail` below still
                // carries the full diagnostic for logs and telemetry.
                //
                // `detail` is validated by isUtilityStatusMessage (single line,
                // bounded, no control chars); propagate it so the failure stays
                // attributable in main logs and the startup-failure UI.
                const failMessage = ownerConflict !== undefined
                    ? describeRuntimeOwnerConflict(ownerConflict, this.resolveIsEnglishLocale())
                    : raw.detail
                        ? `utility runtime initialization failed: ${raw.detail}`
                        : 'utility runtime initialization failed';
                logger.error(`[UtilityRuntime] init failed (${this.initFailureCount}/${MAX_INIT_FAILURES}${latched ? ', giving up' : ''})${raw.detail ? `: ${raw.detail}` : ''}`);
                if (ownerConflict !== undefined) {
                    // Retrying an active owner lease cannot succeed — the other client
                    // is still running — and every extra attempt can leave another lease
                    // file behind. Log the skip so a single-attempt incident is not read
                    // as the retry loop silently going missing.
                    logger.warn(`[UtilityRuntime] runtime owner conflict (holderPid=${ownerConflict.holderPid ?? 'unknown'}); failing fast, skipping ${MAX_INIT_FAILURES - this.initFailureCount} remaining ` +
                        'init retries');
                }
                this.discardChild(child, latched ? { message: failMessage, reasonCode } : null, startupToken);
                settle(false);
                this.notifyLifecycle({
                    type: 'startup-failed',
                    attemptId: startupToken,
                    reasonCode,
                    terminal: latched,
                    ...(raw.detail !== undefined ? { detail: raw.detail } : {}),
                });
                this.notifyHost('onRuntimeFailed', () => this.options.onRuntimeFailed?.({
                    message: failMessage,
                    terminal: latched,
                    reasonCode,
                }));
            }
        });
        child.on('exit', (code) => {
            // A discarded child (init failure, replaced handle) must not touch
            // the state machine of whatever is running now.
            if (!this.ownsChild(child))
                return;
            clearStallTimer();
            this.clearRuntimeHealthWatchdog(child);
            this.releaseChildCapabilities(child);
            this.rejectAuthRotationsForChild(child, 'utility exited before auth rotation completed');
            this.settleLogFlushesForChild(child);
            // Snapshot BEFORE any mutation: the prior phase decides the branch and
            // (for 'ready') carries the per-child readyAt the stability check needs.
            const prior = this.state;
            settle(false);
            if (prior.phase === 'stopping' || prior.phase === 'quarantined') {
                return; // stop/quarantine actual-exit continuations own the transition
            }
            if (prior.phase === 'starting') {
                const latched = this.countInitFailure();
                const message = `utility exited before ready (code=${code})`;
                const detail = formatBootstrapExitDetail(code, Math.max(0, Date.now() - armedAt), reachedStages);
                logger.error(`[UtilityRuntime] ${message} (${this.initFailureCount}/${MAX_INIT_FAILURES}${latched ? ', giving up' : ''})`);
                this.state = latched
                    ? { phase: 'failed', failure: { message, reasonCode: 'process_exit', exitCode: code } }
                    : { phase: 'stopped' };
                this.notifyLifecycle({
                    type: 'startup-failed',
                    attemptId: startupToken,
                    reasonCode: 'process_exit',
                    terminal: latched,
                    exitCode: code,
                    detail,
                });
                this.notifyHost('onRuntimeFailed', () => this.options.onRuntimeFailed?.({
                    message,
                    terminal: latched,
                    reasonCode: 'process_exit',
                }));
                return;
            }
            this.state = { phase: 'stopped' };
            // Reset both recovery backoff and the separate crash-loop counter after
            // a stable run so one crash a day does not accumulate toward the cap.
            // Stability is measured from this child's READY transition (carried in
            // the state union), never from spawn: a slow bootstrap in front of a
            // deterministic post-ready crash must not disarm the breaker.
            const stableUptimeMs = this.options.stableUptimeMs ?? DEFAULT_STABLE_UPTIME_MS;
            if (prior.phase === 'ready' && Date.now() - prior.readyAt >= stableUptimeMs) {
                this.restartAttempts = 0;
                this.crashLoopReforks = 0;
            }
            if (this.crashLoopReforks >= MAX_CRASH_LOOP_REFORKS) {
                // Crash-loop breaker: a supervisor must not restart a deterministically
                // failing child forever. This exit is the (spent reforks + 1)-th
                // abnormal exit since the last stable run, so the whole budget
                // produced no stable run and another refork would only repeat the
                // same failure.
                const abnormalExits = this.crashLoopReforks + 1;
                const reason = `${abnormalExits} abnormal exits since the last stable run`;
                const message = `utility crash loop: ${reason} (last code=${code})`;
                // Cancel before publishing the terminal phase: "latched" must never
                // coexist with an armed refork.
                this.cancelScheduledRestart();
                this.state = {
                    phase: 'failed',
                    failure: { message, reasonCode: 'crash_loop', exitCode: code },
                };
                logger.error(`[UtilityRuntime] crash loop: ${reason} ` +
                    `(${this.crashLoopReforks}/${MAX_CRASH_LOOP_REFORKS} reforks spent, ` +
                    `last code=${code}, attemptId=${startupToken}); giving up`);
                // runtime-exited/onRuntimeLost still come first: renderers must learn
                // the transport is gone before they learn it is not coming back.
                this.notifyLifecycle({ type: 'runtime-exited', attemptId: startupToken, exitCode: code });
                this.notifyHost('onRuntimeLost', () => this.options.onRuntimeLost?.({ code }));
                this.notifyLifecycle({
                    type: 'runtime-failed',
                    attemptId: startupToken,
                    reasonCode: 'crash_loop',
                    terminal: true,
                    exitCode: code,
                });
                this.notifyHost('onRuntimeFailed', () => this.options.onRuntimeFailed?.({
                    message,
                    terminal: true,
                    reasonCode: 'crash_loop',
                }));
                return;
            }
            logger.warn(`[UtilityRuntime] exited unexpectedly (code=${code}); scheduling refork ` +
                `(${this.crashLoopReforks + 1}/${MAX_CRASH_LOOP_REFORKS})`);
            // A crash of a ready child opens a runtime-phase incident (the observer
            // does the same); the refork attempts that follow belong to it.
            this.openIncident();
            this.notifyLifecycle({ type: 'runtime-exited', attemptId: startupToken, exitCode: code });
            this.notifyHost('onRuntimeLost', () => this.options.onRuntimeLost?.({ code }));
            this.scheduleRestart(true);
        });
    }
    async resolveComputerUseRequirement(child, requestId) {
        let ready = false;
        try {
            ready = (await this.options.ensureComputerUseReady?.()) === true;
        }
        catch {
            ready = false;
        }
        if (!this.ownsChild(child))
            return;
        try {
            child.postMessage({
                type: 'runtime-computer-use-ready',
                requestId,
                ready,
            });
        }
        catch {
            (this.options.logger ?? noopLogger).warn('[UtilityRuntime] Computer Use readiness result delivery failed');
        }
    }
    async prepareLaunch(logger) {
        let forkEnvironment;
        try {
            forkEnvironment = await this.buildForkEnv();
        }
        catch {
            return {
                ok: false,
                message: 'utility fork environment preparation failed',
                reasonCode: 'env_prepare_failed',
            };
        }
        let browserAdapter;
        let hostDiagnosticsProvider;
        let appVersion = 'unknown';
        try {
            browserAdapter = this.options.getBrowserAdapter?.();
        }
        catch {
            logger.warn('[UtilityRuntime] Browser capability registration failed; broker disabled');
        }
        try {
            hostDiagnosticsProvider = await this.options.getHostDiagnosticsProvider?.();
        }
        catch {
            logger.warn('[UtilityRuntime] diagnostics capability registration failed; broker disabled');
        }
        try {
            const resolvedAppVersion = this.options.getAppVersion?.().trim();
            if (resolvedAppVersion)
                appVersion = resolvedAppVersion;
        }
        catch {
            logger.warn('[UtilityRuntime] app version lookup failed; using unknown');
        }
        let fork = this.options.forkUtilityProcess;
        if (!fork) {
            let electron;
            try {
                const loadElectron = this.options.loadElectron ?? (() => import('electron'));
                electron = await loadElectron();
            }
            catch {
                return {
                    ok: false,
                    message: 'utility process API unavailable',
                    reasonCode: 'unknown',
                };
            }
            fork = (entryPath, forkOptions) => electron.utilityProcess.fork(entryPath, [], forkOptions);
        }
        return {
            ok: true,
            value: { ...forkEnvironment, browserAdapter, hostDiagnosticsProvider, appVersion, fork },
        };
    }
    scheduleRestart(countsTowardCrashLoop) {
        if (this.restartTimer)
            return;
        const maxBackoffMs = this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.restartAttempts, maxBackoffMs);
        let settle;
        const ready = new Promise((resolve) => {
            settle = resolve;
        });
        this.state = { phase: 'backoff', ready, settle };
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            const state = this.state;
            if (state.phase !== 'backoff' || state.ready !== ready)
                return;
            // Counters describe reforks that RUN: incrementing here (not when the
            // timer is armed) means cancellation by stop() spends neither backoff
            // state nor crash-loop budget for a launch that did not happen.
            this.restartAttempts += 1;
            if (countsTowardCrashLoop)
                this.crashLoopReforks += 1;
            // Both unexpected-exit and proactive-recycle callers arm this only
            // after their exit gate confirms the old process is gone, so its SQLite
            // lock is released before the new fork.
            this.state = { phase: 'launching', ready };
            void this.launch(ready, settle);
        }, delay);
    }
    scheduleProactiveRestart(attemptId, reasonCode) {
        const configuredMax = this.options.proactiveRecoveryMaxAttempts;
        const maxAttempts = typeof configuredMax === 'number' && Number.isSafeInteger(configuredMax) && configuredMax > 0
            ? configuredMax
            : DEFAULT_PROACTIVE_RECOVERY_MAX_ATTEMPTS;
        if (this.proactiveRecoveryAttempts < maxAttempts) {
            this.scheduleRestart(false);
            return;
        }
        const configuredCooldown = this.options.proactiveRecoveryCooldownMs;
        const baseCooldownMs = typeof configuredCooldown === 'number' &&
            Number.isFinite(configuredCooldown) &&
            configuredCooldown > 0
            ? configuredCooldown
            : DEFAULT_PROACTIVE_RECOVERY_COOLDOWN_MS;
        const exhaustedAttempts = this.proactiveRecoveryAttempts - maxAttempts - 1;
        const cooldownMs = Math.min(baseCooldownMs * 2 ** Math.max(0, exhaustedAttempts), MAX_PROACTIVE_RECOVERY_COOLDOWN_MS);
        let settle;
        const ready = new Promise((resolve) => {
            settle = resolve;
        });
        this.state = { phase: 'cooldown', ready, settle, attemptId, reasonCode };
        (this.options.logger ?? noopLogger).error(`[UtilityRuntime] proactive recovery budget exhausted after ${this.proactiveRecoveryAttempts} attempts; ` +
            `cooling down for ${cooldownMs}ms`);
        this.notifyLifecycle({
            type: 'runtime-recovery-cooldown',
            attemptId,
            reasonCode,
            attemptCount: this.proactiveRecoveryAttempts,
            cooldownMs,
        });
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            const state = this.state;
            if (state.phase !== 'cooldown' || state.ready !== ready)
                return;
            this.restartAttempts += 1;
            this.state = { phase: 'launching', ready };
            void this.launch(ready, settle);
        }, cooldownMs);
    }
    startRuntimeHealthWatchdog(child, startupToken) {
        this.clearRuntimeHealthWatchdog();
        this.runtimeHealthChild = child;
        this.lastRuntimeHealthSequence = -1;
        this.consecutiveMemoryPressureSamples = 0;
        this.armRuntimeHealthWatchdog(child, startupToken);
    }
    armRuntimeHealthWatchdog(child, startupToken) {
        if (this.options.runtimeHealthTimeoutMs === false)
            return;
        if (this.runtimeHealthTimer)
            clearTimeout(this.runtimeHealthTimer);
        const configured = this.options.runtimeHealthTimeoutMs;
        const timeoutMs = typeof configured === 'number' && Number.isFinite(configured) && configured > 0
            ? configured
            : DEFAULT_RUNTIME_HEALTH_TIMEOUT_MS;
        this.options.executionContinuity.observeNow();
        const capturedEpoch = this.options.executionContinuity.capture();
        this.runtimeHealthTimer = setTimeout(() => {
            this.runtimeHealthTimer = null;
            this.options.executionContinuity.observeNow();
            if (!this.options.executionContinuity.isCurrent(capturedEpoch)) {
                const state = this.state;
                if (state.phase === 'ready' && state.child === child) {
                    this.armRuntimeHealthWatchdog(child, startupToken);
                }
                return;
            }
            this.requestRuntimeRecovery(child, startupToken, 'runtime_unresponsive', `health timed out after ${timeoutMs}ms`);
        }, timeoutMs);
    }
    noteRuntimeHealth(child, startupToken, health) {
        const state = this.state;
        if (state.phase !== 'ready' || state.child !== child)
            return;
        if (health.sequence <= this.lastRuntimeHealthSequence)
            return;
        this.options.executionContinuity.observeNow();
        this.lastRuntimeHealthSequence = health.sequence;
        this.armRuntimeHealthWatchdog(child, startupToken);
        this.notifyHost('onRuntimeHealthSample', () => this.options.onRuntimeHealthSample?.({
            ...health,
            startupToken,
            processId: typeof child.pid === 'number' && Number.isInteger(child.pid) && child.pid > 0
                ? child.pid
                : null,
        }));
        const configuredThreshold = this.options.memoryPressureThreshold;
        const threshold = typeof configuredThreshold === 'number' &&
            Number.isFinite(configuredThreshold) &&
            configuredThreshold > 0 &&
            configuredThreshold < 1
            ? configuredThreshold
            : DEFAULT_MEMORY_PRESSURE_THRESHOLD;
        const ratio = health.heapUsedBytes / health.heapSizeLimitBytes;
        const stableUptimeMs = this.options.stableUptimeMs ?? DEFAULT_STABLE_UPTIME_MS;
        if (ratio < threshold && Date.now() - state.readyAt >= stableUptimeMs) {
            this.proactiveRecoveryAttempts = 0;
        }
        this.consecutiveMemoryPressureSamples =
            ratio >= threshold ? this.consecutiveMemoryPressureSamples + 1 : 0;
        const configuredSamples = this.options.memoryPressureConsecutiveSamples;
        const requiredSamples = typeof configuredSamples === 'number' &&
            Number.isSafeInteger(configuredSamples) &&
            configuredSamples > 0
            ? configuredSamples
            : DEFAULT_MEMORY_PRESSURE_CONSECUTIVE_SAMPLES;
        if (this.consecutiveMemoryPressureSamples < requiredSamples)
            return;
        this.requestRuntimeRecovery(child, startupToken, 'memory_pressure', `heap usage ${Math.round(ratio * 100)}% exceeded ${Math.round(threshold * 100)}% threshold`);
    }
    requestRuntimeRecovery(child, startupToken, reasonCode, detail) {
        const state = this.state;
        if (state.phase !== 'ready' || state.child !== child)
            return;
        const logger = this.options.logger ?? noopLogger;
        // Native surfaces are grants from this exact Utility generation. Revoke
        // them before publishing recovery or starting any replacement work.
        this.revokeMiniAppGeneration(child);
        logger.error(`[UtilityRuntime] ${detail}; recycling utility process`);
        this.clearRuntimeHealthWatchdog(child);
        this.openIncident();
        this.notifyLifecycle({
            type: 'runtime-recovery-started',
            attemptId: startupToken,
            reasonCode,
        });
        this.notifyHost('onRuntimeLost', () => this.options.onRuntimeLost?.({ code: 1, reasonCode }));
        const stableUptimeMs = this.options.stableUptimeMs ?? DEFAULT_STABLE_UPTIME_MS;
        if (Date.now() - state.readyAt >= stableUptimeMs) {
            this.restartAttempts = 0;
            this.crashLoopReforks = 0;
        }
        this.proactiveRecoveryAttempts += 1;
        this.quarantineChild(child, startupToken, {
            afterExit: 'restart',
            terminalFailure: null,
            recoveryReasonCode: reasonCode,
        });
    }
    clearRuntimeHealthWatchdog(child) {
        if (child && this.runtimeHealthChild && this.runtimeHealthChild !== child)
            return;
        if (this.runtimeHealthTimer)
            clearTimeout(this.runtimeHealthTimer);
        this.runtimeHealthTimer = null;
        this.runtimeHealthChild = null;
        this.lastRuntimeHealthSequence = -1;
        this.consecutiveMemoryPressureSamples = 0;
    }
    cancelScheduledRestart() {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        const state = this.state;
        if (state.phase === 'backoff' || state.phase === 'cooldown') {
            this.state = { phase: 'stopped' };
            state.settle(false);
        }
    }
    failLaunch(ready, settle, startupToken, message, reasonCode) {
        const state = this.state;
        if (state.phase === 'launching' && state.ready === ready) {
            this.state = { phase: 'stopped' };
        }
        this.activeBrowserAdapter = undefined;
        this.activeHostDiagnosticsProvider = undefined;
        this.activeAppVersion = 'unknown';
        (this.options.logger ?? noopLogger).error(`[UtilityRuntime] ${message}`);
        settle(false);
        // Pre-fork failures are not charged to the latch, but they DO open the
        // incident so a following post-fork failure keeps accumulating in it.
        this.openIncident();
        this.notifyLifecycle({
            type: 'startup-failed',
            attemptId: startupToken,
            reasonCode,
            terminal: false,
            // Every failLaunch message is a fixed internal string (preparation
            // timeout, env prep, missing utilityProcess API, fork throw), so it can
            // be forwarded verbatim; the observer redacts and bounds it anyway.
            // Without it 'bootstrap_timeout' cannot be told apart from the
            // post-fork handshake watchdog.
            detail: message,
        });
        this.notifyHost('onRuntimeFailed', () => this.options.onRuntimeFailed?.({ message, terminal: false, reasonCode }));
    }
    releaseChildCapabilities(child) {
        this.revokeMiniAppGeneration(child);
        this.clearRuntimeHealthWatchdog(child);
        this.rejectSessionReportsForChild(child, 'session_report_runtime_stopped');
        this.rejectRuntimeMemoryMonitorRequestsForChild(child, 'utility stopped before memory monitor request completed');
        this.browserBroker.releaseTarget(child);
        this.diagnosticsBroker.releaseTarget(child);
        this.miniAppSurfaceBroker.releaseTarget(child);
        this.miniAppToolBroker.releaseTarget(child);
        this.miniAppBroker.releaseTarget(child);
        this.activeBrowserAdapter = undefined;
        this.activeHostDiagnosticsProvider = undefined;
        this.activeAppVersion = 'unknown';
        this.rendererConnectionIds.clear();
    }
    isMiniAppSurfaceEnabled() {
        if (!this.options.openMiniAppSurface)
            return false;
        try {
            return this.options.isMiniAppSurfaceEnabled?.() ?? true;
        }
        catch {
            (this.options.logger ?? noopLogger).warn('[UtilityRuntime] Mini App surface gate lookup failed; broker disabled');
            return false;
        }
    }
    revokeMiniAppGeneration(child) {
        if (this.revokedMiniAppGenerations.has(child))
            return;
        this.revokedMiniAppGenerations.add(child);
        this.notifyHost('onMiniAppGenerationLost', () => this.options.onMiniAppGenerationLost?.());
    }
}

