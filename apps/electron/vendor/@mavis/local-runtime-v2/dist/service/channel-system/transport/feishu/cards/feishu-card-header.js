/**
 * Migration copy (MR1) of v1 `channels/adapters/feishu/feishu-card-header.ts`.
 */
/**
 * Shared Feishu / Lark Card 2.0 header builder + default bot name.
 *
 * Kept in its own file so both `feishu-card.ts` (questionnaire / submitted /
 * expired cards) and `feishu-reply-card.ts` (reply / thinking cards) can
 * import the same primitive without crossing the 500-line layout budget.
 *
 * Pure data — no SDK / `axios` / `node:crypto` import here.
 */
/** Default bot display name shown in every card header. */
export const DEFAULT_BOT_NAME = 'MiniMax Code';
/**
 * Build a Card 2.0 `header` object with the standard `(title, template,
 * text_tag_list, [icon], [subtitle])` shape used across reply / thinking /
 * questionnaire / submitted / expired cards.
 */
export function makeHeader(opts) {
    const header = {
        title: { tag: 'plain_text', content: opts.title },
        template: opts.template,
        text_tag_list: [
            {
                tag: 'text_tag',
                text: { tag: 'plain_text', content: opts.tagText },
                color: opts.tagColor,
            },
        ],
    };
    if (opts.icon)
        header.icon = { tag: 'standard_icon', token: opts.icon };
    if (opts.subtitle)
        header.subtitle = { tag: 'plain_text', content: opts.subtitle };
    return header;
}
//# sourceMappingURL=feishu-card-header.js.map