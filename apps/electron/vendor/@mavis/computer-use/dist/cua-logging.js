export function createCuaStructuredLogger(sink = defaultSink, base = {}) {
    const emit = (level, event, context = {}) => sink(level, {
        schema: 'computer-use.v1',
        ts: Date.now(),
        event,
        ...base,
        ...context,
    });
    return {
        emit,
        debug: (event, context) => emit('debug', event, context),
        info: (event, context) => emit('info', event, context),
        warn: (event, context) => emit('warn', event, context),
        error: (event, context) => emit('error', event, context),
    };
}
/** Set by the Electron host from its build mode; unset is production-safe. */
export function cuaDiagnosticsEnabled() {
    return process.env.MAVIS_CUA_DIAGNOSTICS === '1';
}
export function shouldEmitCuaLog(level, event, diagnostics) {
    if (diagnostics || level === 'warn' || level === 'error')
        return true;
    return [
        'utility_spawn',
        'utility_ready',
        'utility_exit',
        'channel_open',
        'channel_close',
    ].includes(String(event));
}
function defaultSink(level, record) {
    if (!shouldEmitCuaLog(level, record.event, cuaDiagnosticsEnabled()))
        return;
    const line = `[ComputerUse] ${JSON.stringify(record)}`;
    if (level === 'error')
        console.error(line);
    else if (level === 'warn')
        console.warn(line);
    else
        console.log(line);
}
//# sourceMappingURL=cua-logging.js.map