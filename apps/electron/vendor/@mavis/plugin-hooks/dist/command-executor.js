import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
const MAX_OUTPUT_BYTES = 64 * 1024;
const PROCESS_DRAIN_BUDGET_MS = 500;
/** Default executor: a detached local process group, killed on timeout, abort, or overflow. */
export async function spawnHookCommand(execution) {
    let child;
    try {
        await mkdir(execution.pluginDataDir, { recursive: true, mode: 0o700 });
        child = spawn(execution.command, execution.args, {
            cwd: execution.cwd,
            env: execution.env,
            shell: execution.shell,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }
    catch {
        return { reason: 'error', processKilled: false };
    }
    const overflowController = new AbortController();
    const readOutput = collectOutput(child, () => overflowController.abort());
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(execution.stdin);
    const result = await waitForChild(child, execution.timeoutMs, [execution.signal], overflowController.signal);
    const captured = readOutput();
    if (result.reason !== 'exit')
        return { reason: result.reason, processKilled: true };
    if (captured.overflow)
        return { reason: 'overflow', processKilled: false };
    return {
        reason: 'exit',
        code: result.code,
        stdout: captured.stdout,
        stderr: captured.stderr,
        processKilled: await terminateRemainingProcessGroup(child),
    };
}
function collectOutput(child, onOverflow) {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    child.stdout?.on('data', (chunk) => {
        if (stdout.length + chunk.length > MAX_OUTPUT_BYTES && !overflow) {
            overflow = true;
            onOverflow();
        }
        stdout = Buffer.concat([stdout, chunk]).subarray(0, MAX_OUTPUT_BYTES);
    });
    child.stderr?.on('data', (chunk) => {
        if (stderr.length + chunk.length > MAX_OUTPUT_BYTES && !overflow) {
            overflow = true;
            onOverflow();
        }
        stderr = Buffer.concat([stderr, chunk]).subarray(0, MAX_OUTPUT_BYTES);
    });
    return () => ({
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        overflow,
    });
}
function waitForChild(child, timeoutMs, signals, overflowSignal) {
    return new Promise((resolve) => {
        let settled = false;
        let stopping = false;
        let timer;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            for (const signal of signals)
                signal.removeEventListener('abort', abort);
            overflowSignal.removeEventListener('abort', overflow);
            resolve(value);
        };
        const stop = async (reason) => {
            if (stopping || settled)
                return;
            stopping = true;
            await terminateAndDrain(child);
            finish({ reason, killed: true });
        };
        const abort = () => void stop('aborted');
        const overflow = () => void stop('overflow');
        timer = setTimeout(() => void stop('timeout'), timeoutMs);
        child.once('error', () => finish({ reason: 'exit', code: 1, killed: false }));
        child.once('close', (code) => {
            if (!stopping)
                finish({ reason: 'exit', code: code ?? 1, killed: false });
        });
        for (const signal of signals)
            signal.addEventListener('abort', abort, { once: true });
        overflowSignal.addEventListener('abort', overflow, { once: true });
        if (signals.some((signal) => signal.aborted))
            abort();
        else if (overflowSignal.aborted)
            overflow();
    });
}
async function terminateAndDrain(child) {
    const closed = new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null)
            resolve();
        else
            child.once('close', () => resolve());
    });
    try {
        if (process.platform === 'win32' && child.pid) {
            const killed = await waitBounded(runTaskkill(child.pid), PROCESS_DRAIN_BUDGET_MS, false);
            if (!killed)
                child.kill('SIGKILL');
        }
        else if (child.pid) {
            process.kill(-child.pid, 'SIGKILL');
        }
        else {
            child.kill('SIGKILL');
        }
    }
    catch {
        try {
            child.kill('SIGKILL');
        }
        catch {
            // The process may already have exited.
        }
    }
    await waitBounded(closed, PROCESS_DRAIN_BUDGET_MS, undefined);
}
async function terminateRemainingProcessGroup(child) {
    if (!child.pid)
        return false;
    if (process.platform === 'win32') {
        return await waitBounded(runTaskkill(child.pid), PROCESS_DRAIN_BUDGET_MS, false);
    }
    try {
        process.kill(-child.pid, 'SIGKILL');
        return true;
    }
    catch {
        return false;
    }
}
async function runTaskkill(pid) {
    return new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
        });
        killer.once('error', () => resolve(false));
        killer.once('close', (code) => resolve(code === 0));
    });
}
async function waitBounded(operation, timeoutMs, timeoutValue) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
//# sourceMappingURL=command-executor.js.map