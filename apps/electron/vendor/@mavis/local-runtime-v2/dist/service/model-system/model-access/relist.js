import { isModelAccessProvider } from './projection.js';
/**
 * Re-reads every model-access provider's model list in the background: a runtime left running otherwise kept the list it read at sign-in, so a model
 * its vendor dropped stayed listed and a new one never came. One provider at a time, at most once
 * an hour each. A read that fails commits nothing, so the list read last stays (keepListed);
 * explicit refreshes and sign-ins write as before.
 */
const MODEL_ACCESS_RELIST_EVERY_MS = 60 * 60_000;
/** The first pass a few minutes after start, behind startup's own reads. */
const MODEL_ACCESS_RELIST_FIRST_MS = 5 * 60_000;
export class ModelAccessRelist {
    host;
    options;
    timer;
    running;
    controller = new AbortController();
    closed = false;
    constructor(host, options = {}) {
        this.host = host;
        this.options = options;
    }
    start() {
        if (this.closed || this.timer || this.running)
            return;
        this.schedule(this.options.firstMs ?? MODEL_ACCESS_RELIST_FIRST_MS);
    }
    schedule(delay) {
        if (this.closed)
            return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.running = this.runScheduled();
        }, delay);
        this.timer.unref?.();
    }
    async runScheduled() {
        try {
            await this.runOnce();
        }
        finally {
            this.running = undefined;
            this.schedule(this.options.everyMs ?? MODEL_ACCESS_RELIST_EVERY_MS);
        }
    }
    /** The model-access providers there are now, by key. */
    providers() {
        const tree = this.host.config().custom_provider ?? {};
        return Object.keys(tree).filter((key) => isModelAccessProvider(tree[key]) &&
            tree[key].enabled !== false &&
            this.host.usable?.(key) !== false);
    }
    /** One pass, one provider at a time; a failure keeps that provider's list and is only logged. */
    async runOnce() {
        for (const key of this.providers()) {
            if (this.closed)
                return;
            const timeout = AbortSignal.timeout(this.options.readTimeoutMs ?? 60_000);
            try {
                await this.host.refresh(key, AbortSignal.any([this.controller.signal, timeout]));
            }
            catch (error) {
                if (this.closed)
                    return;
                this.host.warn?.({
                    event: 'model_access_relist_failed',
                    providerKey: key,
                    code: error && typeof error === 'object' && 'code' in error
                        ? String(error.code)
                        : 'unknown',
                }, 'model access model list could not be read again; the last list stays');
            }
        }
    }
    async close() {
        this.closed = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        this.controller.abort();
        try {
            await this.running;
        }
        catch {
            /* A read failure was already logged by its pass. */
        }
    }
}
//# sourceMappingURL=relist.js.map