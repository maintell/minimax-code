import { ModelAccessRequestError } from './validation.js';
/** Retains body ownership until reading or cancellation has actually settled. */
export class ModelAccessResponseBody {
    signal;
    assertLease;
    settled;
    body;
    reader;
    controller;
    ended = false;
    cancellation;
    observation;
    abort = () => {
        this.controller.error(new ModelAccessRequestError('request_closed'));
        this.observation ??= this.observeCancellation();
    };
    constructor(source, signal, assertLease, settled) {
        this.signal = signal;
        this.assertLease = assertLease;
        this.settled = settled;
        this.reader = source.getReader();
        // No prefetch: a fully buffered upstream response must not become a closed,
        // readable downstream stream before its caller has observed cancellation.
        this.body = new ReadableStream({
            start: (controller) => {
                this.controller = controller;
            },
            pull: () => this.pull(),
            cancel: () => this.cancel(),
        }, { highWaterMark: 0 });
    }
    start() {
        this.signal.addEventListener('abort', this.abort, { once: true });
        if (this.signal.aborted)
            this.abort();
    }
    assertCurrent() {
        if (this.signal.aborted)
            throw new ModelAccessRequestError('request_closed');
        this.assertLease();
    }
    async pull() {
        try {
            this.assertCurrent();
            const result = await this.read();
            this.assertCurrent();
            if (this.cancellation)
                return;
            if (result.done) {
                this.finish(false);
                this.controller.close();
            }
            else
                this.controller.enqueue(result.value);
        }
        catch {
            this.controller.error(new ModelAccessRequestError(this.signal.aborted ? 'request_closed' : 'request_failed'));
            await this.observeCancellation();
        }
    }
    async read() {
        try {
            return await this.reader.read();
        }
        catch (error) {
            // An errored ReadableStream has already ended; cancel() only rethrows its stored error.
            // If cancellation was in flight, its actual cleanup outcome still owns settlement.
            if (!this.cancellation)
                this.finish(false);
            throw error;
        }
    }
    cancel() {
        if (this.cancellation)
            return this.cancellation;
        if (this.ended)
            return Promise.resolve();
        this.cancellation = this.cancelReader();
        return this.cancellation;
    }
    async cancelReader() {
        let failed = false;
        try {
            await this.reader.cancel();
        }
        catch {
            failed = true;
            throw new ModelAccessRequestError('request_cleanup_failed');
        }
        finally {
            this.finish(failed);
        }
    }
    async observeCancellation() {
        try {
            await this.cancel();
        }
        catch {
            /* The owner retains cleanup failure; no raw body error is published. */
        }
    }
    finish(failed) {
        if (this.ended)
            return;
        this.ended = true;
        this.signal.removeEventListener('abort', this.abort);
        try {
            this.reader.releaseLock();
        }
        finally {
            this.settled(failed);
        }
    }
}
//# sourceMappingURL=response-body.js.map