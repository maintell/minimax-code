/**
 * The space_* tool names on their own, free of tool construction and Space IO.
 * Host-neutral subpaths read them without loading the Space operations.
 */
export const SPACE_LIST_TOOL_NAME = 'space_list';
export const SPACE_STAT_TOOL_NAME = 'space_stat';
export const SPACE_SEARCH_TOOL_NAME = 'space_search';
export const SPACE_DOWNLOAD_TOOL_NAME = 'space_download';
export const SPACE_DOWNLOAD_URL_TOOL_NAME = 'space_download_url';
export const SPACE_UPLOAD_TOOL_NAME = 'space_upload';
export const SPACE_MKDIR_TOOL_NAME = 'space_mkdir';
export const SPACE_MOVE_TOOL_NAME = 'space_move';
export const SPACE_RENAME_TOOL_NAME = 'space_rename';
export const SPACE_DELETE_TOOL_NAME = 'space_delete';
export const SPACE_FAVORITE_TOOL_NAME = 'space_favorite';
export const SPACE_QUOTA_TOOL_NAME = 'space_quota';
/** Every space_* tool, in the order the definitions declare them. */
export const SPACE_TOOL_NAMES = [
    SPACE_LIST_TOOL_NAME,
    SPACE_STAT_TOOL_NAME,
    SPACE_SEARCH_TOOL_NAME,
    SPACE_DOWNLOAD_TOOL_NAME,
    SPACE_DOWNLOAD_URL_TOOL_NAME,
    SPACE_UPLOAD_TOOL_NAME,
    SPACE_MKDIR_TOOL_NAME,
    SPACE_MOVE_TOOL_NAME,
    SPACE_RENAME_TOOL_NAME,
    SPACE_DELETE_TOOL_NAME,
    SPACE_FAVORITE_TOOL_NAME,
    SPACE_QUOTA_TOOL_NAME,
];
/** Tools that change Space. space_download changes only local files. */
export const SPACE_REMOTE_WRITE_TOOL_NAMES = [
    SPACE_UPLOAD_TOOL_NAME,
    SPACE_MKDIR_TOOL_NAME,
    SPACE_MOVE_TOOL_NAME,
    SPACE_RENAME_TOOL_NAME,
    SPACE_DELETE_TOOL_NAME,
    SPACE_FAVORITE_TOOL_NAME,
];
//# sourceMappingURL=tool-names.js.map