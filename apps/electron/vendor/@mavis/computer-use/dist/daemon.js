import { spawn } from 'node:child_process';
import { lstat, readFile, readdir, mkdtemp, open, rm, unlink, realpath, writeFile, } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, resolveProfileDataDir } from './component.js';
import { privateDirectory, processAlive as alive } from './desktop-lock.js';
import { daemonControl, validateDaemonMetadata } from './daemon-control.js';
import { ComputerUseError, record, structured } from './contracts.js';
/** Standalone App owns macOS permission identity; Windows inherits the interactive user. */
export async function startOwnedDaemon(component, dataDir, ownerId) {
    const root = path.join(await resolveProfileDataDir(dataDir), 'cu');
    await privateDirectory(root);
    const directory = await mkdtemp(path.join(root, `${digest(ownerId).slice(0, 8)}-`));
    await privateDirectory(directory);
    const nonce = randomUUID().replaceAll('-', '');
    const endpoint = process.platform === 'win32'
        ? `\\\\.\\pipe\\minimax-cu-${digest(dataDir).slice(0, 12)}-${nonce}`
        : path.join(directory, 'd.sock');
    if (process.platform !== 'win32' && Buffer.byteLength(endpoint) > 103) {
        throw new ComputerUseError('computer_endpoint_path_too_long', 'Profile path is too long for a private Unix socket; choose a shorter explicit profile path.');
    }
    const pidFile = path.join(directory, 'pid');
    // Lets a later host in this profile stop the daemon if this host exits without stopping it.
    await writeFile(path.join(directory, HOST_FILE), JSON.stringify({ pid: process.pid, endpoint }), {
        flag: 'wx',
        mode: 0o600,
    });
    const args = [
        'serve',
        '--socket',
        endpoint,
        '--pid-file',
        pidFile,
        '--permission-mode',
        'standard',
        '--no-permissions-gate',
    ];
    const child = process.platform === 'darwin'
        ? spawn('/usr/bin/open', ['-n', '-g', '-W', component.appBundle, '--args', ...args], {
            stdio: 'ignore',
            env: cleanEnvironment(),
        })
        : spawn(component.executable, args, {
            stdio: 'ignore',
            windowsHide: true,
            env: cleanEnvironment(),
        });
    let spawnError;
    let exited = false;
    child.once('error', (error) => {
        spawnError = error;
    });
    child.once('exit', () => {
        exited = true;
    });
    let owned;
    try {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            if (spawnError || exited)
                throw new ComputerUseError('computer_component_start_failed', 'The standalone component could not start in this desktop session.');
            try {
                const pid = Number((await readFile(pidFile, 'utf8')).trim());
                if (!Number.isSafeInteger(pid) ||
                    pid < 1 ||
                    (process.platform === 'win32' && pid !== child.pid)) {
                    throw new ComputerUseError('computer_component_identity_mismatch', 'Driver PID does not match the owned child.');
                }
                if (process.platform !== 'win32') {
                    const socket = await lstat(endpoint);
                    if (!socket.isSocket() ||
                        socket.uid !== process.getuid?.() ||
                        (socket.mode & 0o077) !== 0) {
                        throw new ComputerUseError('computer_endpoint_unsafe', 'Driver socket must be current-user owned and mode 0600.');
                    }
                }
                // The endpoint and PID file were created in a fresh private directory for this launch.
                owned = {
                    endpoint,
                    pid,
                    directory,
                    async check() {
                        validateDaemonMetadata(await daemonControl(endpoint, 'metadata'), pid);
                        const authorization = await daemonControl(endpoint, 'authorization_status');
                        if (authorization.permission_mode !== 'standard')
                            throw new ComputerUseError('computer_permission_mode_invalid', 'Only standard driver permission mode is admitted.');
                    },
                    async stop() {
                        await stopVerifiedDaemon(endpoint, pid, 35_000);
                        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
                    },
                };
                await owned.check();
                return owned;
            }
            catch (error) {
                if (error instanceof ComputerUseError)
                    throw error;
                if (owned)
                    throw error;
                await delay(50);
            }
        }
        throw new ComputerUseError('computer_component_start_timeout', 'Standalone component did not publish its private endpoint.');
    }
    catch (error) {
        if (owned)
            await owned.stop().catch(() => undefined);
        else if (process.platform === 'win32' && !exited)
            child.kill();
        // No PID-based process kill: macOS LaunchServices can outlive its `open` process.
        throw error;
    }
}
export async function requestComponentPermissions(component) {
    if (process.platform !== 'darwin')
        return { accessibility: true, screen_recording: true };
    // Matches the upstream __permissions-host-request's exact private file contract.
    const file = path.join(await realpath(tmpdir()), `cua-driver-permissions-${process.pid}-${randomUUID()}.json`);
    const handle = await open(file, 'wx', 0o600);
    await handle.close();
    try {
        await new Promise((resolve, reject) => {
            const child = spawn('/usr/bin/open', [
                '-n',
                '-W',
                '-g',
                component.appBundle,
                '--args',
                '__permissions-host-request',
                '--result-file',
                file,
                '--probe-direct-capture',
            ], { stdio: 'ignore', env: cleanEnvironment() });
            const timer = setTimeout(() => {
                child.kill(); // Only the `open` child, never another app/daemon PID.
                reject(new ComputerUseError('computer_permission_request_timeout', 'Permission setup is still pending.'));
            }, 180_000);
            child.once('error', (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.once('exit', (code) => {
                clearTimeout(timer);
                if (code === 0)
                    resolve();
                else
                    reject(new ComputerUseError('computer_permission_request_failed', 'The standalone App permission setup failed.'));
            });
        });
        const result = JSON.parse(await readFile(file, 'utf8'));
        const status = structured(result);
        if (record(result)?.isError || !status)
            throw new ComputerUseError('computer_permission_request_failed', 'Standalone permission helper did not return a valid status.');
        return status;
    }
    finally {
        await unlink(file);
    }
}
function cleanEnvironment() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CUA_')));
    // No inherited grants, policy overrides, embedding identity, or global endpoint selection.
    return { ...env, CUA_TELEMETRY_ENABLED: '0' };
}
/**
 * Stops a daemon recorded in a desktop lock whose host process exited. An endpoint with no
 * listener proves the recorded daemon no longer serves control requests.
 */
export async function stopOrphanDaemon(daemon) {
    try {
        await stopVerifiedDaemon(daemon.endpoint, daemon.pid, 10_000);
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT' || code === 'ECONNREFUSED')
            return;
        throw error;
    }
}
const HOST_FILE = 'host.json';
/** `<ownerHash>-<mkdtemp suffix>` directories created by startOwnedDaemon. */
const DAEMON_DIRECTORY = /^[0-9a-f]{8}-[A-Za-z0-9]{6}$/;
/** A directory touched this recently may belong to a launch that is still publishing its PID. */
const LAUNCH_GRACE_MS = 60_000;
/**
 * Daemons are launched through LaunchServices and outlive a host that exits without stopping
 * them. Stops profile daemons whose recorded host process has exited and removes directories
 * whose daemon already exited. Daemons with a live or unrecorded host are left running.
 */
export async function reclaimProfileDaemons(dataDir) {
    const root = path.join(await resolveProfileDataDir(dataDir), 'cu');
    const summary = { stopped: 0, removed: 0, kept: 0, failed: 0 };
    let names;
    try {
        names = await readdir(root);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return summary;
        throw error;
    }
    await Promise.all(names
        .filter((name) => DAEMON_DIRECTORY.test(name))
        .map(async (name) => {
        const outcome = await reclaimDaemonDirectory(path.join(root, name)).catch(() => 'failed');
        summary[outcome]++;
    }));
    return summary;
}
async function reclaimDaemonDirectory(directory) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
        return 'kept';
    const pid = await readPositiveInteger(path.join(directory, 'pid'));
    if (pid === undefined || !alive(pid)) {
        if (Date.now() - info.mtimeMs < LAUNCH_GRACE_MS)
            return 'kept';
        await rm(directory, { recursive: true, force: true });
        return 'removed';
    }
    const host = await readHost(directory);
    if (!host || alive(host.hostPid))
        return 'kept';
    // Identity is verified over the private endpoint; an unreachable endpoint never kills by PID.
    await stopOrphanDaemon({ pid, endpoint: host.endpoint });
    if (alive(pid))
        return 'kept';
    await rm(directory, { recursive: true, force: true });
    return 'stopped';
}
async function readPositiveInteger(file) {
    try {
        const value = Number((await readFile(file, 'utf8')).trim());
        return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    }
    catch {
        return undefined;
    }
}
async function readHost(directory) {
    try {
        const value = JSON.parse(await readFile(path.join(directory, HOST_FILE), 'utf8'));
        const { pid, endpoint } = value;
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1)
            return undefined;
        if (typeof endpoint !== 'string')
            return undefined;
        const expected = process.platform === 'win32'
            ? endpoint.startsWith('\\\\.\\pipe\\minimax-cu-')
            : endpoint === path.join(directory, 'd.sock');
        return expected ? { hostPid: pid, endpoint } : undefined;
    }
    catch {
        return undefined;
    }
}
async function stopVerifiedDaemon(endpoint, pid, timeoutMs) {
    if (!alive(pid))
        return;
    // Recheck identity immediately before sending a deny-only PID-bound command.
    validateDaemonMetadata(await daemonControl(endpoint, 'metadata'), pid);
    await daemonControl(endpoint, 'shutdown_if_pid', { expected_pid: pid });
    const stopDeadline = Date.now() + timeoutMs;
    while (alive(pid) && Date.now() < stopDeadline)
        await delay(50);
    if (alive(pid))
        throw new ComputerUseError('computer_stop_unconfirmed', 'Owned daemon shutdown is unconfirmed; desktop lock is retained.', 'unknown');
}
//# sourceMappingURL=daemon.js.map