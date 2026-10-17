/**
 * Team host-utils: registry for team-specific runtime ports.
 *
 * Hosts (daemon today, cloud-runtime later) call {@link configureTeamHost}
 * once at startup with concrete implementations of the ports declared in
 * `host-ports.ts`. The team orchestration code (`engine.ts`,
 * `engine-production.ts`, `engine-verification.ts`,
 * `engine-reporting.ts`, `engine-session.ts`, `board-watcher.ts`,
 * `gc.ts`, `plan-store.ts`) imports these helpers and resolves the live
 * port at call time so a swap-after-import cycle picks up the host's
 * wiring.
 *
 * Cross-cutting helpers (`logger`, `getMetricsReporter`, `backgroundCtx`,
 * `AppError`, `nowMs`, `formatLocalDateTime`) are team-owned runtime
 * collaborators. Hosts may override them through {@link configureTeamHost};
 * otherwise safe test fallbacks are used.
 */
import { randomUUID } from 'node:crypto';
const noopLogger = {
    trace: () => { },
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { },
    fatal: () => { },
    child: () => noopLogger,
};
let _logger = noopLogger;
export const logger = {
    trace: (...args) => _logger.trace(...args),
    debug: (...args) => _logger.debug(...args),
    info: (...args) => _logger.info(...args),
    warn: (...args) => _logger.warn(...args),
    error: (...args) => _logger.error(...args),
    fatal: (...args) => _logger.fatal(...args),
    child: (bindings) => buildLiveChild(bindings),
};
function buildLiveChild(bindings) {
    return {
        trace: (...args) => _logger.child(bindings).trace(...args),
        debug: (...args) => _logger.child(bindings).debug(...args),
        info: (...args) => _logger.child(bindings).info(...args),
        warn: (...args) => _logger.child(bindings).warn(...args),
        error: (...args) => _logger.child(bindings).error(...args),
        fatal: (...args) => _logger.child(bindings).fatal(...args),
        child: (extra) => buildLiveChild({ ...bindings, ...extra }),
    };
}
let _backgroundCtxFactory = () => ({
    traceId: randomUUID().replaceAll('-', ''),
});
export function backgroundCtx() {
    return _backgroundCtxFactory();
}
const noopMetricsReporter = {
    incr: () => { },
    gauge: () => { },
    latency: () => { },
};
let _metricsReporter = noopMetricsReporter;
export function getMetricsReporter() {
    return _metricsReporter;
}
class FallbackAppError extends Error {
    code;
    statusCode;
    constructor(message, code, statusCode = 500, options) {
        super(message, options);
        this.name = 'AppError';
        this.code = code;
        this.statusCode = statusCode;
    }
}
let _AppError = FallbackAppError;
export const AppError = new Proxy(FallbackAppError, {
    construct(_target, args) {
        const [message, code, statusCode, options] = args;
        return new _AppError(message, code, statusCode ?? 500, options);
    },
    get(_target, prop) {
        return Reflect.get(_AppError, prop);
    },
});
const fallbackDatetimeHelpers = {
    nowMs: () => Date.now(),
    formatLocalDateTime: (ts) => {
        const d = ts instanceof Date ? ts : new Date(ts);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
    },
};
let _datetimeHelpers = fallbackDatetimeHelpers;
export function nowMs() {
    return _datetimeHelpers.nowMs();
}
export function formatLocalDateTime(ts) {
    return _datetimeHelpers.formatLocalDateTime(ts);
}
// ─── Team-specific port slots ────────────────────────────────────────
const fallbackThrow = (label) => {
    throw new Error(`[@mavis/team] No ${label} registered. Hosts must call ` +
        `configureTeamHost(...) before team orchestration runs.`);
};
const fallbackPlanStore = {
    getPlan: () => fallbackThrow('PlanStorePort'),
    getState: () => fallbackThrow('PlanStorePort'),
    getAllTasks: () => fallbackThrow('PlanStorePort'),
    getBoardPath: () => fallbackThrow('PlanStorePort'),
    listAll: () => fallbackThrow('PlanStorePort'),
    isTerminal: () => fallbackThrow('PlanStorePort'),
    updateState: () => fallbackThrow('PlanStorePort'),
    updateTaskResult: () => fallbackThrow('PlanStorePort'),
    addTasks: () => fallbackThrow('PlanStorePort'),
    extendTaskTimeout: () => fallbackThrow('PlanStorePort'),
    delete: () => fallbackThrow('PlanStorePort'),
};
const fallbackSessionLifecycle = {
    getSession: async () => fallbackThrow('SessionLifecyclePort'),
    abortSession: async () => fallbackThrow('SessionLifecyclePort'),
    setSessionArchived: async () => fallbackThrow('SessionLifecyclePort'),
    getRecentMessages: async () => fallbackThrow('SessionLifecyclePort'),
};
const fallbackSessionBridge = {
    onResponse: () => () => undefined,
    sendMessage: async () => fallbackThrow('SessionBridgePort'),
};
const fallbackCommunication = {
    send: async () => fallbackThrow('CommunicationManagerPort'),
};
const fallbackAgentManager = {
    getAgent: async () => fallbackThrow('AgentManagerPort'),
};
let _planStore = fallbackPlanStore;
let _sessionLifecycle = fallbackSessionLifecycle;
let _sessionBridge = fallbackSessionBridge;
let _communication = fallbackCommunication;
let _agentManager = fallbackAgentManager;
export function getPlanStore() {
    return _planStore;
}
export function getSessionLifecycle() {
    return _sessionLifecycle;
}
export function getSessionBridge() {
    return _sessionBridge;
}
export function getCommunicationManager() {
    return _communication;
}
export function getAgentManager() {
    return _agentManager;
}
/**
 * Configure the team-specific port slots.
 *
 * Daemon container calls this once during `initRuntime` after building
 * the concrete `PlanStore`, `SessionService`, `SessionBridge`,
 * `CommunicationManager`, and `AgentManager` instances. Tests can inject
 * stubs via partial options; ports left undefined keep their fallbacks
 * (which throw with a clear message on first use).
 */
export function configureTeamHost(opts) {
    if (opts.planStore)
        _planStore = opts.planStore;
    if (opts.sessionLifecycle)
        _sessionLifecycle = opts.sessionLifecycle;
    if (opts.sessionBridge)
        _sessionBridge = opts.sessionBridge;
    if (opts.communicationManager)
        _communication = opts.communicationManager;
    if (opts.agentManager)
        _agentManager = opts.agentManager;
    if (opts.logger)
        _logger = opts.logger;
    if (opts.metricsReporter)
        _metricsReporter = opts.metricsReporter;
    if (opts.backgroundCtx)
        _backgroundCtxFactory = opts.backgroundCtx;
    if (opts.appError)
        _AppError = opts.appError;
    if (opts.datetimeHelpers)
        _datetimeHelpers = { ..._datetimeHelpers, ...opts.datetimeHelpers };
}
/**
 * Reset the team host registry to fallbacks. Intended for tests; daemon
 * production code should call {@link configureTeamHost} once at startup.
 */
export function resetTeamHostForTesting() {
    _planStore = fallbackPlanStore;
    _sessionLifecycle = fallbackSessionLifecycle;
    _sessionBridge = fallbackSessionBridge;
    _communication = fallbackCommunication;
    _agentManager = fallbackAgentManager;
    _logger = noopLogger;
    _metricsReporter = noopMetricsReporter;
    _backgroundCtxFactory = () => ({ traceId: randomUUID().replaceAll('-', '') });
    _AppError = FallbackAppError;
    _datetimeHelpers = fallbackDatetimeHelpers;
}
//# sourceMappingURL=host-utils.js.map