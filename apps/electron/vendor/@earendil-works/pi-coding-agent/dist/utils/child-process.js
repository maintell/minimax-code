import { spawn as nodeSpawn, spawnSync as nodeSpawnSync, } from "node:child_process";
import crossSpawn from "cross-spawn";
const EXIT_STDIO_GRACE_MS = 100;
export function spawnProcess(command, args, options) {
    return process.platform === "win32" ? crossSpawn(command, args, options) : nodeSpawn(command, args, options);
}
export function spawnProcessSync(command, args, options) {
    return process.platform === "win32"
        ? crossSpawn.sync(command, args, options)
        : nodeSpawnSync(command, args, options);
}
/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * On Windows, daemonized descendants can inherit the child's stdout/stderr pipe
 * handles. In that case the child emits `exit`, but `close` can hang forever even
 * though the original process is already gone. We wait briefly for stdio to end,
 * then forcibly stop tracking the inherited handles.
 */
export function waitForChildProcessExit(child) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let exited = false;
        let exitCode = null;
        let exitSignal = null;
        let postExitTimer;
        let stdoutEnded = child.stdout === null;
        let stderrEnded = child.stderr === null;
        const cleanup = () => {
            if (postExitTimer) {
                clearTimeout(postExitTimer);
                postExitTimer = undefined;
            }
            child.removeListener("error", onError);
            child.removeListener("exit", onExit);
            child.removeListener("close", onClose);
            child.stdout?.removeListener("end", onStdoutEnd);
            child.stderr?.removeListener("end", onStderrEnd);
        };
        const finalize = (code, signal) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            child.stdout?.destroy();
            child.stderr?.destroy();
            resolve({ exitCode: code, signal });
        };
        const maybeFinalizeAfterExit = () => {
            if (!exited || settled)
                return;
            if (stdoutEnded && stderrEnded) {
                finalize(exitCode, exitSignal);
            }
        };
        const onStdoutEnd = () => {
            stdoutEnded = true;
            maybeFinalizeAfterExit();
        };
        const onStderrEnd = () => {
            stderrEnded = true;
            maybeFinalizeAfterExit();
        };
        const onError = (err) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(err);
        };
        const onExit = (code, signal = null) => {
            exited = true;
            exitCode = code;
            exitSignal = signal;
            maybeFinalizeAfterExit();
            if (!settled) {
                postExitTimer = setTimeout(() => finalize(code, signal), EXIT_STDIO_GRACE_MS);
            }
        };
        const onClose = (code, signal = null) => {
            finalize(code, signal);
        };
        child.stdout?.once("end", onStdoutEnd);
        child.stderr?.once("end", onStderrEnd);
        child.once("error", onError);
        child.once("exit", onExit);
        child.once("close", onClose);
    });
}
export async function waitForChildProcess(child) {
    return (await waitForChildProcessExit(child)).exitCode;
}
//# sourceMappingURL=child-process.js.map