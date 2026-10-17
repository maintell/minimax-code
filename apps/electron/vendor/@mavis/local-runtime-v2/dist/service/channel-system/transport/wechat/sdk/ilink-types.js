/**
 * Migration copy (MR1) of v1 `channels/adapters/wechat/sdk/ilink-types.ts`.
 */
/**
 * iLink Bot SDK — Protocol type definitions.
 *
 * Mirrors the Weixin iLink Bot API protobuf types (JSON transport).
 * All byte fields are base64-encoded strings in JSON.
 */
// ---------------------------------------------------------------------------
// Upload media types
// ---------------------------------------------------------------------------
export const UploadMediaType = {
    IMAGE: 1,
    VIDEO: 2,
    FILE: 3,
    VOICE: 4,
};
// ---------------------------------------------------------------------------
// Message enums
// ---------------------------------------------------------------------------
export const MessageType = {
    NONE: 0,
    USER: 1,
    BOT: 2,
};
export const MessageItemType = {
    NONE: 0,
    TEXT: 1,
    IMAGE: 2,
    VOICE: 3,
    FILE: 4,
    VIDEO: 5,
};
export const MessageState = {
    NEW: 0,
    GENERATING: 1,
    FINISH: 2,
};
export const TypingStatus = {
    TYPING: 1,
    CANCEL: 2,
};
//# sourceMappingURL=ilink-types.js.map