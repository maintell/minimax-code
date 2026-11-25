import { stat, access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { LOCAL_DESKTOP_RUNTIME_ID } from "@mavis/shared/desktop-runtime";
import { getTerminalManager } from "./index";
import { detectShell } from "./shell-detect";
import { InlineOutputFilter } from "./inline-output";
import { inlineShellStartup } from "./inline-shell";
const SHELL_STARTUP_TIMEOUT_MS = 15000;
const MAX_FINISHED_ACTIONS = 64;
/** Idle inline shells keep a PTY alive for follow-up input; older idle ones are disposed. */
const MAX_IDLE_SHELLS = 8;
/** Main owns idempotence, credential filtering and the PTY lifetime, not React mounts. */
export class InlineTerminalActions {
    constructor(manager = getTerminalManager, maxFinishedActions = MAX_FINISHED_ACTIONS, maxIdleShells = MAX_IDLE_SHELLS) {
        this.manager = manager;
        this.maxFinishedActions = maxFinishedActions;
        this.maxIdleShells = maxIdleShells;
        this.actions = new Map();
        this.pending = new Map();
        /** Pending starts whose session was deleted; they dispose their PTY instead of finishing. */
        this.cancelled = new Set();
    }
    key(params) {
        if (params?.runtimeId !== LOCAL_DESKTOP_RUNTIME_ID) {
            throw new Error('Inline terminal is only available in a local desktop session');
        }
        for (const value of [params.sessionId, params.actionId]) {
            if (typeof value !== 'string' || !value || value.length > 512) {
                throw new Error('Invalid inline terminal identity');
            }
        }
        return JSON.stringify([params.runtimeId, params.sessionId, params.actionId]);
    }
    start(params) {
        const key = this.key(params);
        const pending = this.pending.get(key);
        if (pending)
            return pending;
        const existing = this.actions.get(key);
        if (existing && !['exited', 'closed'].includes(existing.snapshot.status)) {
            return Promise.resolve({ ...existing.snapshot });
        }
        const reservation = this.manager().reserveCreation(params.sessionId, LOCAL_DESKTOP_RUNTIME_ID);
        const assertActive = () => {
            reservation.assertActive();
            if (this.cancelled.has(key))
                throw new Error('Inline terminal session was deleted');
        };
        const promise = this.create(params, key, assertActive).finally(() => {
            reservation.release();
            this.pending.delete(key);
            this.cancelled.delete(key);
        });
        this.pending.set(key, promise);
        return promise;
    }
    read(params) {
        const action = this.actions.get(this.key(params));
        if (!action)
            return null;
        return {
            ...action.snapshot,
            ...(params.includeOutput || action.snapshot.status === 'closed'
                ? {
                    output: action.output,
                }
                : {}),
        };
    }
    secretInput(params) {
        const action = this.actions.get(this.key(params));
        if (!action ||
            action.snapshot.terminalId !== params.terminalId ||
            action.snapshot.status !== 'running') {
            throw new Error('Sensitive input requires a running inline command');
        }
        validateSecret(params.secret);
        action.filter.addSecret(params.secret);
        action.snapshot.command = action.snapshot.command?.split(params.secret).join('[REDACTED]');
        this.manager().write(params.terminalId, `${params.secret}\r`, LOCAL_DESKTOP_RUNTIME_ID);
    }
    async create(params, key, assertActive) {
        if (typeof params.command !== 'string' ||
            !params.command.trim() ||
            params.command.length > 32768 ||
            params.command.includes('\0')) {
            throw new Error('Invalid inline terminal command');
        }
        if (typeof params.title !== 'string' || !params.title || params.title.length > 200) {
            throw new Error('Invalid inline terminal title');
        }
        if (typeof params.cwd !== 'string' ||
            !isAbsolute(params.cwd) ||
            !(await stat(params.cwd)).isDirectory()) {
            throw new Error('Inline terminal requires an existing absolute working directory');
        }
        if (params.secretEnv || params.secret) {
            if (!params.secretEnv ||
                !/^[A-Z_][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/.test(params.secretEnv)) {
                throw new Error('Invalid credential environment variable');
            }
            validateSecret(params.secret);
            if (params.command.includes(params.secret) || params.title.includes(params.secret)) {
                throw new Error('Enter credentials in the secret field, not the command');
            }
        }
        let shell = detectShell();
        const requestedShell = params.shell ?? shell.type;
        if (process.platform === 'win32') {
            if (requestedShell !== 'pwsh' || shell.type !== 'pwsh')
                throw new Error('INLINE_TERMINAL_SHELL_UNAVAILABLE');
        }
        else {
            if (requestedShell !== 'bash' && requestedShell !== 'zsh')
                throw new Error('INLINE_TERMINAL_SHELL_UNAVAILABLE');
            // detectShell's type is a display classification: fish/sh/dash may also be "bash".
            // Only a matching executable may receive this shell's rcfile and startup arguments.
            if (shell.type !== requestedShell || basename(shell.path) !== requestedShell) {
                let executable;
                for (const directory of ['/bin', '/usr/bin']) {
                    const candidate = join(directory, requestedShell);
                    try {
                        await access(candidate, constants.X_OK);
                        executable = candidate;
                        break;
                    }
                    catch {
                        /* Try the other standard location. */
                    }
                }
                if (!executable)
                    throw new Error('INLINE_TERMINAL_SHELL_UNAVAILABLE');
                shell = { path: executable, type: requestedShell, isWindows: false };
            }
        }
        const token = randomUUID();
        const snapshot = {
            command: params.command,
            terminalId: '',
            shellType: shell.type,
            cwd: params.cwd,
            status: 'running',
            exitCode: null,
        };
        let startupComplete = false;
        let timer;
        let acceptStartup;
        let rejectStartup;
        const startup = new Promise((resolve, reject) => {
            acceptStartup = resolve;
            rejectStartup = reject;
        });
        // Disposal can happen synchronously during spawn, before createProgram returns.
        void startup.catch(() => { });
        const filter = new InlineOutputFilter(token, (exitCode) => {
            snapshot.status = 'ready';
            snapshot.exitCode = exitCode;
        }, (version) => {
            startupComplete = true;
            snapshot.shellVersion = version;
            clearTimeout(timer);
            acceptStartup();
        });
        if (params.secret)
            filter.addSecret(params.secret);
        const action = { snapshot, filter, output: '' };
        if (shell.type === 'cmd')
            throw new Error('Inline terminal requires Bash, Zsh or PowerShell');
        const directory = await mkdtemp(join(tmpdir(), 'mcode-inline-terminal-'));
        const spec = inlineShellStartup(shell.type, params.command, token, directory);
        const cleanup = () => {
            clearTimeout(timer);
            if (!startupComplete)
                rejectStartup(new Error('INLINE_TERMINAL_STARTUP_FAILED'));
            filter.clear();
            void rm(directory, { recursive: true, force: true }).catch(() => { });
        };
        let terminalId;
        try {
            await writeFile(spec.scriptPath, spec.script, { mode: 0o600 });
            assertActive();
            const terminal = await this.manager().createProgram(params.sessionId, {
                command: shell.path,
                args: spec.args,
                cwd: params.cwd,
                shellType: shell.type,
                title: params.title,
                runtimeId: LOCAL_DESKTOP_RUNTIME_ID,
                env: {
                    ...process.env,
                    ...spec.env,
                    ...(shell.type === 'bash' ? { BASH_SILENCE_DEPRECATION_WARNING: '1' } : {}),
                    ...(params.secretEnv ? { [params.secretEnv]: params.secret } : {}),
                },
                preserveCwd: true,
                inline: true,
                outputFilter: (data, final) => {
                    const output = filter.feed(data, final);
                    action.output = (action.output + output).slice(-16000);
                    return output;
                },
                onExit: (exitCode) => {
                    if (!startupComplete)
                        rejectStartup(new Error('INLINE_TERMINAL_STARTUP_FAILED'));
                    snapshot.status = 'exited';
                    snapshot.exitCode = exitCode;
                    this.pruneFinished();
                },
                onDispose: () => {
                    if (snapshot.status !== 'exited')
                        snapshot.status = 'closed';
                    cleanup();
                    this.pruneFinished();
                },
            });
            terminalId = terminal.terminalId;
            snapshot.terminalId = terminal.terminalId;
            assertActive();
            if (!startupComplete) {
                timer = setTimeout(() => rejectStartup(new Error('INLINE_TERMINAL_STARTUP_TIMEOUT')), SHELL_STARTUP_TIMEOUT_MS);
            }
            await startup;
            assertActive();
            this.actions.delete(key);
            this.actions.set(key, action);
            this.pruneFinished();
            return { ...snapshot };
        }
        catch (error) {
            if (terminalId)
                this.manager().dispose(terminalId, LOCAL_DESKTOP_RUNTIME_ID);
            this.actions.delete(key);
            cleanup();
            throw error;
        }
    }
    /** Terminal keystrokes can begin another command in the same shell. */
    noteInput(terminalId, data) {
        if (!/[\r\n]/.test(data))
            return;
        for (const action of this.actions.values()) {
            if (action.snapshot.terminalId === terminalId && action.snapshot.status === 'ready') {
                action.snapshot.status = 'running';
                action.snapshot.exitCode = null;
            }
        }
    }
    /** A deleted session releases its inline PTYs; sidebar terminals keep their own owner. */
    disposeSession(params) {
        this.key({ ...params, actionId: 'session' });
        const inSession = (key) => JSON.parse(key)[1] === params.sessionId;
        for (const key of this.pending.keys()) {
            if (inSession(key))
                this.cancelled.add(key);
        }
        const terminalIds = [];
        for (const [key, action] of this.actions) {
            if (!inSession(key))
                continue;
            this.actions.delete(key);
            if (action.snapshot.terminalId)
                terminalIds.push(action.snapshot.terminalId);
        }
        for (const terminalId of terminalIds) {
            this.manager().dispose(terminalId, LOCAL_DESKTOP_RUNTIME_ID);
        }
    }
    clear() {
        this.actions.clear();
    }
    pruneFinished() {
        const finishedKeys = [];
        const idleTerminals = [];
        for (const [key, action] of this.actions) {
            if (action.snapshot.status === 'exited' || action.snapshot.status === 'closed') {
                finishedKeys.push(key);
            }
            else if (action.snapshot.status === 'ready') {
                idleTerminals.push(action.snapshot.terminalId);
            }
        }
        const excess = finishedKeys.length - this.maxFinishedActions;
        for (let index = 0; index < excess; index += 1) {
            this.actions.delete(finishedKeys[index]);
        }
        // Disposal re-enters pruneFinished through onDispose, so the list is captured first.
        for (const terminalId of idleTerminals.slice(0, idleTerminals.length - this.maxIdleShells)) {
            this.manager().dispose(terminalId, LOCAL_DESKTOP_RUNTIME_ID);
        }
    }
}

function validateSecret(value) {
    if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) {
        throw new Error('Credential must be a single line');
    }
}
export let inlineTerminalActions = new InlineTerminalActions();
