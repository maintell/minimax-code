import { DESKTOP_UI_FONT_FAMILY } from './desktop-typography.js';
export const COMMENT_COMPOSER_THEME_ROLES = {
    surface: '--bg_grouped_secondary_elevated',
    border: '--border_default',
    shadow: '--shadow_default',
    text: '--text_default_primary',
    placeholder: '--text_default_tertiary',
    caret: '--border_accent',
    primaryBg: '--bg_interaction_primary_default',
    primaryHover: '--bg_interaction_primary_hover',
    primaryInactive: '--bg_interaction_primary_inactive',
    primaryIcon: '--icon_interaction_primary_default',
    secondaryBg: '--bg_interaction_secondary_default',
    secondaryHover: '--bg_interaction_secondary_hover',
    secondaryIcon: '--icon_default_primary',
    tertiaryIcon: '--icon_default_tertiary',
    tertiaryHover: '--icon_interaction_tertiary_hover',
};
/** CSS variables used inside an injected page's isolated shadow root. */
export const COMMENT_COMPOSER_BRIDGE_THEME_VARIABLES = {
    surface: '--mavis-comment-surface',
    border: '--mavis-comment-border',
    shadow: '--mavis-comment-shadow',
    text: '--mavis-comment-text',
    placeholder: '--mavis-comment-placeholder',
    caret: '--mavis-comment-caret',
    primaryBg: '--mavis-comment-primary-bg',
    primaryHover: '--mavis-comment-primary-hover',
    primaryInactive: '--mavis-comment-primary-inactive',
    primaryIcon: '--mavis-comment-primary-icon',
    secondaryBg: '--mavis-comment-secondary-bg',
    secondaryHover: '--mavis-comment-secondary-hover',
    secondaryIcon: '--mavis-comment-secondary-icon',
    tertiaryIcon: '--mavis-comment-tertiary-icon',
    tertiaryHover: '--mavis-comment-tertiary-hover',
};
/**
 * Canonical geometry and behavior, extracted from the verified embedded
 * browser composer. Numeric values are CSS pixels in both renderers.
 */
export const COMMENT_COMPOSER_SPEC = {
    width: {
        min: 260,
        max: 383,
        viewportInset: 16,
    },
    placement: {
        anchorGap: 12,
        bottomInset: 24,
    },
    wrapper: {
        borderWidth: 1,
        borderRadius: 12,
        shadowBlur: 10,
        /**
         * The single-row create box: text on the left, a filled button hard against
         * the right. The button's own box supplies the optical margin that the text
         * needs spelled out, which is why the two sides differ.
         */
        padding: { top: 5, right: 5, bottom: 5, left: 11 },
        /**
         * Stacked layouts put text against BOTH edges and line two buttons up
         * across the same row, so the asymmetry above would read as a mistake.
         * Both sides take the text inset.
         */
        stackedPaddingX: 11,
    },
    create: {
        /** Collapsed height — what the box opens at, and what placement estimates against. */
        height: 44,
        gap: 16,
        inputRowHeight: 32,
        inputHeight: 20,
        /** Keeps the single line optically centred in `inputRowHeight` (20 + 6 + 6 = 32). */
        inputRowPaddingY: 6,
    },
    edit: {
        height: 106,
        gap: 4,
        inputRowHeight: 58,
        inputHeight: 50,
        inputRowPaddingY: 4,
        footerHeight: 32,
        actionsGap: 8,
    },
    input: {
        fontWeight: 400,
        fontSize: 14,
        lineHeight: 20,
        fontFamily: DESKTOP_UI_FONT_FAMILY,
        focusOutline: 0,
        /**
         * Auto-grow ceiling shared by both boxes, in text lines rather than pixels
         * so it follows the user's font-size preference instead of freezing at the
         * default 20px line. A whole number of lines, so a grown box never stops on
         * a half-cut line; past it the input scrolls and the box stops growing.
         *
         * One value for both because the two boxes open on the same quote, one
         * after the other — a comment that fits in one of them has to fit in the
         * other. Set from how the box reads in use: the edit box's own
         * `inputHeight` (2.5 lines) looked like a two-line field and ran out well
         * before an ordinary comment was finished.
         */
        maxLines: 5,
    },
    /**
     * Submit (✓) and cancel (✕) share the chat composer's send button: a circle
     * rather than a rounded square, at the same 30px box and 18px glyph. The two
     * boxes sit on the same surface one above the other — a quote is commented
     * here and sent from there — so a different button shape read as a second,
     * unrelated control.
     *
     * `borderRadius` stays a pixel number because both renderers serialise it as
     * `${borderRadius}px`; any value past half the box is a full circle, and it
     * keeps following the box if the size ever changes.
     */
    actionButton: {
        size: 30,
        borderRadius: 9999,
        iconSize: 18,
        transition: 'background-color 0.15s, color 0.15s',
        enabledCursor: 'pointer',
        disabledCursor: 'default',
    },
    deleteButton: {
        size: 20,
        /**
         * The discard slot is a bare glyph with no button box of its own, so it
         * keeps its own size instead of following the action buttons — it has no
         * filled circle to sit inside and would just shrink.
         */
        iconSize: 20,
        transition: 'color 0.15s',
    },
    behavior: {
        trimOnSubmit: true,
        disableEmptySubmit: true,
        escapeCancels: true,
        focusOnOpen: true,
        createEnterSubmitsWithShift: true,
        editShiftEnterCreatesNewline: true,
    },
};
export function createCommentComposerState(input) {
    const canDelete = input.mode === 'edit' && input.canDelete === true;
    return {
        mode: input.mode,
        draft: input.draft ?? '',
        anchor: input.anchor,
        canDelete,
        actions: canDelete ? ['submit', 'cancel', 'delete'] : ['submit', 'cancel'],
    };
}
export function getCommentComposerSubmission(draft) {
    const value = COMMENT_COMPOSER_SPEC.behavior.trimOnSubmit ? draft.trim() : draft;
    return value.length > 0 ? value : null;
}
/**
 * Resolve the rendered height and overflow mode of an auto-growing comment
 * input.
 *
 * Both renderers share it so a comment box behaves identically in the chat
 * surface and inside an injected page: the React adapter imports it, and the
 * embedded-browser bridge serialises it into its injected script.
 *
 * Kept pure and separate from the DOM writes because jsdom has no layout
 * engine — every scroll/client metric there is 0, so the clamp itself can only
 * be covered by feeding it measurements directly.
 *
 * Self-contained by requirement: the bridge injects this function through
 * `toString()`, so it must not close over module-level bindings.
 */
export function resolveCommentInputAutoGrow(input) {
    // Sub-pixel slack, so a line height like 22.75px doesn't fake an overflow.
    // Inlined rather than shared as a module constant — see the note above.
    const epsilon = 0.5;
    const ceiling = Math.max(input.minHeight, input.maxHeight);
    const height = Math.min(Math.max(input.contentHeight, input.minHeight), ceiling);
    return {
        height,
        // Hand scrolling over only once the text genuinely exceeds the ceiling:
        // a permanently `auto` textarea flashes a scrollbar on the exact-fit line.
        overflowY: input.contentHeight > ceiling + epsilon ? 'auto' : 'hidden',
        // The comment has left the opening single line. `create` uses this to hand
        // the input the full width and move its actions to a row underneath.
        wrapped: input.contentHeight > input.minHeight + epsilon,
    };
}
export function shouldSubmitCommentComposerOnEnter(mode, shiftKey) {
    if (mode === 'create')
        return COMMENT_COMPOSER_SPEC.behavior.createEnterSubmitsWithShift;
    return !(shiftKey && COMMENT_COMPOSER_SPEC.behavior.editShiftEnterCreatesNewline);
}
//# sourceMappingURL=comment-composer.js.map