/** Sink used when a host composes the runtime without a plugin logger. */
const NOOP_PLUGIN_LOGGER = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};
export function resolvePluginServiceLogger(logger) {
    return logger ?? NOOP_PLUGIN_LOGGER;
}
//# sourceMappingURL=plugin-service-logger.js.map