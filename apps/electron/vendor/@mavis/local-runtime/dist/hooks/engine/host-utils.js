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
const noopMetricsReporter = {
    incr: () => { },
    gauge: () => { },
    latency: () => { },
};
let _metricsReporter = noopMetricsReporter;
export function getMetricsReporter() {
    return _metricsReporter;
}
export function configureHookRegistryHost(opts) {
    if (opts.logger)
        _logger = opts.logger;
    if (opts.metricsReporter)
        _metricsReporter = opts.metricsReporter;
}
//# sourceMappingURL=host-utils.js.map