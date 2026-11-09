import { execFile as nodeExecFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
const execFileAsync = promisify(nodeExecFile);
const GIB = 1024 ** 3;
const SYSCTL_PATH = '/usr/sbin/sysctl';
const SYSCTL_PRESSURE_KEY = 'kern.memorystatus_vm_pressure_level';
const SYSCTL_TIMEOUT_MS = 1_000;
/** A lower level is accepted only after this many consecutive lower readings. */
const LOWER_CONFIRMATIONS = 2;
const PRESSURE_RANK = {
    normal: 0,
    moderate: 1,
    critical: 2,
};
/**
 * macOS: only the kernel's CRITICAL (4) reclaims; NORMAL (1) and WARN (2, a steady state on many
 * Macs) are normal in phase 1. Windows: fixed free-byte thresholds, never a percentage. An
 * unavailable signal never reclaims anything.
 */
export function classifyMiniAppMemoryPressure(sample) {
    switch (sample.source) {
        case 'sysctl':
            return sample.level === 4 ? 'critical' : 'normal';
        case 'available-bytes':
            if (sample.availableBytes < GIB)
                return 'critical';
            return sample.availableBytes < 2 * GIB ? 'moderate' : 'normal';
        case 'unavailable':
            return 'normal';
    }
}
export const INITIAL_MINIAPP_PRESSURE_STATE = {
    level: 'normal',
    lowerReadings: 0,
};
/** Raises at once; lowers only after two consecutive lower readings, to the latest reading. */
export function debounceMiniAppMemoryPressure(state, measured) {
    if (PRESSURE_RANK[measured] >= PRESSURE_RANK[state.level]) {
        return { level: measured, lowerReadings: 0 };
    }
    const lowerReadings = state.lowerReadings + 1;
    return lowerReadings >= LOWER_CONFIRMATIONS
        ? { level: measured, lowerReadings: 0 }
        : { level: state.level, lowerReadings };
}
/**
 * Never reads `process.availableMemory()` or `os.freemem()` on macOS: both report only fully free
 * pages there and would call every normal machine critical.
 */
export function createPlatformMiniAppPressureSampler(deps = {}) {
    const platform = deps.platform ?? process.platform;
    if (platform === 'win32') {
        const freemem = deps.freemem ?? os.freemem;
        return async () => ({ source: 'available-bytes', availableBytes: freemem() });
    }
    if (platform !== 'darwin')
        return async () => ({ source: 'unavailable' });
    const execFile = deps.execFile ?? execFileStdout;
    let warned = false;
    const unavailable = (detail) => {
        if (!warned) {
            warned = true;
            deps.logger?.warn({ event: 'miniapp.memory_pressure_unavailable', source: 'sysctl', detail }, 'Mini App memory pressure signal is unavailable; pressure reclaim is off');
        }
        return { source: 'unavailable' };
    };
    return async () => {
        let stdout;
        try {
            ({ stdout } = await execFile(SYSCTL_PATH, ['-n', SYSCTL_PRESSURE_KEY], {
                timeoutMs: SYSCTL_TIMEOUT_MS,
            }));
        }
        catch {
            return unavailable('exec_failed');
        }
        const level = parseSysctlLevel(stdout);
        return level === undefined ? unavailable('unparsable') : { source: 'sysctl', level };
    };
}
function parseSysctlLevel(stdout) {
    switch (stdout.trim()) {
        case '1':
            return 1;
        case '2':
            return 2;
        case '4':
            return 4;
        default:
            return undefined;
    }
}
async function execFileStdout(file, args, options) {
    const { stdout } = await execFileAsync(file, [...args], {
        timeout: options.timeoutMs,
        windowsHide: true,
        encoding: 'utf8',
    });
    return { stdout };
}
//# sourceMappingURL=pressure.js.map