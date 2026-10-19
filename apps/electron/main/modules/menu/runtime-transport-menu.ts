const RUNTIME_TRANSPORT_FLAG_PREFIX = '--runtime-transport=';
/**
 * Builds the relaunch argv for a transport-mode switch. The target flag is
 * always appended explicitly: CLI wins over MAVIS_RUNTIME_TRANSPORT, so a
 * launch-time env variable cannot pin the relaunched app to the old mode.
 */
export function computeRuntimeTransportRelaunchArgs(argv, targetMode) {
    const preserved = argv.filter((arg) => !arg.startsWith(RUNTIME_TRANSPORT_FLAG_PREFIX));
    return [...preserved, `${RUNTIME_TRANSPORT_FLAG_PREFIX}${targetMode}`];
}
export function getRuntimeTransportTargetMode(mode) {
    return mode === 'protocol' ? 'direct' : 'protocol';
}
