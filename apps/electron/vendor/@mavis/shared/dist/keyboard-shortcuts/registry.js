import { normalizeAccelerator } from './accelerator.js';
const definition = (value) => value;
const baseDefinitions = [
    definition({
        id: 'miniChat.toggle',
        category: 'miniChat',
        scope: 'global',
        labelKey: 'settings.shortcuts.actions.mini_chat.label',
        descriptionKey: 'settings.shortcuts.actions.mini_chat.description',
        searchKeywordsKey: 'settings.shortcuts.actions.mini_chat.keywords',
        defaults: { mac: null, windows: null },
        configurable: true,
        handledBy: 'electron-global',
    }),
    definition({
        id: 'search.all',
        category: 'common',
        scope: 'app',
        labelKey: 'settings.shortcuts.actions.search_all.label',
        descriptionKey: 'settings.shortcuts.actions.search_all.description',
        searchKeywordsKey: 'settings.shortcuts.actions.search_all.keywords',
        defaults: {
            mac: ['Command+K', 'Command+Shift+P'],
            windows: ['Ctrl+K', 'Ctrl+Shift+P'],
        },
        configurable: true,
        handledBy: 'renderer',
    }),
    definition({
        id: 'search.sessions',
        category: 'common',
        scope: 'app',
        labelKey: 'settings.shortcuts.actions.search_sessions.label',
        descriptionKey: 'settings.shortcuts.actions.search_sessions.description',
        searchKeywordsKey: 'settings.shortcuts.actions.search_sessions.keywords',
        defaults: { mac: 'Command+G', windows: 'Ctrl+G' },
        configurable: true,
        handledBy: 'renderer',
    }),
    definition({
        id: 'task.new',
        category: 'common',
        scope: 'app',
        labelKey: 'settings.shortcuts.actions.task_new.label',
        descriptionKey: 'settings.shortcuts.actions.task_new.description',
        searchKeywordsKey: 'settings.shortcuts.actions.task_new.keywords',
        defaults: {
            mac: ['Command+N', 'Command+Shift+O'],
            windows: ['Ctrl+N', 'Ctrl+Shift+O'],
        },
        configurable: true,
        handledBy: 'renderer',
        commandMenuGroup: 'recommended',
    }),
    definition({
        id: 'task.newWithoutProject',
        category: 'common',
        scope: 'app',
        labelKey: 'settings.shortcuts.actions.task_new_without_project.label',
        descriptionKey: 'settings.shortcuts.actions.task_new_without_project.description',
        searchKeywordsKey: 'settings.shortcuts.actions.task_new_without_project.keywords',
        defaults: { mac: 'Command+Alt+O', windows: 'Ctrl+Alt+O' },
        configurable: true,
        handledBy: 'renderer',
        commandMenuGroup: 'recommended',
    }),
    definition({
        id: 'project.open',
        category: 'common',
        scope: 'app',
        labelKey: 'settings.shortcuts.actions.project_open.label',
        descriptionKey: 'settings.shortcuts.actions.project_open.description',
        searchKeywordsKey: 'settings.shortcuts.actions.project_open.keywords',
        defaults: { mac: 'Command+O', windows: 'Ctrl+O' },
        configurable: true,
        handledBy: 'renderer',
        commandMenuGroup: 'recommended',
    }),
    definition({
        id: 'sidechat.create',
        category: 'panels',
        scope: 'app',
        labelKey: 'settings.shortcuts.actions.sidechat_create.label',
        descriptionKey: 'settings.shortcuts.actions.sidechat_create.description',
        searchKeywordsKey: 'settings.shortcuts.actions.sidechat_create.keywords',
        defaults: { mac: 'Option+Command+S', windows: 'Ctrl+Alt+S' },
        configurable: true,
        handledBy: 'renderer',
        commandMenuGroup: 'panels',
    }),
    definition({
        id: 'sidebar.toggle',
        category: 'panels',
        scope: 'app',
        labelKey: 'settings.shortcuts.actions.sidebar_toggle.label',
        descriptionKey: 'settings.shortcuts.actions.sidebar_toggle.description',
        searchKeywordsKey: 'settings.shortcuts.actions.sidebar_toggle.keywords',
        defaults: { mac: 'Command+B', windows: 'Ctrl+B' },
        configurable: true,
        handledBy: 'renderer',
        commandMenuGroup: 'panels',
    }),
    definition({
        id: 'terminal.toggle',
        category: 'panels',
        scope: 'app',
        labelKey: 'settings.shortcuts.actions.terminal_toggle.label',
        descriptionKey: 'settings.shortcuts.actions.terminal_toggle.description',
        searchKeywordsKey: 'settings.shortcuts.actions.terminal_toggle.keywords',
        defaults: { mac: 'Command+J', windows: 'Ctrl+J' },
        configurable: true,
        handledBy: 'renderer',
        commandMenuGroup: 'panels',
    }),
    definition({
        id: 'browser.open',
        category: 'panels',
        scope: 'session',
        labelKey: 'settings.shortcuts.actions.browser_open.label',
        descriptionKey: 'settings.shortcuts.actions.browser_open.description',
        searchKeywordsKey: 'settings.shortcuts.actions.browser_open.keywords',
        defaults: { mac: 'Command+T', windows: 'Ctrl+T' },
        configurable: true,
        handledBy: 'renderer',
        commandMenuGroup: 'panels',
    }),
    definition({
        id: 'files.open',
        category: 'panels',
        scope: 'session',
        labelKey: 'settings.shortcuts.actions.files_open.label',
        descriptionKey: 'settings.shortcuts.actions.files_open.description',
        searchKeywordsKey: 'settings.shortcuts.actions.files_open.keywords',
        defaults: { mac: 'Command+P', windows: 'Ctrl+P' },
        configurable: true,
        handledBy: 'renderer',
        commandMenuGroup: 'panels',
    }),
    definition({
        id: 'workspacePanel.toggle',
        category: 'panels',
        scope: 'app',
        labelKey: 'settings.shortcuts.actions.workspace_panel_toggle.label',
        descriptionKey: 'settings.shortcuts.actions.workspace_panel_toggle.description',
        searchKeywordsKey: 'settings.shortcuts.actions.workspace_panel_toggle.keywords',
        defaults: { mac: 'Command+Alt+B', windows: 'Ctrl+Alt+B' },
        configurable: true,
        handledBy: 'renderer',
        commandMenuGroup: 'panels',
    }),
    definition({
        id: 'workspacePanel.closeCurrentTab',
        category: 'panels',
        scope: 'session',
        labelKey: 'settings.shortcuts.actions.workspace_panel_close_current_tab.label',
        descriptionKey: 'settings.shortcuts.actions.workspace_panel_close_current_tab.description',
        searchKeywordsKey: 'settings.shortcuts.actions.workspace_panel_close_current_tab.keywords',
        defaults: { mac: 'Command+W', windows: 'Ctrl+W' },
        configurable: true,
        handledBy: 'renderer',
    }),
    definition({
        id: 'navigation.back',
        category: 'navigation',
        scope: 'app',
        labelKey: 'settings.shortcuts.actions.navigation_back.label',
        descriptionKey: 'settings.shortcuts.actions.navigation_back.description',
        searchKeywordsKey: 'settings.shortcuts.actions.navigation_back.keywords',
        defaults: { mac: 'Command+[', windows: 'Ctrl+[' },
        configurable: true,
        handledBy: 'renderer',
        commandMenuGroup: 'navigation',
    }),
    definition({
        id: 'navigation.forward',
        category: 'navigation',
        scope: 'app',
        labelKey: 'settings.shortcuts.actions.navigation_forward.label',
        descriptionKey: 'settings.shortcuts.actions.navigation_forward.description',
        searchKeywordsKey: 'settings.shortcuts.actions.navigation_forward.keywords',
        defaults: { mac: 'Command+]', windows: 'Ctrl+]' },
        configurable: true,
        handledBy: 'renderer',
        commandMenuGroup: 'navigation',
    }),
    definition({
        id: 'session.previous',
        category: 'navigation',
        scope: 'session',
        labelKey: 'settings.shortcuts.actions.session_previous.label',
        descriptionKey: 'settings.shortcuts.actions.session_previous.description',
        searchKeywordsKey: 'settings.shortcuts.actions.session_previous.keywords',
        defaults: {
            mac: ['Command+Shift+[', 'Ctrl+Shift+Tab'],
            windows: ['Ctrl+Shift+[', 'Ctrl+Shift+Tab', 'Ctrl+PageUp'],
        },
        configurable: true,
        handledBy: 'renderer',
        commandMenuGroup: 'navigation',
    }),
    definition({
        id: 'session.next',
        category: 'navigation',
        scope: 'session',
        labelKey: 'settings.shortcuts.actions.session_next.label',
        descriptionKey: 'settings.shortcuts.actions.session_next.description',
        searchKeywordsKey: 'settings.shortcuts.actions.session_next.keywords',
        defaults: {
            mac: ['Command+Shift+]', 'Ctrl+Tab'],
            windows: ['Ctrl+Shift+]', 'Ctrl+Tab', 'Ctrl+PageDown'],
        },
        configurable: true,
        handledBy: 'renderer',
        commandMenuGroup: 'navigation',
    }),
    definition({
        id: 'settings.open',
        category: 'common',
        scope: 'app',
        labelKey: 'settings.shortcuts.actions.settings_open.label',
        descriptionKey: 'settings.shortcuts.actions.settings_open.description',
        searchKeywordsKey: 'settings.shortcuts.actions.settings_open.keywords',
        defaults: { mac: 'Command+,', windows: 'Ctrl+,' },
        configurable: true,
        handledBy: 'renderer',
        commandMenuGroup: 'recommended',
    }),
    definition({
        id: 'asr.pushToTalk',
        category: 'common',
        scope: 'app',
        labelKey: 'settings.shortcuts.actions.asr_push_to_talk.label',
        descriptionKey: 'settings.shortcuts.actions.asr_push_to_talk.description',
        searchKeywordsKey: 'settings.shortcuts.actions.asr_push_to_talk.keywords',
        defaults: { mac: null, windows: null },
        configurable: true,
        handledBy: 'renderer',
    }),
    definition({
        id: 'asr.toggle',
        category: 'common',
        scope: 'app',
        labelKey: 'settings.shortcuts.actions.asr_toggle.label',
        descriptionKey: 'settings.shortcuts.actions.asr_toggle.description',
        searchKeywordsKey: 'settings.shortcuts.actions.asr_toggle.keywords',
        // Ctrl (not Command) on macOS as well, matching ChatGPT's voice toggle.
        defaults: { mac: 'Ctrl+Shift+D', windows: 'Ctrl+Shift+D' },
        configurable: true,
        handledBy: 'renderer',
    }),
    definition({
        id: 'settings.openShortcuts',
        category: 'common',
        scope: 'app',
        labelKey: 'settings.shortcuts.actions.settings_open_shortcuts.label',
        descriptionKey: 'settings.shortcuts.actions.settings_open_shortcuts.description',
        searchKeywordsKey: 'settings.shortcuts.actions.settings_open_shortcuts.keywords',
        defaults: { mac: 'Command+/', windows: 'Ctrl+/' },
        configurable: true,
        handledBy: 'renderer',
    }),
    definition({
        id: 'session.find',
        category: 'navigation',
        scope: 'session',
        labelKey: 'settings.shortcuts.actions.session_find.label',
        descriptionKey: 'settings.shortcuts.actions.session_find.description',
        searchKeywordsKey: 'settings.shortcuts.actions.session_find.keywords',
        defaults: { mac: 'Command+F', windows: 'Ctrl+F' },
        configurable: false,
        handledBy: 'renderer',
        commandMenuGroup: 'navigation',
    }),
    definition({
        id: 'session.pin',
        category: 'common',
        scope: 'session',
        labelKey: 'settings.shortcuts.actions.session_pin.label',
        descriptionKey: 'settings.shortcuts.actions.session_pin.description',
        searchKeywordsKey: 'settings.shortcuts.actions.session_pin.keywords',
        defaults: { mac: 'Command+Alt+P', windows: 'Ctrl+Alt+P' },
        configurable: true,
        handledBy: 'renderer',
    }),
    definition({
        id: 'session.rename',
        category: 'common',
        scope: 'session',
        labelKey: 'settings.shortcuts.actions.session_rename.label',
        descriptionKey: 'settings.shortcuts.actions.session_rename.description',
        searchKeywordsKey: 'settings.shortcuts.actions.session_rename.keywords',
        defaults: { mac: 'Command+Alt+R', windows: 'Ctrl+Alt+R' },
        configurable: true,
        handledBy: 'renderer',
    }),
    definition({
        id: 'session.archive',
        category: 'common',
        scope: 'session',
        labelKey: 'settings.shortcuts.actions.session_archive.label',
        descriptionKey: 'settings.shortcuts.actions.session_archive.description',
        searchKeywordsKey: 'settings.shortcuts.actions.session_archive.keywords',
        defaults: { mac: 'Command+Shift+A', windows: 'Ctrl+Shift+A' },
        configurable: true,
        handledBy: 'renderer',
    }),
    definition({
        id: 'session.copyId',
        category: 'common',
        scope: 'session',
        labelKey: 'settings.shortcuts.actions.session_copy_id.label',
        descriptionKey: 'settings.shortcuts.actions.session_copy_id.description',
        searchKeywordsKey: 'settings.shortcuts.actions.session_copy_id.keywords',
        defaults: { mac: 'Command+Alt+C', windows: 'Ctrl+Alt+C' },
        configurable: true,
        handledBy: 'renderer',
    }),
    definition({
        id: 'session.copyWorkingDir',
        category: 'common',
        scope: 'session',
        labelKey: 'settings.shortcuts.actions.session_copy_working_dir.label',
        descriptionKey: 'settings.shortcuts.actions.session_copy_working_dir.description',
        searchKeywordsKey: 'settings.shortcuts.actions.session_copy_working_dir.keywords',
        defaults: { mac: 'Command+Shift+C', windows: 'Ctrl+Shift+C' },
        configurable: true,
        handledBy: 'renderer',
    }),
    definition({
        // Handled by the composer's rich-text keymap (Mod-Enter); listed here for
        // the settings shortcut list, search, and conflict reservation.
        id: 'composer.invertSendBehavior',
        category: 'common',
        scope: 'session',
        labelKey: 'settings.shortcuts.actions.composer_invert_send_behavior.label',
        descriptionKey: 'settings.shortcuts.actions.composer_invert_send_behavior.description',
        searchKeywordsKey: 'settings.shortcuts.actions.composer_invert_send_behavior.keywords',
        defaults: { mac: 'Command+Enter', windows: 'Ctrl+Enter' },
        configurable: false,
        handledBy: 'existing',
    }),
];
const sessionSlotDefinitions = Array.from({ length: 9 }, (_, index) => {
    const slot = (index + 1);
    return definition({
        id: `session.slot.${slot}`,
        category: 'navigation',
        scope: 'session',
        labelKey: `settings.shortcuts.actions.session_slot_${slot}.label`,
        descriptionKey: `settings.shortcuts.actions.session_slot_${slot}.description`,
        defaults: {
            mac: `Command+${slot}`,
            windows: `Ctrl+${slot}`,
        },
        configurable: true,
        handledBy: 'renderer',
    });
});
export const SHORTCUT_DEFINITIONS = [
    ...baseDefinitions,
    ...sessionSlotDefinitions,
];
export function isStandardShortcutAction(id) {
    return id === 'session.find' || id === 'workspacePanel.closeCurrentTab';
}
const disabledAppShortcutOverrides = Object.fromEntries(SHORTCUT_DEFINITIONS.filter(({ id }) => !isStandardShortcutAction(id)).map(({ id }) => [
    id,
    null,
]));
/** Suspend MCode bindings while retaining the platform's default Find and Close commands. */
export function getActiveShortcutOverrides(overrides, enabled) {
    return enabled ? overrides : disabledAppShortcutOverrides;
}
const definitionsById = new Map(SHORTCUT_DEFINITIONS.map((value) => [value.id, value]));
export function getShortcutDefinition(id) {
    const value = definitionsById.get(id);
    if (!value) {
        throw new Error(`Unknown shortcut action: ${id}`);
    }
    return value;
}
/**
 * Lazy read normalization for one override value: legacy string → single
 * binding, array → every non-empty entry, null/empty → disabled.
 */
export function normalizeOverrideValue(value) {
    if (value == null)
        return null;
    const entries = (Array.isArray(value) ? value : [value]).filter((entry) => typeof entry === 'string' && entry.length > 0);
    return entries.length > 0 ? entries : null;
}
/**
 * Single-value resolution: the first EFFECTIVE binding — an override wins
 * (null disables), otherwise the first default alias not claimed by another
 * action's explicit override. Display surfaces and the Electron main process
 * rely on this staying a single accelerator; use `resolveShortcutBindings`
 * for matching against every active alias.
 */
export function resolveShortcut(id, overrides, platform) {
    return resolveShortcutBindings(id, overrides, platform)[0] ?? null;
}
/**
 * Every accelerator explicitly claimed by a user override, normalized.
 * Null (disabled) overrides claim nothing. SHORTCUT_DEFINITIONS is fixed and
 * overrides stay tiny, so rebuilding this per resolution is negligible.
 */
function claimedOverrideAccelerators(overrides) {
    const claimed = new Set();
    for (const value of Object.values(overrides)) {
        const bindings = normalizeOverrideValue(value);
        if (!bindings)
            continue;
        for (const binding of bindings)
            claimed.add(normalizeAccelerator(binding));
    }
    return claimed;
}
/**
 * Every accelerator that currently triggers the action, normalized. An
 * override replaces the default alias set with the user's own binding list
 * (`[]` when disabled). Without an override the default aliases apply, MINUS
 * any alias explicitly claimed by another action's override: a user binding
 * predating a newly shipped default alias must keep winning (dispatch,
 * forwarding, settings display and hints all consume this "effective
 * bindings" semantic).
 */
export function resolveShortcutBindings(id, overrides, platform) {
    if (Object.prototype.hasOwnProperty.call(overrides, id)) {
        const bindings = normalizeOverrideValue(overrides[id]);
        return bindings ? bindings.map(normalizeAccelerator) : [];
    }
    const defaults = getShortcutDefinition(id).defaults[platform];
    if (defaults == null)
        return [];
    const aliases = Array.isArray(defaults) ? defaults : [defaults];
    const claimed = claimedOverrideAccelerators(overrides);
    return aliases
        .filter((alias) => Boolean(alias))
        .map(normalizeAccelerator)
        .filter((alias) => !claimed.has(alias));
}
//# sourceMappingURL=registry.js.map