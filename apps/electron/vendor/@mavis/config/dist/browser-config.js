export const BROWSER_CONFIG_DEFAULTS = {};
export function parseBrowserConfig(raw) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ...BROWSER_CONFIG_DEFAULTS };
    }
    const chromePath = Reflect.get(raw, 'chromePath');
    if (typeof chromePath !== 'string' || !chromePath.trim()) {
        return { ...BROWSER_CONFIG_DEFAULTS };
    }
    return { chromePath: chromePath.trim() };
}
//# sourceMappingURL=browser-config.js.map