/**
 * Per-platform response formatting hints for inbound context injection.
 *
 * These are injected into the model's system-level context so it knows
 * how to format responses for the target platform.
 */
const FEISHU_FORMAT = {
    text_markup: 'markdown_subset',
    rules: [
        'Use plain text or basic markdown (bold, italic, code blocks, lists).',
        'Feishu does not render full HTML or advanced markdown tables.',
        'Keep messages concise — long messages are hard to read in chat.',
        'Use code blocks with language tags for code snippets.',
        'Avoid inline images or complex formatting.',
    ],
};
const TELEGRAM_FORMAT = {
    text_markup: 'telegram_markdown_v2',
    rules: [
        'Use Telegram MarkdownV2 formatting.',
        'Escape special characters: _ * [ ] ( ) ~ ` > # + - = | { } . !',
        'Use ``` for code blocks (no language tag support in some clients).',
        'Keep messages under 4096 characters (Telegram limit).',
        'Avoid nested formatting (bold inside italic, etc.).',
    ],
};
const FORMAT_HINTS = {
    feishu: FEISHU_FORMAT,
    telegram: TELEGRAM_FORMAT,
};
/**
 * Get response format hints for a platform.
 * Returns undefined for platforms without specific formatting needs (e.g. 'api').
 */
export function getResponseFormatHint(platform) {
    return FORMAT_HINTS[platform];
}
//# sourceMappingURL=channel-format-hints.js.map