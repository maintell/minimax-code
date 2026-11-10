import { safeError } from "./embedded-browser-manager-helpers";
function invalidateAgentElementState(tab) {
    tab.agentSnapshots?.clear();
    tab.agentSnapshots = undefined;
    tab.controller.getElementMapManager().clear();
    tab.controller.getCDPHelper()?.markDirty();
}
export async function setTabDevicePreviewMode(tab, mode) {
    try {
        const result = await tab.controller.setDevicePreviewMode(mode);
        if (result.success === false || result.changed)
            invalidateAgentElementState(tab);
        return { ...result, tabId: tab.tabId };
    }
    catch (error) {
        invalidateAgentElementState(tab);
        return {
            success: false,
            error: safeError(error),
            mode: tab.controller.getDevicePreviewMode(),
            tabId: tab.tabId,
        };
    }
}
export async function updateTabDevicePreview(tab, request) {
    try {
        const result = await tab.controller.updateDevicePreview(request);
        // A failed apply can roll back metrics/identity and invalidate the old refs too.
        if (result.success === false || result.changed)
            invalidateAgentElementState(tab);
        return { ...result, tabId: tab.tabId };
    }
    catch (error) {
        invalidateAgentElementState(tab);
        return {
            success: false,
            error: safeError(error),
            devicePreviewState: tab.controller.getDevicePreviewState(),
            tabId: tab.tabId,
        };
    }
}
