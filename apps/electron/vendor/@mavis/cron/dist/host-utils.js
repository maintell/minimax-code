/**
 * Cron host-utils: registry for cron-specific runtime ports.
 *
 * Hosts (daemon today, cloud-runtime later) call {@link configureCronHost}
 * once at startup with concrete implementations of the ports declared in
 * `host-ports.ts`. The cron orchestrator code (`executor.ts`,
 * `registry.ts`) imports these helpers and resolves the live port at
 * call time so a swap-after-import cycle picks up the host's wiring.
 *
 * Cross-cutting helpers (`logger`, `getMetricsReporter`, `backgroundCtx`,
 * `AppError`, `nowMs`, `formatLocalMonthDayTime`) are cron-owned runtime
 * collaborators. Hosts override them through {@link configureCronHost};
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
    formatLocalMonthDayTime: (ts) => {
        const d = ts instanceof Date ? ts : new Date(ts);
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return `${mm}-${dd} ${hh}:${mi}`;
    },
};
let _datetimeHelpers = fallbackDatetimeHelpers;
export function nowMs() {
    return _datetimeHelpers.nowMs();
}
export function formatLocalMonthDayTime(ts) {
    return _datetimeHelpers.formatLocalMonthDayTime(ts);
}
// ─── Cron-specific port slots ────────────────────────────────────────────
const fallbackThrow = (label) => {
    throw new Error(`[@mavis/cron] No ${label} registered. Hosts must call ` +
        `configureCronHost(...) before cron orchestration runs.`);
};
const fallbackCronStore = {
    configPath: () => Promise.resolve(fallbackThrow('CronStorePort')),
    get: () => Promise.resolve(fallbackThrow('CronStorePort')),
    listByAgent: () => Promise.resolve(fallbackThrow('CronStorePort')),
    listAll: () => Promise.resolve(fallbackThrow('CronStorePort')),
    create: () => Promise.resolve(fallbackThrow('CronStorePort')),
    update: () => Promise.resolve(fallbackThrow('CronStorePort')),
    delete: () => Promise.resolve(fallbackThrow('CronStorePort')),
    appendSessionRun: () => Promise.resolve(fallbackThrow('CronStorePort')),
    getSessionHistory: () => Promise.resolve(fallbackThrow('CronStorePort')),
    replaceSessionHistory: () => Promise.resolve(fallbackThrow('CronStorePort')),
    deleteSessionHistory: () => Promise.resolve(fallbackThrow('CronStorePort')),
};
const fallbackSessionLifecycle = {
    getRootSession: () => Promise.resolve(fallbackThrow('SessionLifecyclePort')),
    getSession: () => Promise.resolve(fallbackThrow('SessionLifecyclePort')),
    getSessionStatus: () => Promise.resolve(fallbackThrow('SessionLifecyclePort')),
    setSessionArchived: () => Promise.resolve(fallbackThrow('SessionLifecyclePort')),
    deleteSession: () => Promise.resolve(fallbackThrow('SessionLifecyclePort')),
};
const fallbackAgentSpawner = {
    newSession: () => Promise.resolve(fallbackThrow('AgentSpawnerPort')),
};
let _channelDelivery;
let _messageQueue;
let _sessionLifecycle = fallbackSessionLifecycle;
let _agentSpawner = fallbackAgentSpawner;
let _cronStore = fallbackCronStore;
export function getCronStore() {
    return _cronStore;
}
export function getSessionLifecycle() {
    return _sessionLifecycle;
}
export function getAgentSpawner() {
    return _agentSpawner;
}
export function getChannelDelivery() {
    return _channelDelivery;
}
export function getMessageQueue() {
    return _messageQueue;
}
/**
 * Configure the cron-specific port slots.
 *
 * Daemon container calls this once during `initRuntime` after building
 * the concrete `CronStore`, `SessionService`, `AgentManager`,
 * `MultiChannelClient`, and `MessageQueue` instances. Tests can inject
 * stubs via partial options; ports left undefined keep their fallbacks
 * (which throw with a clear message on first use).
 */
export function configureCronHost(opts) {
    if (opts.cronStore)
        _cronStore = opts.cronStore;
    if (opts.sessionLifecycle)
        _sessionLifecycle = opts.sessionLifecycle;
    if (opts.agentSpawner)
        _agentSpawner = opts.agentSpawner;
    if (opts.channelDelivery)
        _channelDelivery = opts.channelDelivery;
    if (opts.messageQueue)
        _messageQueue = opts.messageQueue;
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
 * Reset the cron host registry to fallbacks. Intended for tests; daemon
 * production code should call {@link configureCronHost} once at startup.
 */
export function resetCronHostForTesting() {
    _cronStore = fallbackCronStore;
    _sessionLifecycle = fallbackSessionLifecycle;
    _agentSpawner = fallbackAgentSpawner;
    _channelDelivery = undefined;
    _messageQueue = undefined;
    _logger = noopLogger;
    _metricsReporter = noopMetricsReporter;
    _backgroundCtxFactory = () => ({ traceId: randomUUID().replaceAll('-', '') });
    _AppError = FallbackAppError;
    _datetimeHelpers = fallbackDatetimeHelpers;
}
//# sourceMappingURL=host-utils.js.map