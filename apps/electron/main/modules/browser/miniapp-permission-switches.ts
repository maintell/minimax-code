import { parseMiniAppPermissionList } from "@mavis/shared/miniapp-surface";
import { requestUtilityMiniApp } from "../local-runtime/utility";
export function createUtilityMiniAppPermissionSwitches() {
    const readList = async (pluginId) => {
        const result = await requestUtilityMiniApp('permissions.list', pluginId);
        return 'permissions' in result ? parseMiniAppPermissionList(result.permissions) : null;
    };
    const enabledPermissions = async (pluginId) => {
        const list = await readList(pluginId);
        return new Set(list?.items.filter((item) => item.enabled).map((item) => item.id));
    };
    return {
        enabledPermissions,
        async readEnabled(pluginId, permission) {
            const list = await readList(pluginId);
            if (!list || list.pluginId !== pluginId)
                throw new Error('Mini App permissions unavailable');
            return list.items.some((item) => item.id === permission && item.enabled);
        },
        async isEnabled(pluginId, permission) {
            try {
                return (await enabledPermissions(pluginId)).has(permission);
            }
            catch {
                return false;
            }
        },
    };
}
