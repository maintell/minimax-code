export function createMcpRuntimeLogger(diagnostics, custom) {
    const sink = diagnostics?.child({ component: 'local-runtime.mcp' });
    if (!sink)
        return custom;
    return {
        info: (message, fields) => {
            custom?.info(message, fields);
            sink.info(message, fields);
        },
        warn: (message, fields) => {
            custom?.warn(message, fields);
            sink.warn(message, fields);
        },
        error: (message, fields) => {
            custom?.error(message, fields);
            sink.error(message, fields);
        },
    };
}
//# sourceMappingURL=logging.js.map