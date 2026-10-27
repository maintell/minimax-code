import { parseMiniAppPermissionList } from "@mavis/shared/miniapp-surface";
import { requestUtilityMiniApp } from "../local-runtime/utility";
/**
 * Reads one declared permission's switch through the Utility broker, the same list the plugin
 * detail shows. Undeclared, unknown to the runtime, or unreachable all count as off.
 */
export function createUtilityMiniAppPermissionSwitches() {
    return {
        async isEnabled(pluginId, permission) {
            try {
                const result = await requestUtilityMiniApp('permissions.list', pluginId);
                const list = 'permissions' in result ? parseMiniAppPermissionList(result.permissions) : null;
                return list?.items.some((item) => item.id === permission && item.enabled) === true;
            }
            catch {
                return false;
            }
        },
    };
}
