/**
 * Upper bound of one snapshot; the broker rejects a larger one. Main truncates beyond it, live
 * tabs first and sleeping records last, so a dropped tab only skews attention ranking: a visible
 * page is still protected by Main refusing to sleep it.
 */
export let MINIAPP_ATTENTION_MAX_TABS = 256;
/** Coalescing window for bursts of tab changes (switching chats hides one tab, shows another). */
export let MINIAPP_ATTENTION_COALESCE_MS = 250;
/**
 * Coalesces change notifications into one snapshot read at most `MINIAPP_ATTENTION_COALESCE_MS`
 * after the first change (later changes do not reset the timer). `flush` sends at once (used when
 * the Utility becomes ready).
 */
export class MiniAppAttentionReporter {
    constructor(read, send) {
        this.read = read;
        this.send = send;
    }
    changed() {
        if (this.timer)
            return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.send(this.read());
        }, MINIAPP_ATTENTION_COALESCE_MS);
        this.timer.unref?.();
    }
    flush() {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.send(this.read());
    }
}

