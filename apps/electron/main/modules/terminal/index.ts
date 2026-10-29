/**
 * TerminalManager — owns every PTY process spawned for the sidebar terminal
 * panel. Each `Terminal` is bound to a `sessionId` so we can do batch cleanup
 * when the session is destroyed (e.g. user closes a chat tab).
 *
 * Design highlights (see docs/design/sidebar-terminal-panel.md §4 / §6):
 *   - Single global instance accessed through `getTerminalManager()`.
 *   - Renderer-facing API: `create / list / attach / detach / write /
 *     resize / dispose / disposeBySession`.
 *   - Output is fanned out to every subscribed `WebContents` and also pushed
 *     into a per-terminal `ScrollbackBuffer` so a late attach gets history.
 *   - OSC 0/1/2 title sequences are extracted with a stateful parser; on
 *     change we emit `TERMINAL_TITLE`.
 *
 * The `node-pty` module is loaded lazily so unit tests can swap the spawner
 * via `__setPtySpawnerForTests` without paying the cost of loading the
 * native binding (which is also unavailable in vitest's sandbox).
 */
import { v4 } from "uuid";
import { homedir } from "node:os";
import { LOCAL_DESKTOP_RUNTIME_ID } from "@mavis/shared/desktop-runtime";
import { nativeTheme } from "electron";
import { logger } from "../../utils";
import { IPC_CHANNELS } from "../../config/constants";
import { detectShell } from "./shell-detect";
import { resolveTerminalCwd } from "./cwd";
import { OscTitleParser } from "./osc-parser";
import { ScrollbackBuffer } from "./ring-buffer";
let cachedSpawner = null;
function loadDefaultSpawner() {
    if (cachedSpawner)
        return cachedSpawner;
    // Lazy require so vitest never tries to resolve the native module unless
    // the test explicitly opts in. Casting through `unknown` avoids pulling
    // node-pty's full IPty surface into our interface contract.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodePty = require('node-pty');
    cachedSpawner = nodePty.spawn.bind(nodePty);
    return cachedSpawner;
}
/** Test hook — replaces the PTY spawner. Pass `null` to reset. */
export function __setPtySpawnerForTests(spawner) {
    cachedSpawner = spawner;
}
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TITLE_BROADCAST_DEBOUNCE_MS = 80;
export class TerminalManager {
    constructor(options = {}) {
        this.terminals = new Map();
        this.runtimeSuspensions = new Map();
        this.pendingCreations = new Set();
        this.dataObservers = new Set();
        this.options = {
            spawner: options.spawner ?? null,
            scrollbackCapacity: options.scrollbackCapacity ?? 10000,
            titleBroadcastDebounceMs: options.titleBroadcastDebounceMs ?? TITLE_BROADCAST_DEBOUNCE_MS,
        };
    }
    /**
     * Observe raw PTY output across all terminals (e.g. local dev server URL
     * detection). Observers must never throw into the data path; failures are
     * swallowed so they cannot break terminal streaming.
     */
    addDataObserver(observer) {
        this.dataObservers.add(observer);
        return () => {
            this.dataObservers.delete(observer);
        };
    }
    /**
     * Spawn a new PTY for the given session. The returned promise resolves
     * after validating the launch directory and spawning the PTY.
     */
    async create(params) {
        const { sessionId, cwd: requestedCwd, shellOverride } = params;
        if (!sessionId) {
            throw new Error('TerminalManager.create: sessionId is required');
        }
        if (!requestedCwd) {
            throw new Error('TerminalManager.create: cwd is required');
        }
        const runtimeId = params.runtimeId ?? LOCAL_DESKTOP_RUNTIME_ID;
        const pending = { sessionId, runtimeId, cancelled: false };
        this.pendingCreations.add(pending);
        let resolved;
        try {
            resolved = await resolveTerminalCwd(requestedCwd);
        }
        finally {
            this.pendingCreations.delete(pending);
        }
        if (pending.cancelled)
            throw new Error('Terminal creation cancelled during cleanup');
        const { cwd, cwdFallbackFrom } = resolved;
        const shellInfo = detectShell();
        const shellPath = shellOverride && shellOverride.length > 0 ? shellOverride : shellInfo.path;
        const shellType = shellOverride ? shellInfo.type : shellInfo.type;
        // Use login + interactive flags on Unix so user dotfiles run; on Windows
        // PowerShell we suppress the profile to keep startup deterministic.
        const args = computeShellArgs(shellInfo.isWindows, shellType);
        const result = await this.createProgram(params.sessionId, {
            command: shellPath,
            args,
            cwd,
            shellType,
            title: shellType,
            runtimeId,
        });
        return { ...result, ...(cwdFallbackFrom ? { cwdFallbackFrom } : {}) };
    }
    /** Spawn a Main-authorized program, used by SSH terminals after project resolution. */
    async createProgram(sessionId, spec) {
        if (!sessionId)
            throw new Error('TerminalManager.createProgram: sessionId is required');
        if (!spec.command)
            throw new Error('TerminalManager.createProgram: command is required');
        if (this.runtimeSuspensions.has(spec.runtimeId)) {
            throw new Error('Terminal runtime is unavailable');
        }
        const spawnCwd = spec.cwd || homedir();
        const shellInfo = detectShell();
        const spawner = this.options.spawner ?? loadDefaultSpawner();
        const env = buildTerminalEnv(spec.env ?? process.env);
        let ptyHandle;
        try {
            ptyHandle = spawner(spec.command, [...spec.args], {
                name: 'xterm-256color',
                cwd: spawnCwd,
                env,
                cols: DEFAULT_COLS,
                rows: DEFAULT_ROWS,
                encoding: 'utf8',
                useConpty: shellInfo.isWindows ? true : undefined,
            });
        }
        catch (err) {
            logger.error(`[TerminalManager] failed to spawn pty: command=${spec.command} cwd=${spawnCwd} err=${String(err)}`);
            throw err instanceof Error ? err : new Error(String(err));
        }
        const id = v4();
        const record = {
            id,
            sessionId,
            runtimeId: spec.runtimeId,
            cwd: spawnCwd,
            shell: spec.command,
            shellType: spec.shellType,
            title: spec.title,
            createdAt: Date.now(),
            pty: ptyHandle,
            subscribers: new Map(),
            subscriberDisposers: new Map(),
            scrollback: new ScrollbackBuffer(this.options.scrollbackCapacity),
            oscParser: new OscTitleParser(),
            exited: false,
            exitCode: null,
            disposers: spec.onDispose ? [spec.onDispose] : [],
            pendingTitle: null,
            titleBroadcastTimer: null,
        };
        const dataDisp = ptyHandle.onData((data) => {
            this.handleData(record, data);
        });
        const exitDisp = ptyHandle.onExit((evt) => {
            this.handleExit(record, evt.exitCode);
        });
        record.disposers.push(() => safeDispose(dataDisp));
        record.disposers.push(() => safeDispose(exitDisp));
        this.terminals.set(id, record);
        if (spec.initialInput) {
            try {
                ptyHandle.write(spec.initialInput);
            }
            catch (error) {
                this.terminals.delete(id);
                for (const dispose of record.disposers)
                    dispose();
                ptyHandle.kill();
                throw error;
            }
        }
        logger.info(`[TerminalManager] created terminal id=${id} session=${sessionId} runtime=${spec.runtimeId} command=${spec.command} cwd=${spawnCwd}`);
        return {
            terminalId: id,
            title: record.title,
            shellType: record.shellType,
        };
    }
    /** Return metadata for every terminal owned by `sessionId`. */
    list(params) {
        const { sessionId, runtimeId = LOCAL_DESKTOP_RUNTIME_ID } = params;
        const out = [];
        for (const t of this.terminals.values()) {
            if (t.sessionId === sessionId && t.runtimeId === runtimeId) {
                out.push({
                    id: t.id,
                    title: t.title,
                    shellType: t.shellType,
                    exited: t.exited,
                });
            }
        }
        return out;
    }
    /**
     * Attach a renderer to the given terminal. Adds the subscriber, replays
     * the scrollback snapshot, and resizes the PTY to the renderer's
     * viewport so output wraps correctly.
     */
    async attach(terminalId, subscriber, cols, rows, runtimeId = LOCAL_DESKTOP_RUNTIME_ID) {
        const record = this.requireTerminalForRuntime(terminalId, runtimeId);
        if (subscriber.isDestroyed()) {
            logger.warn(`[TerminalManager] attach skipped — subscriber destroyed (terminal=${terminalId})`);
            return { scrollback: record.scrollback.snapshot() };
        }
        if (record.runtimeId === LOCAL_DESKTOP_RUNTIME_ID &&
            !record.exited &&
            !record.directoryRecoveryCompleted) {
            const resolved = await resolveTerminalCwd(record.cwd);
            if (this.terminals.get(terminalId) !== record)
                throw new Error(`Terminal not found: ${terminalId}`);
            if (subscriber.isDestroyed())
                return { scrollback: record.scrollback.snapshot() };
            if (resolved.cwdFallbackFrom && !record.exited) {
                if (record.recovery) {
                    const pendingRecovery = record.recovery;
                    const previous = await pendingRecovery;
                    if (record.recovery === pendingRecovery &&
                        (!this.terminals.has(previous.terminalId) ||
                            this.terminals.get(previous.terminalId)?.exited)) {
                        record.recovery = undefined;
                    }
                }
                if (this.terminals.get(terminalId) !== record)
                    throw new Error(`Terminal not found: ${terminalId}`);
                if (subscriber.isDestroyed())
                    return { scrollback: record.scrollback.snapshot() };
                record.recovery ?? (record.recovery = this.create({
                    sessionId: record.sessionId,
                    runtimeId: record.runtimeId,
                    cwd: resolved.cwd,
                    shellOverride: record.shell,
                }));
                try {
                    const replacementTerminal = await record.recovery;
                    if (this.terminals.get(terminalId) !== record) {
                        this.dispose(replacementTerminal.terminalId, record.runtimeId);
                        throw new Error(`Terminal not found: ${terminalId}`);
                    }
                    // The renderer may discard this reply after switching away. Only an
                    // actual attach to the replacement confirms that recovery was applied.
                    this.requireTerminal(replacementTerminal.terminalId).recoverySourceId = terminalId;
                    return { scrollback: '', replacementTerminal, cwdFallbackFrom: record.cwd };
                }
                catch (error) {
                    record.recovery = undefined;
                    throw error;
                }
            }
        }
        if (this.terminals.get(terminalId) !== record)
            throw new Error(`Terminal not found: ${terminalId}`);
        if (!record.subscribers.has(subscriber.id)) {
            record.subscribers.set(subscriber.id, subscriber);
            const onDestroyed = () => this.removeSubscriber(record, subscriber.id);
            record.subscriberDisposers.set(subscriber.id, () => {
                subscriber.removeListener('destroyed', onDestroyed);
            });
            subscriber.once('destroyed', onDestroyed);
        }
        if (cols > 0 && rows > 0 && !record.exited) {
            try {
                record.pty.resize(cols, rows);
            }
            catch (err) {
                logger.warn(`[TerminalManager] resize on attach failed: ${String(err)}`);
            }
        }
        if (record.recoverySourceId) {
            const source = this.terminals.get(record.recoverySourceId);
            if (source)
                source.directoryRecoveryCompleted = true;
        }
        return { scrollback: record.scrollback.snapshot() };
    }
    /** Remove a renderer from the subscriber list (idempotent). */
    detach(terminalId, subscriber) {
        const record = this.terminals.get(terminalId);
        if (!record)
            return;
        this.removeSubscriber(record, subscriber.id);
    }
    /** Forward stdin from the renderer into the PTY. */
    write(terminalId, data, runtimeId = LOCAL_DESKTOP_RUNTIME_ID) {
        const record = this.getTerminalForRuntime(terminalId, runtimeId);
        if (!record || record.exited)
            return;
        try {
            record.pty.write(data);
        }
        catch (err) {
            logger.warn(`[TerminalManager] pty.write failed: ${String(err)}`);
        }
    }
    /** Resize the PTY (rows/cols must be >= 1). */
    resize(terminalId, cols, rows, runtimeId = LOCAL_DESKTOP_RUNTIME_ID) {
        const record = this.getTerminalForRuntime(terminalId, runtimeId);
        if (!record || record.exited)
            return;
        if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) {
            return;
        }
        try {
            record.pty.resize(cols, rows);
        }
        catch (err) {
            logger.warn(`[TerminalManager] pty.resize failed: ${String(err)}`);
        }
    }
    /**
     * Kill the PTY and remove the record. Subsequent calls are no-ops.
     * Explicit disposal removes listeners before killing the PTY. Runtime
     * revocation uses disposeByRuntime to notify subscribers of the forced exit.
     */
    dispose(terminalId, runtimeId = LOCAL_DESKTOP_RUNTIME_ID) {
        const record = this.getTerminalForRuntime(terminalId, runtimeId);
        if (!record)
            return;
        this.killAndCleanup(record);
    }
    /** Revoke interactive PTYs only; Runtime daemon tasks have a separate owner. */
    disposeByRuntime(runtimeId) {
        for (const pending of this.pendingCreations) {
            if (pending.runtimeId === runtimeId)
                pending.cancelled = true;
        }
        for (const record of Array.from(this.terminals.values())) {
            if (record.runtimeId === runtimeId)
                this.killAndCleanup(record, true);
        }
    }
    /** Prevent replacement PTYs while project removal awaits transport cleanup. */
    suspendRuntime(runtimeId) {
        this.runtimeSuspensions.set(runtimeId, (this.runtimeSuspensions.get(runtimeId) ?? 0) + 1);
        this.disposeByRuntime(runtimeId);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            const remaining = (this.runtimeSuspensions.get(runtimeId) ?? 1) - 1;
            if (remaining === 0)
                this.runtimeSuspensions.delete(runtimeId);
            else
                this.runtimeSuspensions.set(runtimeId, remaining);
        };
    }
    /** Dispose every PTY belonging to `sessionId`. */
    disposeBySession(sessionId) {
        for (const pending of this.pendingCreations) {
            if (pending.sessionId === sessionId)
                pending.cancelled = true;
        }
        const victims = [];
        for (const t of this.terminals.values()) {
            if (t.sessionId === sessionId)
                victims.push(t);
        }
        for (const t of victims) {
            this.killAndCleanup(t);
        }
    }
    /** Dispose every PTY (used during shutdown). */
    disposeAll() {
        for (const pending of this.pendingCreations)
            pending.cancelled = true;
        for (const t of Array.from(this.terminals.values())) {
            this.killAndCleanup(t);
        }
    }
    /**
     * Visible for tests — read the internal record. Do NOT use from production
     * code; the IPC handler is the supported entry point.
     */
    __getRecordForTests(terminalId) {
        return this.terminals.get(terminalId);
    }
    /** Visible for tests — number of records currently tracked. */
    __sizeForTests() {
        return this.terminals.size;
    }
    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------
    requireTerminal(id) {
        const record = this.terminals.get(id);
        if (!record) {
            throw new Error(`Terminal not found: ${id}`);
        }
        return record;
    }
    requireTerminalForRuntime(id, runtimeId) {
        const record = this.requireTerminal(id);
        if (record.runtimeId !== runtimeId) {
            throw new Error(`Terminal runtime mismatch: ${id}`);
        }
        return record;
    }
    getTerminalForRuntime(id, runtimeId) {
        const record = this.terminals.get(id);
        return record?.runtimeId === runtimeId ? record : undefined;
    }
    handleData(record, data) {
        if (this.terminals.get(record.id) !== record || record.exited)
            return;
        record.scrollback.append(data);
        // Title extraction — emit only on change so renderers don't churn.
        const newTitles = record.oscParser.feed(data);
        if (newTitles.length > 0) {
            const candidate = newTitles[newTitles.length - 1];
            if (candidate && candidate !== record.title) {
                record.title = candidate;
                this.scheduleTitleBroadcast(record, candidate);
            }
        }
        this.broadcast(record, IPC_CHANNELS.TERMINAL_OUTPUT, {
            terminalId: record.id,
            data,
            runtimeId: record.runtimeId,
        });
        for (const observer of this.dataObservers) {
            try {
                observer({
                    sessionId: record.sessionId,
                    terminalId: record.id,
                    runtimeId: record.runtimeId,
                    data,
                });
            }
            catch (err) {
                logger.warn(`[TerminalManager] data observer failed: ${String(err)}`);
            }
        }
    }
    handleExit(record, exitCode) {
        if (this.terminals.get(record.id) !== record || record.exited)
            return;
        record.exited = true;
        record.exitCode = exitCode;
        this.broadcast(record, IPC_CHANNELS.TERMINAL_EXIT, {
            terminalId: record.id,
            exitCode,
            runtimeId: record.runtimeId,
        });
        this.clearPendingTitleBroadcast(record);
        // Drop the listener disposers — keep the record so a renderer can still
        // see the final scrollback. `dispose()` cleans the slot.
        for (const fn of record.disposers)
            fn();
        record.disposers = [];
    }
    broadcast(record, channel, payload) {
        const dead = [];
        for (const sub of record.subscribers.values()) {
            if (sub.isDestroyed()) {
                dead.push(sub.id);
                continue;
            }
            try {
                sub.send(channel, payload);
            }
            catch (err) {
                logger.warn(`[TerminalManager] subscriber.send failed: ${String(err)}`);
                dead.push(sub.id);
            }
        }
        for (const id of dead)
            this.removeSubscriber(record, id);
    }
    removeSubscriber(record, id) {
        const dispose = record.subscriberDisposers.get(id);
        record.subscriberDisposers.delete(id);
        record.subscribers.delete(id);
        dispose?.();
    }
    scheduleTitleBroadcast(record, title) {
        record.pendingTitle = title;
        if (record.titleBroadcastTimer !== null) {
            clearTimeout(record.titleBroadcastTimer);
        }
        record.titleBroadcastTimer = setTimeout(() => {
            record.titleBroadcastTimer = null;
            const pendingTitle = record.pendingTitle;
            record.pendingTitle = null;
            if (!pendingTitle || record.exited)
                return;
            this.broadcast(record, IPC_CHANNELS.TERMINAL_TITLE, {
                terminalId: record.id,
                title: pendingTitle,
                runtimeId: record.runtimeId,
            });
        }, this.options.titleBroadcastDebounceMs);
    }
    clearPendingTitleBroadcast(record) {
        if (record.titleBroadcastTimer !== null) {
            clearTimeout(record.titleBroadcastTimer);
            record.titleBroadcastTimer = null;
        }
        record.pendingTitle = null;
    }
    killAndCleanup(record, notifyRevocation = false) {
        this.terminals.delete(record.id);
        this.clearPendingTitleBroadcast(record);
        // Dispose listeners BEFORE kill to prevent ThreadSafeFunction callbacks
        // firing on a half-torn-down environment (microsoft/node-pty#904).
        for (const fn of record.disposers)
            fn();
        record.disposers = [];
        if (!record.exited) {
            if (notifyRevocation) {
                this.broadcast(record, IPC_CHANNELS.TERMINAL_EXIT, {
                    terminalId: record.id,
                    runtimeId: record.runtimeId,
                    exitCode: null,
                });
            }
            try {
                record.pty.kill();
            }
            catch (err) {
                logger.warn(`[TerminalManager] pty.kill failed: ${String(err)}`);
            }
        }
        for (const id of record.subscribers.keys())
            this.removeSubscriber(record, id);
        record.scrollback.clear();
        record.oscParser.reset();
        logger.info(`[TerminalManager] disposed terminal id=${record.id}`);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function computeShellArgs(isWindows, shellType) {
    if (!isWindows) {
        // Unix: load the user's profile so PATH and aliases match the regular
        // terminal experience. `-i` keeps the shell interactive.
        return ['-l', '-i'];
    }
    if (shellType === 'pwsh') {
        // PowerShell: skip the profile to avoid the user-defined startup latency
        // hitting every PTY spawn; renderer can opt in later.
        return ['-NoLogo'];
    }
    // cmd.exe takes no startup args by default.
    return [];
}
function buildTerminalEnv(baseEnv) {
    const env = {
        ...baseEnv,
        // Prevent xterm.js / pty from defaulting to "dumb" (which disables
        // colors and many TUI features).
        TERM: baseEnv.TERM ?? 'xterm-256color',
        COLORTERM: baseEnv.COLORTERM ?? 'truecolor',
        // MCode TUI uses COLORFGBG as its initial appearance hint. Windows
        // PowerShell does not normally provide it, so without this the TUI
        // assumes a dark terminal and emits low-contrast light text on the
        // Desktop's light surface.
        COLORFGBG: baseEnv.COLORFGBG ?? (nativeTheme?.shouldUseDarkColors ? '15;0' : '0;15'),
    };
    if (hasEffectiveUtf8Locale(env)) {
        return env;
    }
    const fallbackLocale = resolveTerminalUtf8LocaleFallback();
    env.LANG = fallbackLocale;
    env.LC_ALL = fallbackLocale;
    env.LC_CTYPE = fallbackLocale;
    return env;
}
function hasEffectiveUtf8Locale(env) {
    return isUtf8Locale(resolveEffectiveLocale(env));
}
function resolveEffectiveLocale(env) {
    return env.LC_ALL || env.LC_CTYPE || env.LANG;
}
function isUtf8Locale(value) {
    if (!value)
        return false;
    const normalized = value.trim();
    if (!normalized)
        return false;
    // `C.UTF-8` is not a reliable UTF-8 locale on macOS, so terminals spawned
    // from the desktop app may still decode filenames as ASCII unless we
    // replace it with a real UTF-8 locale.
    if (process.platform === 'darwin' && normalized.toUpperCase() === 'C.UTF-8') {
        return false;
    }
    return /utf-?8/i.test(normalized);
}
function resolveTerminalUtf8LocaleFallback() {
    const desktopLocale = (process.env.MAVIS_ELECTRON_LOCALE ?? process.env.NEXT_PUBLIC_LOCALE ?? '')
        .trim()
        .toLowerCase();
    if (process.platform === 'darwin') {
        return desktopLocale.startsWith('zh') ? 'zh_CN.UTF-8' : 'en_US.UTF-8';
    }
    return 'C.UTF-8';
}
function safeDispose(disp) {
    try {
        disp?.dispose();
    }
    catch {
        // Ignore — node-pty v1 sometimes throws when the underlying process is
        // already gone.
    }
}
// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------
let singleton = null;
export function getTerminalManager() {
    if (!singleton) {
        singleton = new TerminalManager();
    }
    return singleton;
}
/** Test hook — replace the singleton instance. Pass `null` to clear. */
export function __setTerminalManagerForTests(instance) {
    singleton = instance;
}
