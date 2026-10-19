const RUNTIME_TRANSPORT_FLAG = '--runtime-transport=';
/**
 * Single build gate for the protocol debug transport. The Main resolver and
 * the debug menu toggle must share this predicate so their allow criteria
 * cannot drift.
 */
export function isRuntimeProtocolTransportAllowed(options) {
    return (options.buildEnv === 'dev' ||
        options.buildEnv === 'development' ||
        options.buildEnv === 'test' ||
        options.buildEnv === 'staging' ||
        (options.buildEnv === 'prod' && options.isInternalBuild && !options.isInsideBuild));
}
export function resolveRuntimeTransportMode(options) {
    const cliValue = options.argv
        .find((arg) => arg.startsWith(RUNTIME_TRANSPORT_FLAG))
        ?.slice(RUNTIME_TRANSPORT_FLAG.length)
        .trim();
    const requested = cliValue ?? options.env.MAVIS_RUNTIME_TRANSPORT?.trim() ?? 'direct';
    if (requested !== 'direct' && requested !== 'protocol') {
        options.warn?.(`[RuntimeTransport] invalid mode "${requested}"; using direct`);
        return 'direct';
    }
    if (requested === 'protocol' && !isRuntimeProtocolTransportAllowed(options)) {
        options.warn?.('[RuntimeTransport] protocol mode is unavailable in this build; using direct');
        return 'direct';
    }
    return requested;
}
