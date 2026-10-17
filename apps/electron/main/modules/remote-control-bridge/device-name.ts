import { execFile } from "node:child_process";
import * as os from "node:os";
const MAC_LOCAL_HOST_NAME_TIMEOUT_MS = 1000;
const MAX_DEVICE_NAME_OUTPUT_BYTES = 4 * 1024;
function normalizedDeviceName(value) {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}
function readMacLocalHostName() {
    return new Promise((resolve) => {
        execFile('/usr/sbin/scutil', ['--get', 'LocalHostName'], {
            encoding: 'utf8',
            maxBuffer: MAX_DEVICE_NAME_OUTPUT_BYTES,
            timeout: MAC_LOCAL_HOST_NAME_TIMEOUT_MS,
            windowsHide: true,
        }, (error, stdout) => {
            if (error || typeof stdout !== 'string') {
                resolve(undefined);
                return;
            }
            resolve(normalizedDeviceName(stdout));
        });
    });
}
export async function resolveHostDeviceName(platform, hostname, localHostNameReader = readMacLocalHostName) {
    const fallbackName = normalizedDeviceName(hostname);
    if (platform !== 'darwin')
        return fallbackName;
    return (await localHostNameReader()) ?? fallbackName;
}
/**
 * Resolve the user-facing desktop identifier used by Remote Control pairing.
 *
 * On macOS, Node's `os.hostname()` can expose the transient kernel hostname
 * (for example `Mac`) while SystemConfiguration still owns the stable local
 * host name (for example an asset identifier such as `J0N41L9VNV`). Windows
 * has no equivalent split, so its normal hostname remains the source.
 */
export function getHostDeviceName() {
    return resolveHostDeviceName(process.platform, os.hostname());
}
