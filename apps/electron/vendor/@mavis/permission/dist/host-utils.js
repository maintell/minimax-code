/**
 * Permission host-utils: registry for permission-specific runtime ports.
 *
 * Mirrors `agent-core/src/cron/host-utils.ts`. Hosts (local-runtime today)
 * call {@link configurePermissionHost} once at startup with concrete
 * implementations of the ports declared in `host-ports.ts`. The permission
 * code (`engine.ts`, the facade, classifier) imports these helpers and
 * resolves the live port at call time so a swap-after-import cycle picks up
 * the host's wiring.
 *
 * Cross-cutting helpers (`logger`, `backgroundCtx`, `AppError`, `nowMs`,
 * region/build-env providers) are permission-owned runtime collaborators.
 * Hosts override them through {@link configurePermissionHost}; otherwise
 * safe test fallbacks are used.
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
export function formatLocalMonthDayTime(ts) {
    return _datetimeHelpers.formatLocalMonthDayTime(ts);
}
export function formatLocalDateTime(ts) {
    return _datetimeHelpers.formatLocalDateTime(ts);
}
export function getPermissionConfig() {
    return _runtimeConfigProvider.getConfig();
}
const fallbackRuntimeConfigProvider = {
    getConfig: () => {
        throw new Error('[@mavis/permission] No runtimeConfigProvider registered. Hosts must call ' +
            'configurePermissionHost({ runtimeConfigProvider }) before permission checks run.');
    },
    getRuntimeRegion: () => 'cn',
    getRuntimeBuildEnv: () => 'prod',
    isManagedRuntime: () => false,
};
let _runtimeConfigProvider = fallbackRuntimeConfigProvider;
export function getRuntimeConfig() {
    return _runtimeConfigProvider.getConfig();
}
export function getRuntimeRegion() {
    return _runtimeConfigProvider.getRuntimeRegion();
}
export function getRuntimeBuildEnv() {
    return _runtimeConfigProvider.getRuntimeBuildEnv();
}
export function isManagedRuntime() {
    return _runtimeConfigProvider.isManagedRuntime();
}
// ─── Permission-specific port slots ──────────────────────────────────────
let _managedAuthTokenGetter = () => undefined;
let _promptProvider;
/**
 * Managed-login token used as the cloud classifier Bearer credential.
 * Returns undefined when unavailable → cloud classifier fail-closes to confirm.
 */
export function getPermissionManagedAuthToken() {
    return _managedAuthTokenGetter();
}
/** Host-resolved permission prompt content. */
export function getPermissionPrompt(name) {
    return _promptProvider?.resolvePrompt(name);
}
/**
 * Configure the permission-specific port slots. Hosts call this once at
 * startup. Ports left undefined keep safe fallbacks (no token / no local LLM →
 * cloud-or-confirm).
 */
export function configurePermissionHost(opts) {
    if (opts.runtimeConfigProvider)
        _runtimeConfigProvider = opts.runtimeConfigProvider;
    if (opts.managedAuthTokenGetter)
        _managedAuthTokenGetter = opts.managedAuthTokenGetter;
    if (opts.promptProvider)
        _promptProvider = opts.promptProvider;
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
/** Reset permission host registry to fallbacks. Intended for tests. */
export function resetPermissionHostForTesting() {
    _runtimeConfigProvider = fallbackRuntimeConfigProvider;
    _managedAuthTokenGetter = () => undefined;
    _promptProvider = undefined;
    _logger = noopLogger;
    _metricsReporter = noopMetricsReporter;
    _backgroundCtxFactory = () => ({ traceId: randomUUID().replaceAll('-', '') });
    _AppError = FallbackAppError;
    _datetimeHelpers = fallbackDatetimeHelpers;
}
//# sourceMappingURL=host-utils.js.map