import { withEffectiveAdvisor } from '@mavis/config';
/**
 * Fills the effective global advisor switch (`advisor.enabled`) into a host's config read
 * boundary: its getter and its updater's answer. Advisor reads and the GET/PUT `/config` answers
 * all read these two, so the settings page, `/advisor` and every Turn see one value. The value is
 * recomputed from the config on every read; nothing is cached.
 */
export function withEffectiveAdvisorConfig(boundary) {
    return {
        configGetter: () => withEffectiveAdvisor(boundary.configGetter()),
        configUpdater: async (body) => {
            const result = await boundary.configUpdater(body);
            return { ...result, config: withEffectiveAdvisor(result.config) };
        },
    };
}
//# sourceMappingURL=effective-advisor.js.map