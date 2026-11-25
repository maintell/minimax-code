/** Product-level Plugin Hook events shared by Desktop and Cloud runtimes. */
export const PLUGIN_HOOK_EVENTS = [
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'SubagentStart',
    'SubagentStop',
    'Stop',
    'PreCompact',
    'PostCompact',
];
export const HOOK_MODULES_INVALID_FIX = '让 `hooks/hooks.json` 的 `modules` 只含一个相对路径，后缀为 `.js .mjs .cjs .jsx .ts .mts .cts .tsx`，文件存在';
//# sourceMappingURL=contracts.js.map