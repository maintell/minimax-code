import { createNodeWorkerFactory } from '../../host/supervisor.js';
import { settleInBackground } from '../../../../infra/async/settle.js';
import { unpackedFileUrl } from '../../../../infra/util/asar-unpacked-path.js';
export const TEST_WORKER_LIMITS = Object.freeze({
    testTimeoutMs: 10_000,
    graceMs: 1_000,
    heartbeatIntervalMs: 500,
    heartbeatTimeoutMs: 5_000,
    resourceLimitMb: 256,
});
const MAX_LOG_LINES = 50;
/** The compiled `authoring/testing/worker.js`; packaged apps load it from `app.asar.unpacked`. */
export function createTestWorkerFactory(entry = unpackedFileUrl('./worker.js', import.meta.url)) {
    return createNodeWorkerFactory(entry);
}
export async function runTestFileInWorker(input) {
    const { file } = input.job;
    const tests = [];
    for (let from = 0;;) {
        const attempt = await new TestWorkerAttempt(input, from, tests).run();
        if (attempt.kind === 'done' || attempt.kind === 'aborted')
            return { file, diagnostics: [], tests };
        if (attempt.kind === 'load-failed') {
            return { file, diagnostics: [], error: attempt.error, tests };
        }
        const name = attempt.index === undefined ? undefined : attempt.names[attempt.index];
        if (attempt.index === undefined || name === undefined) {
            return { file, diagnostics: [], error: `loading ${file} ${attempt.reason}`, tests };
        }
        tests.push({
            name,
            status: 'failed',
            durationMs: attempt.elapsedMs,
            error: `test "${name}" ${attempt.reason}`,
            diagnostics: [],
            logs: attempt.logs,
        });
        from = attempt.index + 1;
        if (from >= attempt.names.length || input.signal?.aborted) {
            return { file, diagnostics: [], tests };
        }
    }
}
/** One Worker lifetime: from loading the file to `done`, a failure or termination. */
class TestWorkerAttempt {
    input;
    tests;
    worker;
    names = [];
    current;
    next;
    logs = [];
    lastPong = Date.now();
    pingSeq = 0;
    deadline;
    heartbeat;
    resolve = () => undefined;
    finished = false;
    constructor(input, from, tests) {
        this.input = input;
        this.tests = tests;
        this.next = from;
        this.worker = input.factory({
            attribution: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
            generation: 0,
            name: 'mcode-extension-test',
            resourceLimitMb: input.limits.resourceLimitMb,
        });
    }
    run() {
        const { worker, input } = this;
        const { limits, signal } = input;
        const settled = new Promise((resolve) => {
            this.resolve = resolve;
        });
        if (signal?.aborted) {
            this.finish({ kind: 'aborted' });
            return settled;
        }
        signal?.addEventListener('abort', this.onAbort, { once: true });
        worker.on('message', (message) => this.receive(message));
        worker.on('error', (error) => this.stop(`crashed its Worker: ${error.message}`));
        worker.on('exit', (code) => this.stop(`ended its Worker (exit code ${code})`));
        this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastPong > limits.heartbeatTimeoutMs) {
                this.stop(`timed out: it blocked its Worker for more than ${limits.heartbeatTimeoutMs} ms; the Worker was terminated`);
                return;
            }
            this.pingSeq += 1;
            this.post({ t: 'ping', n: this.pingSeq });
        }, limits.heartbeatIntervalMs);
        this.arm();
        this.post({
            t: 'run',
            job: { ...input.job, testTimeoutMs: limits.testTimeoutMs, from: this.next },
        });
        return settled;
    }
    onAbort = () => this.finish({ kind: 'aborted' });
    receive(message) {
        if (this.finished)
            return;
        switch (message.t) {
            case 'pong':
                this.lastPong = Date.now();
                return;
            case 'loaded':
                this.names = message.names;
                this.arm();
                return;
            case 'log':
            case 'case-start':
            case 'case-end':
                this.step(message);
                return;
            case 'load-failed':
                this.finish({ kind: 'load-failed', error: message.error });
                return;
            case 'done':
                this.finish({ kind: 'done' });
        }
    }
    step(message) {
        if (message.t === 'log') {
            if (this.current && this.logs.length < MAX_LOG_LINES)
                this.logs.push(message.line);
            return;
        }
        if (message.t === 'case-start') {
            this.current = { index: message.index, started: Date.now() };
            this.logs = [];
        }
        else {
            this.tests.push({ ...message.result, logs: this.logs });
            this.current = undefined;
            this.next = message.index + 1;
        }
        this.arm();
    }
    /** The deadline restarts at every step: loading, each case, and the gap before the next one. */
    arm() {
        const { testTimeoutMs, graceMs } = this.input.limits;
        clearTimeout(this.deadline);
        this.deadline = setTimeout(() => this.stop(`timed out after ${testTimeoutMs} ms and did not yield; the Worker was terminated`), testTimeoutMs + graceMs);
    }
    stop(reason) {
        const current = this.current;
        this.finish({
            kind: 'stopped',
            index: current?.index ?? (this.names.length > 0 ? this.next : undefined),
            names: this.names,
            reason,
            elapsedMs: current ? Date.now() - current.started : 0,
            logs: this.logs,
        });
    }
    finish(attempt) {
        if (this.finished)
            return;
        this.finished = true;
        clearTimeout(this.deadline);
        clearInterval(this.heartbeat);
        this.input.signal?.removeEventListener('abort', this.onAbort);
        this.resolve(attempt);
        settleInBackground(this.worker.terminate());
    }
    post(message) {
        this.worker.postMessage(message);
    }
}
//# sourceMappingURL=file-supervisor.js.map