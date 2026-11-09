import { ModelAccessRequestError } from './validation.js';
import { ModelAccessResponseBody } from './response-body.js';
/** Owns actual fetch/body settlement, not just the caller-facing cancellation race. */
export class ModelAccessTransportLifetime {
    raw;
    assertLease;
    controller = new AbortController();
    pending = new Set();
    bodies = new Set();
    cleanupFailed = false;
    closing;
    signal;
    transport;
    constructor(raw, signal, assertLease) {
        this.raw = raw;
        this.assertLease = assertLease;
        this.signal = AbortSignal.any([signal, this.controller.signal]);
        this.transport = Object.freeze({
            ...raw,
            fetch: (input, init) => this.fetch(input, init),
            dispose: () => this.close(),
        });
    }
    assertCurrent() {
        if (this.signal.aborted)
            throw new ModelAccessRequestError('request_closed');
        if (this.cleanupFailed)
            throw new ModelAccessRequestError('request_cleanup_failed');
        this.assertLease();
    }
    fetch(input, init) {
        this.assertCurrent();
        const signal = AbortSignal.any([
            this.signal,
            ...(init?.signal ? [init.signal] : []),
            ...(input instanceof Request ? [input.signal] : []),
        ]);
        if (signal.aborted)
            throw new ModelAccessRequestError('request_closed');
        const work = this.performFetch(input, { ...init, signal });
        this.pending.add(work);
        return this.track(work);
    }
    async track(work) {
        try {
            return await work;
        }
        finally {
            this.pending.delete(work);
        }
    }
    async performFetch(input, init) {
        let response;
        try {
            response = await (this.raw.fetch ?? globalThis.fetch)(input, init);
        }
        catch {
            throw new ModelAccessRequestError(init.signal.aborted ? 'request_closed' : 'request_failed');
        }
        try {
            this.assertCurrent();
            if (init.signal.aborted)
                throw new ModelAccessRequestError('request_closed');
        }
        catch (error) {
            await this.cancelLateResponse(response);
            throw error;
        }
        if (!response.body)
            return response;
        // A 2xx web page is the 502 it stands for: told by its content type, its body never read.
        const page = webPageReply(response);
        if (page) {
            await this.cancelLateResponse(response);
            return page;
        }
        return this.wrapResponse(response, response.body, init.signal);
    }
    async cancelLateResponse(response) {
        try {
            await response.body?.cancel();
        }
        catch {
            this.cleanupFailed = true;
            throw new ModelAccessRequestError('request_cleanup_failed');
        }
    }
    wrapResponse(response, source, signal) {
        const body = new ModelAccessResponseBody(source, signal, () => this.assertCurrent(), (failed) => {
            this.bodies.delete(body);
            this.cleanupFailed ||= failed;
        });
        this.bodies.add(body);
        body.start();
        const wrapped = new Response(body.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
        Object.defineProperties(wrapped, {
            url: { value: response.url },
            redirected: { value: response.redirected },
            type: { value: response.type },
        });
        return wrapped;
    }
    close() {
        if (this.closing)
            return this.closing;
        this.controller.abort();
        this.closing = this.drain();
        return this.closing;
    }
    async drain() {
        // Start cancellation before waiting for an unrelated noncooperative fetch.
        // Late responses cannot register new bodies after the lifetime was aborted.
        const cancellations = [...this.bodies].map((body) => body.cancel());
        await Promise.allSettled([...this.pending, ...cancellations]);
        try {
            await this.raw.dispose?.();
        }
        catch {
            throw new ModelAccessRequestError('request_cleanup_failed');
        }
        if (this.cleanupFailed)
            throw new ModelAccessRequestError('request_cleanup_failed');
    }
}
/**
 * A 2xx served as text/html (a
 * sign-in page, Cloudflare's challenge, a relay's own error page) is the 502 it stands for, so
 * the next account is asked instead of the agent being handed a page (Codex: "stream closed
 * before response.completed", #1012). The page's words never leave. A body that is empty, or
 * HTML or not-JSON under a JSON type, is told by the reply's own reader (pi), which fails it.
 */
function webPageReply(response) {
    if (response.status < 200 || response.status >= 300 || response.status === 204)
        return undefined;
    const ct = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!ct.startsWith('text/html'))
        return undefined;
    return new Response(JSON.stringify({
        error: {
            message: `answered ${response.status} with a web page, not an API reply`,
            type: 'not_an_api_reply',
        },
    }), { status: 502, headers: { 'content-type': 'application/json' } });
}
//# sourceMappingURL=transport-lifetime.js.map