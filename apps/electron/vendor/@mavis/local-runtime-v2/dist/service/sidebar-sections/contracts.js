/**
 * Runtime KV key that holds the whole desktop sidebar sections state. The
 * renderer used to own this in localStorage; it now reads and writes this one
 * copy so the sidebar UI and the Agent `sidebar.section` tools never disagree.
 */
export const SIDEBAR_SECTIONS_PREFERENCE_KEY = 'sidebar-sections';
/**
 * Completion marker for the one-time import of the renderer's localStorage
 * copy. It lives in the same per-data-directory KV table, so every data
 * directory imports once and then keeps its own sections.
 */
export const SIDEBAR_SECTIONS_IMPORTED_PREFERENCE_KEY = 'sidebar-sections-imported';
export const SIDEBAR_SECTION_NAME_MAX_LENGTH = 30;
/** Block id of 置顶 inside `blockOrder`; section ids are `sec_*`, so it never collides. */
export const SIDEBAR_PINNED_BLOCK_ID = 'pinned';
//# sourceMappingURL=contracts.js.map