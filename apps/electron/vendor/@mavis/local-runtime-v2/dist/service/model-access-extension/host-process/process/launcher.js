import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { observeModelAccessWork } from '../../core/settlement.js';
import { ModelAccessHostPeerImpl } from '../peer.js';
import { MODEL_ACCESS_HOST_MAX_LINE_BYTES } from '../protocol.js';
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
export class ModelAccessHostStartupError extends Error {
    constructor(cause) {
        super(cause instanceof Error ? cause.message : 'host_start_failed', { cause });
        this.name = 'ModelAccessHostStartupError';
    }
}
const ALLOWED_ENV_NAMES = new Set([
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'LANGUAGE',
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy',
    'NO_PROXY',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_USE_ENV_PROXY',
]);
/**
 * Starts one extension host without exposing runtime identity or credentials through env.
 * `nodeArgs` is a test seam for the source-only tsx entry; packaged hosts pass no loader.
 */
export async function launchModelAccessHost(options) {
    validateLaunchOptions(options);
    const epoch = options.epoch ?? randomUUID();
    const child = spawnHost(options, epoch);
    const exit = observeExit(child);
    const peer = new ModelAccessHostPeerImpl({
        child,
        epoch,
        maxLineBytes: options.maxLineBytes ?? MODEL_ACCESS_HOST_MAX_LINE_BYTES,
        requestTimeoutMs: options.requestTimeoutMs,
        onFailure: () => queueMicrotask(() => {
            observeModelAccessWork(handle.stop());
        }),
    });
    child.stderr?.resume();
    const handle = {
        epoch,
        child,
        peer,
        exit,
        stop: createStop(child, peer, exit),
    };
    try {
        const timeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
        await peer.waitForHello(timeoutMs);
        // A group process starts empty; the pool loads each extension as a slot.
        if (options.groupProcess)
            return handle;
        await peer.request('init', { moduleUrl: options.moduleUrl, manifest: options.manifest }, { timeoutMs });
        await peer.waitForReady(timeoutMs);
        return handle;
    }
    catch (error) {
        await handle.stop();
        throw new ModelAccessHostStartupError(error);
    }
}
function spawnHost(options, epoch) {
    return spawn(options.execPath ?? process.execPath, [...(options.nodeArgs ?? []), options.entryPath, `--model-access-epoch=${epoch}`], {
        cwd: options.cwd ?? options.dataDir ?? process.cwd(),
        env: buildModelAccessHostEnv(options.environment ?? process.env, options.runAsElectronNode),
        detached: process.platform !== 'win32',
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}
function buildModelAccessHostEnv(source, runAsElectronNode = false) {
    const result = {};
    for (const [key, value] of Object.entries(source)) {
        if (value !== undefined && isAllowedEnvironmentName(key))
            result[key] = value;
    }
    if (runAsElectronNode)
        result.ELECTRON_RUN_AS_NODE = '1';
    return result;
}
function isAllowedEnvironmentName(key) {
    if (ALLOWED_ENV_NAMES.has(key))
        return true;
    const upper = key.toUpperCase();
    return (upper === 'PATH' ||
        upper === 'HTTPS_PROXY' ||
        upper === 'HTTP_PROXY' ||
        upper === 'ALL_PROXY' ||
        upper === 'NO_PROXY');
}
function validateLaunchOptions(options) {
    if (!path.isAbsolute(options.entryPath) || !options.moduleUrl.startsWith('file:'))
        throw new Error('host_launch_invalid');
    if (options.cwd !== undefined && !path.isAbsolute(options.cwd))
        throw new Error('host_launch_invalid');
    if (options.dataDir !== undefined && !path.isAbsolute(options.dataDir))
        throw new Error('host_launch_invalid');
    validateStartupTimeout(options.startupTimeoutMs);
}
function validateStartupTimeout(timeout) {
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000))
        throw new Error('host_startup_timeout_invalid');
}
function createStop(child, peer, exit) {
    let stopping;
    return () => {
        stopping ??= (async () => {
            try {
                return await stopModelAccessHost(child, peer, exit);
            }
            catch (error) {
                stopping = undefined;
                throw error;
            }
        })();
        return stopping;
    };
}
function isRunning(child) {
    return child.exitCode === null && child.signalCode === null;
}
function observeExit(child) {
    return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve({ code: child.exitCode, signal: child.signalCode });
            return;
        }
        child.once('exit', (code, signal) => resolve({ code, signal }));
        child.once('error', () => {
            if (child.pid === undefined)
                resolve({ code: null, signal: null });
        });
    });
}
async function stopModelAccessHost(child, peer, exit) {
    await cleanupWindowsHost(child);
    if (isRunning(child)) {
        try {
            await peer.request('shutdown', {}, { timeoutMs: 1_000 });
            const graceful = await boundedExit(exit, 2_000);
            if (graceful) {
                await cleanupProcessGroup(child);
                return graceful;
            }
        }
        catch {
            /* The child may have failed its protocol; termination below is still bounded. */
        }
    }
    if (isRunning(child)) {
        try {
            signalHost(child, 'SIGTERM');
        }
        catch {
            /* The exit promise remains authoritative. */
        }
    }
    const result = await boundedExit(exit, 2_000);
    if (!result) {
        killHost(child);
        const killed = await boundedExit(exit, 2_000);
        if (!killed)
            throw new Error('host_exit_unconfirmed');
        await cleanupProcessGroup(child);
        return killed;
    }
    await cleanupProcessGroup(child);
    return result;
}
/**
 * Ends a live Windows host's process tree. A root that already exited is stopped: its tree can
 * no longer be reached by its pid, and failing here left a host that exited on its own impossible
 * to disable or uninstall until the app restarted (Magpie's host.stop() treats an exited process
 * as stopped too).
 * @internal Exported for focused tests.
 */
export async function cleanupWindowsHost(child, platform = process.platform) {
    if (platform !== 'win32' || child.pid === undefined || !isRunning(child))
        return;
    await terminateWindowsTree(child.pid);
}
function killHost(child) {
    try {
        signalHost(child, 'SIGKILL');
    }
    catch {
        /* Exit confirmation remains authoritative. */
    }
}
function signalHost(child, signal) {
    if (process.platform !== 'win32' && child.pid)
        process.kill(-child.pid, signal);
    else
        child.kill(signal);
}
async function cleanupProcessGroup(child) {
    if (process.platform === 'win32' || !child.pid)
        return;
    try {
        process.kill(-child.pid, 'SIGKILL');
    }
    catch (error) {
        if (error.code === 'ESRCH')
            return;
        throw new Error('host_tree_exit_unconfirmed');
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        try {
            process.kill(-child.pid, 0);
        }
        catch (error) {
            if (error.code === 'ESRCH')
                return;
            throw new Error('host_tree_exit_unconfirmed');
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('host_tree_exit_unconfirmed');
}
async function terminateWindowsTree(pid) {
    const root = process.env.SystemRoot ?? process.env.WINDIR;
    const executable = root ? path.win32.join(root, 'System32', 'taskkill.exe') : 'taskkill.exe';
    const killer = spawn(executable, ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
    });
    const result = await boundedExit(observeExit(killer), 2_000);
    if (!result)
        killer.kill('SIGKILL');
    if (!result || result.code !== 0)
        throw new Error('host_tree_exit_unconfirmed');
}
async function boundedExit(exit, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            exit,
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(undefined), timeoutMs);
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
//# sourceMappingURL=launcher.js.map