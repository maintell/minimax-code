import { readEnvSwitch } from './browser-beta-flags.js';
export const BROWSER_CONFIG_DEFAULTS = {};
export function parseBrowserConfig(raw) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ...BROWSER_CONFIG_DEFAULTS };
    }
    const chromePath = Reflect.get(raw, 'chromePath');
    const headless = Reflect.get(raw, 'headless');
    const screenshot = Reflect.get(raw, 'screenshot');
    const ptcAuto = screenshot !== null && typeof screenshot === 'object'
        ? Reflect.get(screenshot, 'ptcAuto')
        : undefined;
    const compactInspect = Reflect.get(raw, 'compactInspect');
    return {
        ...BROWSER_CONFIG_DEFAULTS,
        ...(typeof chromePath === 'string' && chromePath.trim()
            ? { chromePath: chromePath.trim() }
            : {}),
        ...(typeof headless === 'boolean' ? { headless } : {}),
        ...(typeof ptcAuto === 'boolean' ? { screenshot: { ptcAuto } } : {}),
        ...(typeof compactInspect === 'boolean' ? { compactInspect } : {}),
    };
}
/**
 * `browser.compactInspect`: compact `inspect`/semantic `query` text for the
 * model plus the short Browser description and builtin Skill. On unless
 * config.yaml says `browser.compactInspect: false`; a set
 * `ARCHON_BROWSER_COMPACT_INSPECT` wins over config.yaml (`1`/`true`/`on`
 * enables, `0`/`false`/`off` disables; any other value keeps config.yaml).
 */
export function resolveBrowserCompactInspect(configured, env = process.env) {
    return readEnvSwitch(env, 'ARCHON_BROWSER_COMPACT_INSPECT') ?? configured !== false;
}
//# sourceMappingURL=browser-config.js.map