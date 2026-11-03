import { parseMiniAppPermissionList } from "@mavis/shared/miniapp-surface";
import { requestUtilityMiniApp } from "../local-runtime/utility";
/**
 * Reads a Mini App's switches through the Utility broker, the same list the plugin detail shows.
 * Undeclared or unknown to the runtime counts as off; `isEnabled` also counts unreachable as off.
 */
export function createUtilityMiniAppPermissionSwitches() {
    const enabledPermissions = async (pluginId) => {
        const result = await requestUtilityMiniApp('permissions.list', pluginId);
        const list = 'permissions' in result ? parseMiniAppPermissionList(result.permissions) : null;
        return new Set(list?.items.filter((item) => item.enabled).map((item) => item.id));
    };
    return {
        enabledPermissions,
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
