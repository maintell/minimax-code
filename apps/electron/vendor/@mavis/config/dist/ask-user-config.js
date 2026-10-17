export const ASK_USER_CONFIG_DEFAULTS = {
    enabled: true,
};
export function parseAskUserConfig(raw, defaults = ASK_USER_CONFIG_DEFAULTS) {
    const rawAskUser = raw.askUser;
    if (rawAskUser == null || typeof rawAskUser !== 'object' || Array.isArray(rawAskUser)) {
        return { ...defaults };
    }
    const obj = rawAskUser;
    return {
        enabled: typeof obj.enabled === 'boolean' ? obj.enabled : defaults.enabled,
    };
}
//# sourceMappingURL=ask-user-config.js.map