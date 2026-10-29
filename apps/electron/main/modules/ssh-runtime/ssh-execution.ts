import { buildSshExecArgs, quoteRemoteShellArg } from "./ssh-command.js";
import { SshRuntimeError, classifySshFailure } from "./errors.js";
import { SshOutputProtocol } from "./ssh-output-protocol.js";
import { spawnOwnedSsh, stopOwnedSsh } from "./ssh-process.js";
import { createPersistentSshModeCache } from "./ssh-mode-cache.js";
import { prepareSshAuthentication } from "./ssh-authentication";
import { startSshDiagnostic } from "./diagnostics.js";
/** Main-owned execution boundary. Business writes never participate in mode selection. */
export class SshExecutionService {
    constructor(spawnProcess = spawnOwnedSsh, _legacyProbeTimeoutMs = 15000, modeCache) {
        this.spawnProcess = spawnProcess;
        this.modeCache = modeCache;
    }
    invalidateModes(endpoint) {
        if (endpoint)
            this.modeCache?.invalidate(endpoint);
        else
            this.modeCache?.clear();
    }
    async selectMode(endpoint, options = {}) {
        options = {
            ...options,
            diagnostics: options.diagnostics ??
                startSshDiagnostic('ssh-execution', {}, undefined, options.attemptId),
        };
        const deadline = performance.now() + (options.timeoutMs ?? 45000);
        if (options.fresh)
            this.invalidateModes(endpoint);
        const ticket = await this.modeCache?.inspect(endpoint, options.signal, deadline - performance.now());
        options.signal?.throwIfAborted();
        if (performance.now() >= deadline)
            throw new SshRuntimeError('ssh_command_timeout', 'SSH detection deadline exceeded.');
        // A shell request also works through gateways that accept exec but discard
        // its command. Never open a throwaway SSH login merely to choose a mode.
        const mode = ticket?.mode ?? 'shell-stdin';
        options.diagnostics?.record(ticket?.mode ? 'ssh-mode.cached' : 'ssh-mode.default', { mode });
        options.onProgress?.(mode);
        return mode;
    }
    async run(endpoint, script, options = {}) {
        options = {
            ...options,
            diagnostics: options.diagnostics ??
                startSshDiagnostic('ssh-execution', {}, undefined, options.attemptId),
        };
        const deadline = performance.now() + (options.timeoutMs ?? 45000);
        const mode = await this.selectMode(endpoint, options);
        const remaining = deadline - performance.now();
        if (remaining <= 0)
            throw new SshRuntimeError('ssh_command_timeout', 'SSH operation deadline exceeded.');
        try {
            return await this.runSelected(endpoint, mode, script, { ...options, timeoutMs: remaining });
        }
        catch (error) {
            if (!options.signal?.aborted &&
                isSshLaunchModeFailure(error) &&
                typeof error === 'object' &&
                error !== null &&
                'commandStarted' in error &&
                error.commandStarted === false) {
                this.invalidateModes(endpoint);
            }
            throw error;
        }
    }
    async runSelected(endpoint, mode, script, options = {}) {
        options.signal?.throwIfAborted();
        const protocol = new SshOutputProtocol(options.maxOutputBytes);
        const wrapped = protocol.commandScript(typeof script === 'string' ? script : script(protocol.readyScript()));
        const diagnostics = startSshDiagnostic('ssh-command', { mode }, options.diagnostics?.id, options.attemptId ?? options.diagnostics?.attemptId);
        let spawned;
        try {
            spawned = await this.spawn(endpoint, mode, wrapped, options);
        }
        catch (error) {
            const failure = Object.assign(error instanceof Error ? error : new Error(String(error)), {
                commandStarted: false,
                stdoutBytes: 0,
                stderrBytes: 0,
                exitCode: null,
                signal: null,
            });
            diagnostics.fail(failure, { phase: 'ssh-spawn' });
            throw failure;
        }
        const { child, input } = spawned;
        diagnostics.record('ssh-command.spawned', { pid: child.pid, commandStarted: false });
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const evidence = () => ({ commandStarted: protocol.hasStarted(), stdoutBytes, stderrBytes });
        child.once('close', (exitCode, signal) => {
            diagnostics.record('ssh-command.closed', { ...evidence(), exitCode, signal });
        });
        try {
            return await new Promise((resolve, reject) => {
                let settled = false;
                let readyBuffer = Buffer.alloc(0);
                let inputSent = false;
                let inputWritten = options.input === undefined;
                let inputError;
                let completed = null;
                const finish = (error, stdout = '') => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    options.signal?.removeEventListener('abort', onAbort);
                    child.stdout.off('data', onData);
                    child.stderr.off('data', onStderr);
                    if (error) {
                        const failure = Object.assign(error, {
                            ...evidence(),
                            stderr,
                            signal: child.signalCode,
                            exitCode: completed?.exitCode ?? child.exitCode,
                            ...(options.captureDiagnosticOutput ? { stdout: protocol.commandOutputTail() } : {}),
                        });
                        diagnostics.fail(failure, {
                            phase: 'ssh-command',
                            mode,
                            signal: child.signalCode,
                        });
                        reject(failure);
                    }
                    else {
                        diagnostics.record('ssh-command.completed', {
                            ...evidence(),
                            mode,
                            exitCode: completed?.exitCode,
                            signal: child.signalCode,
                        });
                        resolve({ stdout, stderr });
                    }
                };
                const onAbort = () => finish(new SshRuntimeError('ssh_cancelled', 'SSH operation cancelled.'));
                const onStderr = (chunk) => {
                    stderrBytes += chunk.byteLength;
                    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-64 * 1024);
                };
                const onData = (chunk) => {
                    stdoutBytes += chunk.byteLength;
                    const hadStarted = protocol.hasStarted();
                    try {
                        const result = protocol.acceptCommand(chunk);
                        if (!hadStarted && protocol.hasStarted())
                            diagnostics.record('ssh-command.started', evidence());
                        if (options.input !== undefined && !inputSent && protocol.hasStarted()) {
                            readyBuffer = Buffer.concat([readyBuffer, chunk]);
                            if (readyBuffer.includes(protocol.inputReady)) {
                                inputSent = true;
                                child.stdin.write(options.input, (error) => {
                                    inputError ?? (inputError = error ?? undefined);
                                    inputWritten = !inputError;
                                    complete();
                                });
                            }
                            readyBuffer = readyBuffer.subarray(-protocol.inputReady.length);
                        }
                        if (result) {
                            completed = result;
                            complete();
                        }
                    }
                    catch {
                        finish(new SshRuntimeError('ssh_channel_invalid', 'Invalid SSH command output.'));
                    }
                };
                const complete = () => {
                    if (!completed)
                        return;
                    if (inputError)
                        finish(inputError);
                    else if (completed.exitCode !== 0)
                        finish(new SshRuntimeError('ssh_command_failed', 'Remote command failed.'));
                    else if (inputWritten)
                        finish(undefined, completed.stdout);
                };
                const timer = setTimeout(() => finish(new SshRuntimeError('ssh_command_timeout', 'Remote command did not complete in time.')), options.timeoutMs ?? 15000);
                child.stdout.on('data', onData);
                child.stderr.on('data', onStderr);
                child.on('error', (error) => finish(error));
                child.stdin.on('error', (error) => {
                    inputError ?? (inputError = error);
                    if (!completed)
                        finish(error);
                    else
                        complete();
                });
                child.once('close', () => finish(classifySshFailure(stderr, false)));
                options.signal?.addEventListener('abort', onAbort, { once: true });
                if (options.signal?.aborted)
                    onAbort();
                else {
                    try {
                        if (input)
                            child.stdin.write(input);
                        else if (options.input === undefined)
                            child.stdin.end();
                    }
                    catch (error) {
                        finish(error instanceof Error ? error : new Error(String(error)));
                    }
                }
            });
        }
        finally {
            await stopOwnedSsh(child);
        }
    }
    /** Return an unstarted input script so consumers can bind readers before writing it. */
    async spawn(endpoint, mode, script, options = {}) {
        const args = buildSshExecArgs(endpoint, '-T', `exec sh -c ${quoteRemoteShellArg(script)}`, true, Boolean(options.confirmHostKey));
        if (mode === 'shell-stdin')
            args.pop();
        const authentication = await prepareSshAuthentication(endpoint, options);
        try {
            if (options.signal?.aborted)
                throw new SshRuntimeError('ssh_cancelled', 'SSH operation cancelled.');
            const child = this.spawnProcess(args, authentication?.env);
            child.once('close', () => authentication?.dispose());
            child.once('error', () => authentication?.dispose());
            return {
                child,
                ...(mode === 'shell-stdin' ? { input: `exec sh -c ${quoteRemoteShellArg(script)}\n` } : {}),
            };
        }
        catch (error) {
            authentication?.dispose();
            throw error;
        }
    }
}

export function isSshLaunchModeFailure(error) {
    if (!(error instanceof SshRuntimeError))
        return false;
    if (/administratively prohibited|request failed|not allowed|access denied|permission denied|host key verification failed|remote host identification has changed/iu.test(String(error.stderr ?? '')))
        return false;
    // Only an inconclusive read-only execution attempt permits a second mode.
    return (error.code === 'ssh_command_timeout' ||
        error.code === 'app_server_initialize_timeout' ||
        error.code === 'ssh_channel_invalid' ||
        error.code === 'remote_mcode_start_failed');
}
export let sshExecution = new SshExecutionService(spawnOwnedSsh, 15000, createPersistentSshModeCache());
