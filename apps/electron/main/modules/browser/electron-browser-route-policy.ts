export let ELECTRON_BROWSER_PUBLIC_ACTIONS = [
    'inspect',
    'query',
    'navigate',
    'back',
    'forward',
    'reload',
    'click',
    'click_and_wait_for_navigation',
    'double_click',
    'triple_click',
    'drag',
    'hover',
    'fill',
    'type',
    'press_key',
    'check',
    'uncheck',
    'select_option',
    'scroll',
    'wait',
    'screenshot',
    'upload_files',
    'get_js_dialog',
    'handle_js_dialog',
    'open_tab',
    'list_tabs',
    'select_tab',
    'close_tab',
    'mark_tab',
    'show_tab',
    'release_tab',
    'run_script',
];
const ELECTRON_BROWSER_ROUTE_OWNERS = {
    inspect: 'core',
    query: 'core',
    navigate: 'core',
    back: 'core',
    forward: 'core',
    reload: 'core',
    click: 'core',
    click_and_wait_for_navigation: 'core',
    double_click: 'core',
    triple_click: 'core',
    drag: 'core',
    hover: 'core',
    fill: 'core',
    type: 'core',
    press_key: 'core',
    check: 'core',
    uncheck: 'core',
    select_option: 'core',
    scroll: 'core',
    wait: 'core',
    screenshot: 'core',
    upload_files: 'core',
    get_js_dialog: 'core',
    handle_js_dialog: 'core',
    open_tab: 'host',
    list_tabs: 'host',
    select_tab: 'host',
    close_tab: 'host',
    mark_tab: 'host',
    show_tab: 'host',
    release_tab: 'host',
    run_script: 'core',
};
export let ELECTRON_BROWSER_CORE_ACTIONS = ELECTRON_BROWSER_PUBLIC_ACTIONS.filter((action) => ELECTRON_BROWSER_ROUTE_OWNERS[action] === 'core');
/**
 * Describes the intended owner of an Electron Browser action without executing it.
 * Runtime migration can consume this policy incrementally without changing the
 * public capability surface or introducing an implicit legacy fallback.
 */
export function resolveElectronBrowserActionRoute(action) {
    if (!isElectronBrowserPublicAction(action))
        return null;
    return {
        action,
        owner: ELECTRON_BROWSER_ROUTE_OWNERS[action],
    };
}
function isElectronBrowserPublicAction(action) {
    return Object.prototype.hasOwnProperty.call(ELECTRON_BROWSER_ROUTE_OWNERS, action);
}
