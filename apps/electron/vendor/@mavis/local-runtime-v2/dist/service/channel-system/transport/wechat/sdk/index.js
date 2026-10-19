/**
 * Migration copy (MR1) of v1 `channels/adapters/wechat/sdk/index.ts`.
 */
/**
 * WeChat iLink Bot SDK — Standalone WeChat iLink Bot SDK.
 *
 * Independent of OpenClaw framework. Uses iLink Bot API directly.
 */
export { UploadMediaType, MessageType, MessageItemType, MessageState, TypingStatus, } from './ilink-types.js';
export { setIlinkFetch } from './ilink-fetch.js';
// Client
export { ILinkClient } from './ilink-client.js';
// Auth
export { ILinkAuth } from './ilink-auth.js';
// Media
export { encryptAesEcb, decryptAesEcb, aesEcbPaddedSize, parseAesKey, buildCdnDownloadUrl, buildCdnUploadUrl, downloadAndDecrypt, downloadPlain, uploadMedia, uploadImage, uploadVideo, uploadFile, } from './ilink-media.js';
// Monitor
export { ILinkMonitor } from './ilink-monitor.js';
// Send helpers
export { sendTextMessage, sendImageMessage, sendVideoMessage, sendFileMessage, sendMediaFile, } from './ilink-send.js';
// Inbound attachment download (STUB — see `progress/wechat-ilink-api-pending.md`)
// 注入契约见 `ilink-download.ts` 顶部的 TODO(iLink) 注释。
// 业务方确认 3 项待定(contextToken 传递 / 下载 endpoint / MIME 探测)
// 后,electron 启动 hook 调用 `setWeChatAttachmentDownloader(realImpl)`
// 即可切换为真实实现。
//
// P2-B: 失败重试 (withRetry) + 死信队列 (DLQ) 持久化。
// `setWeChatDeadLetterStore` 让 electron 启动 hook 注入一个
// `LocalDeadLetterStore` 实例; 不注入则静默 no-op (无 DLQ)。
export { defaultWeChatAttachmentDownloader, downloadAttachment, getWeChatAttachmentDownloader, getWeChatDeadLetterStore, setWeChatAttachmentDownloader, setWeChatDeadLetterStore, WECHAT_ILINK_API_PENDING_MESSAGE, } from './ilink-download.js';
//# sourceMappingURL=index.js.map