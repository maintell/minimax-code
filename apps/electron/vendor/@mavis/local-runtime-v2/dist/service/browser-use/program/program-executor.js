import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { BROWSER_PROGRAM_MAX_OPS, } from '@mavis/agent-tools/desktop';
import { browserProgramStep, browserProgramToolResult, } from './program-result.js';
import { settleInBackground } from '../../../infra/async/settle.js';
import { logger } from '../../../infra/logging/logger.js';
import { resolveBrowserProgramWorkerPath } from './guest/worker-path.js';
import { BROWSER_PROGRAM_STATE_MAX_BYTES } from './state-store.js';
/** Guest heap; a program that needs more should return a summary instead. */
const MAX_GUEST_HEAP_BYTES = 64 * 1024 * 1024;
const MAX_CONSOLE_BYTES = 16 * 1024;
/** After the deadline the Worker is ended even if the guest has not noticed. */
const TERMINATE_GRACE_MS = 1_000;
/** Ops refused past the op limit (or after a takeover) before the program is stopped outright. */
const MAX_REFUSED_OPS = 20;
/**
 * How long ops still running when the program ends may take to answer (an
 * aborted write reports its outcome); as Browser Core's INFLIGHT_SETTLE_MS.
 */
const OP_SETTLE_MS = 1_500;
/** Codes after which the page is not the one the program reasoned about. */
const STOPPING_CODES = {
    BROWSER_CONTROL_DISABLED: true,
    BROWSER_SESSION_POISONED: true,
};
/**
 * Runs Browser programs: one Worker with a fresh QuickJS runtime per program,
 * the host side of every page operation, the limits (time, guest heap, page
 * operations) and `state` between programs. A limit ends the Worker.
 */
export function createBrowserProgramExecutor(options) {
    const maxOps = options.maxOps ?? BROWSER_PROGRAM_MAX_OPS;
    const createWorker = options.createWorker ??
        (() => new Worker(resolveBrowserProgramWorkerPath(fileURLToPath(import.meta.url))));
    const limits = { createWorker, maxOps };
    return { run: (request) => new BrowserProgramRun(request, options.stateStore, limits).run() };
}
function guestReport(message) {
    if (!message)
        return { ok: false, opRoundTripMs: 0 };
    if (!message.ok) {
        return { ok: false, failure: message.error, opRoundTripMs: message.opRoundTripMs };
    }
    return {
        ok: true,
        ...(message.valueJson === undefined ? {} : { valueJson: message.valueJson }),
        opRoundTripMs: message.opRoundTripMs,
    };
}
/** The op the guest library sent; it builds every op as a plain object literal. */
function parseOp(opJson) {
    try {
        const parsed = JSON.parse(opJson);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed } : {};
    }
    catch {
        return {};
    }
}
function errorMessage(error) {
    return error &&
        typeof error === 'object' &&
        'message' in error &&
        typeof error.message === 'string'
        ? error.message
        : undefined;
}
/** The stop of a program whose page is no longer the one it reasoned about. */
function stoppingFailure(step, result) {
    if (!step.code || STOPPING_CODES[step.code] !== true)
        return undefined;
    const message = errorMessage(result.error) ?? step.code;
    return {
        failure: { kind: 'browser', name: 'BrowserError', code: step.code, message },
        note: `The Browser program was stopped: ${message} What it knew about the page may be out of date, and its state was not saved. Read the page again in a new program before any write.`,
    };
}
/** One program: its Worker, the host side of its ops, its limits and its report. */
class BrowserProgramRun {
    request;
    stateStore;
    limits;
    startedAt = performance.now();
    steps = [];
    media = [];
    opController = new AbortController();
    initialStateJson;
    worker;
    opMs = 0;
    opsStarted = 0;
    /** Ops that started and have no step yet: still running, or failed in the host. */
    unfinishedOps = new Set();
    /** The host side of each op the guest sent, awaited briefly when the program ends. */
    opTasks = new Set();
    refusedOps = 0;
    /** The user took over the Browser: later ops are refused without reaching it. */
    takeover;
    consoleText = '';
    consoleBytes = 0;
    consoleTruncated = false;
    stopNote;
    hostFailure;
    settled = false;
    resolveDone;
    done = new Promise((resolve) => {
        this.resolveDone = resolve;
    });
    constructor(request, stateStore, limits) {
        this.request = request;
        this.stateStore = stateStore;
        this.limits = limits;
        this.initialStateJson = stateStore.read(request.ctx.sessionId);
        this.worker = limits.createWorker();
    }
    async run() {
        const { request, worker } = this;
        const timer = setTimeout(() => this.stop({ kind: 'timeout', name: 'TimeoutError', message: 'time limit' }), request.timeoutMs + TERMINATE_GRACE_MS);
        const onAbort = () => this.stop({ kind: 'guest', name: 'AbortError', message: 'The program was cancelled.' }, 'The program was cancelled.');
        request.signal?.addEventListener('abort', onAbort, { once: true });
        // A signal that is already aborted never fires its listener.
        if (request.signal?.aborted)
            onAbort();
        worker.on('message', (message) => this.onMessage(message));
        worker.on('error', (error) => this.stop({
            kind: 'guest',
            name: 'Error',
            message: `The program runtime crashed: ${error.message}`,
        }));
        worker.on('exit', () => this.stop({
            kind: 'guest',
            name: 'Error',
            message: 'The program runtime exited unexpectedly.',
        }));
        worker.postMessage({
            type: 'start',
            code: request.code,
            ...(this.initialStateJson === undefined ? {} : { initialStateJson: this.initialStateJson }),
            maxHeapBytes: MAX_GUEST_HEAP_BYTES,
            deadlineAt: Date.now() + request.timeoutMs,
        });
        const message = await this.done;
        if (message?.disposeFailure !== undefined) {
            // The result stands (program-runtime.ts dispose); only the reason is kept.
            logger.warn({
                session_id: request.ctx.sessionId,
                turn_id: request.ctx.turnId,
                message: message.disposeFailure,
            }, 'browser.program.runtime_dispose_failed');
        }
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        this.opController.abort();
        try {
            await worker.terminate();
        }
        catch {
            // The Worker is already gone.
        }
        await this.settleRunningOps();
        return this.report(message);
    }
    /**
     * Ops still running when the program ended answer the abort (Browser Core
     * records an interrupted write's outcome); the report waits a moment for
     * them, and lists the ones that never answer as unfinished.
     */
    async settleRunningOps() {
        if (this.opTasks.size === 0)
            return;
        // The package's lib target has no Promise.withResolvers.
        let stopWaiting = () => undefined;
        const capped = new Promise((resolve) => {
            stopWaiting = resolve;
        });
        const timer = setTimeout(stopWaiting, OP_SETTLE_MS);
        await Promise.race([Promise.all([...this.opTasks]), capped]);
        clearTimeout(timer);
    }
    /** The first end wins: a `done`, a limit, a cancel, or the Worker going away. */
    finish(message) {
        if (this.settled)
            return;
        this.settled = true;
        this.resolveDone?.(message);
    }
    /** Ends the program from the host; the Worker's exit after its own `done` is not a failure. */
    stop(failure, note) {
        if (this.settled)
            return;
        this.hostFailure ??= failure;
        this.stopNote ??= note;
        this.opController.abort();
        this.finish(undefined);
    }
    onMessage(message) {
        if (message.type === 'op') {
            const task = this.handleOp(message.id, message.opJson);
            this.opTasks.add(task);
            settleInBackground((async () => {
                try {
                    await task;
                }
                finally {
                    this.opTasks.delete(task);
                }
            })());
            return;
        }
        if (message.type === 'console') {
            this.appendConsole(message.line);
            return;
        }
        this.finish(message);
    }
    appendConsole(text) {
        if (this.consoleTruncated)
            return;
        const line = `${text}\n`;
        const bytes = Buffer.byteLength(line, 'utf8');
        if (this.consoleBytes + bytes > MAX_CONSOLE_BYTES) {
            this.consoleTruncated = true;
            return;
        }
        this.consoleBytes += bytes;
        this.consoleText += line;
    }
    async handleOp(id, opJson) {
        try {
            await this.runOp(id, opJson);
        }
        catch (error) {
            this.stop({
                kind: 'guest',
                name: 'Error',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
    async runOp(id, opJson) {
        const op = parseOp(opJson);
        const name = typeof op.op === 'string' ? op.op : 'unknown';
        if (this.takeover) {
            this.refuseAfterTakeover(id, this.takeover);
            return;
        }
        if (this.opsStarted >= this.limits.maxOps) {
            this.refusePastOpLimit(id);
            return;
        }
        // An op the guest sent as the program ended starts nothing.
        if (this.settled)
            return;
        // Counted when it starts, so ops that overlap cannot pass the limit together.
        this.opsStarted += 1;
        const running = { op: name };
        this.unfinishedOps.add(running);
        const outcome = await this.request.runOp(op, this.opController.signal);
        this.unfinishedOps.delete(running);
        const step = browserProgramStep(name, outcome.result, op);
        this.steps.push(step);
        this.opMs += step.durationMs;
        if (outcome.media)
            this.media.push(...outcome.media);
        const stopping = stoppingFailure(step, outcome.result);
        if (stopping) {
            this.stop(stopping.failure, stopping.note);
            return;
        }
        if (step.code === 'BROWSER_USER_TAKEOVER')
            this.noteTakeover(outcome.result);
        if (this.settled)
            return;
        this.worker.postMessage({ type: 'op_result', id, resultJson: JSON.stringify(outcome.result) });
    }
    /** As past the op limit: the program can still save its state and end. */
    refuseAfterTakeover(id, takeover) {
        if (this.settled)
            return;
        takeover.refused += 1;
        const failure = {
            kind: 'browser',
            name: 'BrowserError',
            code: 'BROWSER_USER_TAKEOVER',
            message: takeover.message,
        };
        if (takeover.refused > MAX_REFUSED_OPS) {
            this.stop(this.hostFailure ?? failure, 'The program kept calling the page after the user took over the Browser and was stopped; its state was not saved.');
            return;
        }
        this.postRefusal(id, 'BROWSER_USER_TAKEOVER', takeover.message);
    }
    /**
     * Refused inside the program, which can still save its progress in state
     * and end; one that keeps calling the page is stopped.
     */
    refusePastOpLimit(id) {
        if (this.settled)
            return;
        const { maxOps } = this.limits;
        this.refusedOps += 1;
        const message = `BROWSER_OP_LIMIT: the program ran ${maxOps} page operations; no more run in this program.`;
        this.hostFailure ??= {
            kind: 'browser',
            name: 'BrowserError',
            code: 'BROWSER_OP_LIMIT',
            message,
        };
        if (this.refusedOps > MAX_REFUSED_OPS) {
            this.stop(this.hostFailure, `The program kept calling the page after its limit of ${maxOps} page operations and was stopped; its state was not saved.`);
            return;
        }
        this.postRefusal(id, 'BROWSER_OP_LIMIT', message);
    }
    postRefusal(id, code, message) {
        this.worker.postMessage({
            type: 'op_result',
            id,
            resultJson: JSON.stringify({ ok: false, error: { code, message } }),
        });
    }
    /**
     * The user has the Browser: the run fails, but the program still ends on its
     * own (its state is saved) and no later op reaches the page.
     */
    noteTakeover(result) {
        if (this.takeover)
            return;
        const message = errorMessage(result.error) ?? 'BROWSER_USER_TAKEOVER';
        this.takeover = { message, refused: 0 };
        this.hostFailure ??= {
            kind: 'browser',
            name: 'BrowserError',
            code: 'BROWSER_USER_TAKEOVER',
            message,
        };
    }
    report(message) {
        const guest = guestReport(message);
        const stateNote = message && !this.stopNote
            ? saveState(this.stateStore, this.request.ctx.sessionId, message, this.initialStateJson)
            : undefined;
        const failure = this.hostFailure ?? guest.failure;
        return browserProgramToolResult({
            ok: this.hostFailure === undefined && guest.ok,
            ...(guest.valueJson === undefined ? {} : { valueJson: guest.valueJson }),
            ...(failure ? { failure } : {}),
            ...(this.stopNote ? { stopNote: this.stopNote } : {}),
            // A copy: an op that answers after the report must not change it.
            steps: [...this.steps],
            unfinishedOps: [...this.unfinishedOps].map(({ op }) => op),
            refusedOps: this.refusedOps,
            opLimit: this.limits.maxOps,
            timeoutMs: this.request.timeoutMs,
            wallMs: performance.now() - this.startedAt,
            opMs: this.opMs,
            opRoundTripMs: guest.opRoundTripMs,
            console: this.consoleText.trimEnd(),
            consoleTruncated: this.consoleTruncated,
            ...(stateNote ? { stateNote } : {}),
            media: this.media,
        });
    }
}
/** Saves the program's `state`; a note when it could not. */
function saveState(store, sessionId, message, initialStateJson) {
    const capture = message.state;
    if (!capture)
        return undefined;
    if (capture.error !== undefined)
        return `state was not saved, the earlier state stays: ${capture.error}`;
    if (capture.json === (initialStateJson ?? '{}'))
        return undefined;
    const bytes = Buffer.byteLength(capture.json, 'utf8');
    if (bytes > BROWSER_PROGRAM_STATE_MAX_BYTES) {
        return `state was not saved, the earlier state stays: it is ${bytes} bytes, over the ${BROWSER_PROGRAM_STATE_MAX_BYTES}-byte limit. Keep only what the next program needs.`;
    }
    store.write(sessionId, capture.json);
    return undefined;
}
//# sourceMappingURL=program-executor.js.map