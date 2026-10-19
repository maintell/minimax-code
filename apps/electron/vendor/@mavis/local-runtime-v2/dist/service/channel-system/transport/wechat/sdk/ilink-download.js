/**
 * Migration copy (MR1) of v1 `channels/adapters/wechat/sdk/ilink-download.ts`.
 */
/**
 * iLink Bot SDK — inbound attachment download injection point.
 *
 * The SDK separates the "I know the protocol" pieces (`ilink-media.ts`,
 * `ilink-client.ts`) from the "who actually owns the bot token + how to
 * surface a Buffer" wiring. The runtime swaps in a real downloader at
 * boot via `setWeChatAttachmentDownloader(...)`; until then, the default
 * stub throws `iLink_api_pending` so callers cannot silently dispatch
 * empty attachments.
 *
 * Optional DLQ: `setWeChatDeadLetterStore(store)` lets the host inject a
 * persistence target for permanently-failed downloads. Without it, the
 * downloader simply returns the failure without persisting — see the
 * runtime-side `wechat-adapter.ts` attachment loop for the contract.
 */
export const WECHAT_ILINK_API_PENDING_MESSAGE = 'iLink_api_pending';
/**
 * Default stub — throws to make missing wiring loud. Real implementations
 * call `setWeChatAttachmentDownloader(realDownloader)` at host startup
 * (see `wechat-adapter.ts`).
 */
export const defaultWeChatAttachmentDownloader = {
    async download() {
        throw new Error(WECHAT_ILINK_API_PENDING_MESSAGE);
    },
};
// ---------------------------------------------------------------------------
// Module-scoped registry
// ---------------------------------------------------------------------------
let currentDownloader = defaultWeChatAttachmentDownloader;
let currentDeadLetterStore;
export function getWeChatAttachmentDownloader() {
    return currentDownloader;
}
export function setWeChatAttachmentDownloader(next) {
    currentDownloader = next ?? defaultWeChatAttachmentDownloader;
}
export function getWeChatDeadLetterStore() {
    return currentDeadLetterStore;
}
export function setWeChatDeadLetterStore(store) {
    currentDeadLetterStore = store;
}
/**
 * Driver: download a single attachment using the currently-registered
 * downloader. On failure, records to the DLQ if registered and re-throws
 * so the caller can decide whether to drop the attachment or surface the
 * error.
 */
export async function downloadAttachment(ref, ctx) {
    try {
        return await currentDownloader.download(ref, ctx);
    }
    catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (currentDeadLetterStore) {
            try {
                await currentDeadLetterStore.recordFailure({
                    ref,
                    error,
                    occurredAt: Date.now(),
                });
            }
            catch {
                // DLQ failure is non-fatal; surface the original error.
            }
        }
        throw error;
    }
}
//# sourceMappingURL=ilink-download.js.map