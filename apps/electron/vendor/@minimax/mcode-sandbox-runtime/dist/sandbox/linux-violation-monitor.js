import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { createInterface } from 'node:readline';
import { logForDebugging } from '../utils/debug.js';
import { decodeSandboxedCommand } from './sandbox-utils.js';
import { shouldIgnoreViolation } from './sandbox-violation-store.js';
/**
 * Linux equivalent of {@link startMacOSSandboxLogMonitor}. Creates a single
 * filesystem unix-socket listener; each `apply-seccomp` instance's outer stub
 * connects to it and writes one JSON line per observed write-intent syscall.
 * The supervise loop lives inside `apply-seccomp` itself (the parent that
 * already waitpid()s the workload), so there is no separate supervisor binary.
 *
 * Unlike Seatbelt's `log stream`, the kernel reports *attempts* here, not
 * denials, so this function intersects each path against the configured
 * allow/deny set before forwarding it as a violation.
 *
 * The reported path is read out of the (untrusted) sandboxed process's memory
 * with process_vm_readv and is therefore ATTACKER-CONTROLLED and racy. bwrap's
 * mount table is the only enforcement boundary; the violation events emitted
 * here are diagnostic hints and must never gate a policy decision.
 *
 * The transport is a *filesystem* unix socket because bwrap runs with
 * `--unshare-net` (abstract sockets are net-namespace-scoped) and bwrap closes
 * inherited fds. Filesystem sockets survive across net + user + mount
 * namespaces as long as the path is bind-mounted into the sandbox.
 */
export function startLinuxSandboxViolationMonitor(callback, opts) {
    const { allowWritePaths, denyWritePaths, ignoreViolations, resolveCommandText = (id) => id, } = opts;
    // sun_path is 108 bytes; mkdtemp under tmpdir() keeps us well under.
    const sockDir = mkdtempSync(join(tmpdir(), 'srt-obs-'));
    const sockPath = join(sockDir, `s${randomBytes(4).toString('hex')}.sock`);
    const underPrefix = (p, prefix) => p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
    /** A write attempt is a violation iff bwrap would refuse it: outside every
     *  allowWrite prefix, or back inside a denyWrite carve-out. apply-seccomp
     *  resolves relative paths against the tracee's cwd/dirfd before emitting,
     *  so events arrive absolute; the joined form may still contain ./ and
     *  ../ segments, which must be collapsed before prefix comparison. */
    const isDenied = (p) => {
        const norm = posix.normalize(p);
        if (denyWritePaths.some(d => underPrefix(norm, d)))
            return true;
        return !allowWritePaths.some(a => underPrefix(norm, a));
    };
    const handleEvent = (ev, encodedCommand) => {
        if (ev.observe_init_error) {
            logForDebugging(`[Sandbox Linux Monitor] observe filter not installed: ${ev.observe_init_error}`);
            return;
        }
        if (typeof ev.path !== 'string')
            return;
        // Only resolved absolute paths are classifiable. Anything else means
        // resolution failed upstream (or an old producer): this channel is
        // best-effort telemetry, so drop rather than guess.
        if (!ev.path.startsWith('/'))
            return;
        if (!isDenied(ev.path))
            return;
        let command;
        if (encodedCommand) {
            try {
                command = resolveCommandText(decodeSandboxedCommand(encodedCommand));
            }
            catch {
                /* ignore */
            }
        }
        if (shouldIgnoreViolation(ev.path, command, ignoreViolations))
            return;
        const violation = {
            line: `deny ${ev.syscall ?? 'syscall'} ${ev.path}`,
            command,
            encodedCommand,
            timestamp: new Date(),
        };
        callback(violation);
    };
    let resolveReady;
    const ready = new Promise(res => {
        resolveReady = res;
    });
    let observeSocketPath = sockPath;
    const server = createServer(conn => {
        let encodedCommand;
        const rl = createInterface({ input: conn });
        rl.on('line', raw => {
            if (!raw)
                return;
            let ev;
            try {
                ev = JSON.parse(raw);
            }
            catch {
                return;
            }
            // First line from each apply-seccomp instance is the encodedCommand
            // header; subsequent lines may also carry it but the header is
            // authoritative for this connection.
            if (ev.encodedCommand && encodedCommand === undefined) {
                encodedCommand = ev.encodedCommand;
            }
            handleEvent(ev, encodedCommand ?? ev.encodedCommand);
        });
        conn.on('error', () => rl.close());
        conn.on('close', () => rl.close());
    });
    server.on('error', err => {
        logForDebugging(`[Sandbox Linux Monitor] listen failed: ${err.message} - violation monitoring disabled`, { level: 'warn' });
        observeSocketPath = undefined;
        resolveReady();
    });
    server.listen(sockPath, () => resolveReady());
    const sockets = new Set();
    server.on('connection', s => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
    });
    const stop = () => {
        logForDebugging('[Sandbox Linux Monitor] stopping');
        for (const s of sockets)
            s.destroy();
        server.close();
        try {
            rmSync(sockDir, { recursive: true, force: true });
        }
        catch {
            /* best effort */
        }
    };
    return {
        get observeSocketPath() {
            return observeSocketPath;
        },
        ready,
        stop,
    };
}
//# sourceMappingURL=linux-violation-monitor.js.map