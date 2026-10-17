const DEFAULT_DEVELOPMENT_SERVER_PORT = 3100;
function parseDevelopmentServerPort(configuredPort) {
    const value = configuredPort?.trim();
    if (!value || !/^\d+$/.test(value))
        return DEFAULT_DEVELOPMENT_SERVER_PORT;
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        return DEFAULT_DEVELOPMENT_SERVER_PORT;
    }
    return port;
}
export function resolveDevelopmentServerUrl(configuredPort) {
    return `http://localhost:${parseDevelopmentServerPort(configuredPort)}`;
}
