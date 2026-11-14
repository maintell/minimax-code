/**
 * Chromium's reachability state for the model-call and content-review offline
 * wait. It follows the OS network state, so a VPN tunnel or a docked adapter
 * that keeps an address while the device has no network still reads offline.
 * Electron exposes `net` in utility processes; any other shape yields no
 * signal and the runtime keeps its interface check alone.
 */
export function resolveElectronDeviceOnline(electronApi) {
    const net = electronApi && typeof electronApi === 'object'
        ? electronApi.net
        : undefined;
    const isOnline = net?.isOnline;
    if (typeof isOnline !== 'function')
        return undefined;
    return () => isOnline.call(net) !== false;
}
