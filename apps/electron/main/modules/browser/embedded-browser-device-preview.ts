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
        if (result.success === false)
            return { ...result, tabId: tab.tabId };
        if (result.changed)
            invalidateAgentElementState(tab);
        return { ...result, tabId: tab.tabId };
    }
    catch (error) {
        return {
            success: false,
            error: safeError(error),
            mode: tab.controller.getDevicePreviewMode(),
            tabId: tab.tabId,
        };
    }
}
