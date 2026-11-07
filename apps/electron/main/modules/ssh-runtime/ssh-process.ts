import { spawn } from "node:child_process";
/** Each SSH process owns a separate process group; no shared ControlMaster is created here. */
export function spawnOwnedSsh(args, env) {
    return spawn('ssh', [...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(env ? { env } : {}),
        detached: process.platform !== 'win32',
    });
}
const stopping = new WeakMap();
/** Close only this client's process tree, never a remote daemon or another SSH connection. */
export function stopOwnedSsh(child) {
    const existing = stopping.get(child);
    if (existing)
        return existing;
    const completion = new Promise((resolve) => {
        let finished = false;
        let grace;
        let deadline;
        let poll;
        const groupExists = () => {
            if (!child.pid)
                return false;
            if (process.platform === 'win32')
                return child.exitCode === null && child.signalCode === null;
            try {
                process.kill(-child.pid, 0);
                return true;
            }
            catch (error) {
                return error.code !== 'ESRCH';
            }
        };
        const checkClosed = () => {
            if (!groupExists())
                finish();
        };
        const finish = () => {
            if (finished)
                return;
            finished = true;
            clearTimeout(grace);
            clearTimeout(deadline);
            clearInterval(poll);
            child.off('close', checkClosed);
            resolve();
        };
        const signal = (force) => {
            if (!child.pid)
                return;
            if (process.platform === 'win32') {
                // Same platform mechanism used by native-preview process ownership.
                const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], {
                    windowsHide: true,
                    stdio: 'ignore',
                });
                killer.on('error', () => {
                    child.kill(force ? 'SIGKILL' : 'SIGTERM');
                });
            }
            else {
                try {
                    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
                }
                catch (error) {
                    if (error.code !== 'ESRCH')
                        child.kill(force ? 'SIGKILL' : 'SIGTERM');
                }
            }
        };
        child.once('close', checkClosed);
        child.stdin.destroy();
        signal(false);
        grace = setTimeout(() => signal(true), 500);
        poll = setInterval(checkClosed, 25);
        // A reparented zombie may keep the group visible briefly after SIGKILL.
        // All termination signals target only the group allocated by spawnOwnedSsh.
        deadline = setTimeout(finish, 2000);
        checkClosed();
    });
    stopping.set(child, completion);
    return completion;
}
