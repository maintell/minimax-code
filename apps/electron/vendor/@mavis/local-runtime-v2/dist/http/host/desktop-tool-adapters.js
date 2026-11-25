/**
 * The later desktop tools: project / pin / favorite writes, fork and wait,
 * plugins, and the seven operations that only the desktop window can do.
 * Every one of them needs the desktop app, so only the Electron owner
 * exposes them and CLI / TUI never see them.
 */
export function buildOwnerDesktopToolAdapters(ports) {
    const uiRequestAdapter = buildOwnerUiRequestAdapter(ports);
    if (!ports.desktopAgentTools || !ports.isElectronOwner) {
        return uiRequestAdapter ? { uiRequestAdapter } : {};
    }
    const adapters = ports.desktopAgentTools.createAdapters({
        publishGlobalEvent: ports.publishGlobalEvent,
    });
    return {
        sidebarManageAdapter: adapters.sidebarManage,
        sessionManageAdapter: adapters.sessionManage,
        appManageAdapter: adapters.appManage,
        ...(uiRequestAdapter ? { uiRequestAdapter } : {}),
    };
}
/**
 * Whether this owner registers any of the four adapters above. The Skill catalog
 * reads this instead of building a second set of adapters just to count them,
 * so "the desktop tools exist" has one answer per owner.
 */
function ownerHasDesktopToolAdapters(ports) {
    if (!ports.isElectronOwner)
        return false;
    return ports.desktopAgentTools !== undefined || ports.uiRequestBroker !== undefined;
}
/**
 * The sidebar lives in the desktop app, so only the Electron owner exposes its
 * tools; every other owner kind answers `undefined` and the Skill gate stays shut.
 */
export function buildOwnerSidebarToolsAdapter(ports) {
    if (!ports.sidebarTools || !ports.isElectronOwner)
        return undefined;
    return ports.sidebarTools.createToolAdapter({
        publishGlobalEvent: ports.publishGlobalEvent,
    });
}
/**
 * The desktop / Cron capability facts the namespace Skills are gated by,
 * answered from the same owner state the Turn tool sources read. The Skill
 * catalog runs before any Turn tool exists, so it asks here rather than
 * building a second set of adapters to count them.
 */
export function ownerNamespacedToolAvailability(ports, mavisCronAdapter) {
    return {
        desktopToolsAvailable: buildOwnerSidebarToolsAdapter(ports) !== undefined || ownerHasDesktopToolAdapters(ports),
        cronToolsAvailable: mavisCronAdapter !== undefined,
    };
}
function buildOwnerUiRequestAdapter(ports) {
    const broker = ports.uiRequestBroker;
    if (!broker || !ports.isElectronOwner)
        return undefined;
    return {
        request: (input, signal) => broker.request(input, signal),
    };
}
//# sourceMappingURL=desktop-tool-adapters.js.map