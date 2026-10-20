/**
 * Desktop appearance configuration contract.
 *
 * Appearance preferences (theme pack, wallpaper selection, density, font
 * family/weight, custom colors) are user configuration, so they live in the
 * main-process desktop config — never in renderer localStorage. Renderers read
 * a synchronous snapshot before first paint and subscribe to committed
 * changes, which keeps every window in sync. A future Web implementation is
 * expected to provide the same snapshot/commit port against its own config
 * backend instead of introducing renderer-local persistence.
 *
 * Font sizing is intentionally NOT part of this state: it stays on the
 * flat desktop-typography fields (see ./desktop-typography.ts) because that
 * chain owns pre-paint application and build-time px mapping. Both slices are
 * broadcast together as one appearance snapshot.
 */
export function getChatContentWidthPercent(value) {
    if (value === 'full')
        return 100;
    return clampNumber(value, 0, 0, 100);
}
export const DEFAULT_THEME_PACK_ID = 'mcode-default';
const EMPTY_COLORS = {
    accent: null,
    background: null,
    foreground: null,
};
export const DEFAULT_APPEARANCE_PREFERENCES = {
    uiFontFamily: 'theme',
    codeFontFamily: 'theme',
    uiFontWeight: 'theme',
    codeFontWeight: 'theme',
    density: 'comfortable',
    chatContentWidth: 'standard',
    contrast: 50,
    colors: {
        light: { ...EMPTY_COLORS },
        dark: { ...EMPTY_COLORS },
    },
};
export const DEFAULT_DESKTOP_APPEARANCE_STATE = {
    themeMode: 'system',
    themePackId: DEFAULT_THEME_PACK_ID,
    visualThemeSource: 'pack',
    preferences: DEFAULT_APPEARANCE_PREFERENCES,
    wallpaperProfile: null,
};
const UI_FONT_FAMILIES = new Set([
    'theme',
    'system',
    'humanist',
    'editorial',
]);
const CODE_FONT_FAMILIES = new Set([
    'theme',
    'system-mono',
    'menlo',
    'jetbrains-mono',
]);
const FONT_WEIGHTS = new Set(['theme', 400, 500, 600, 700]);
const DENSITIES = new Set(['compact', 'comfortable', 'airy']);
const CHAT_CONTENT_WIDTHS = new Set(['standard', 'full']);
const SAFE_COLOR = /^#[0-9a-f]{6}$/i;
const MAX_THEME_PACK_ID_LENGTH = 80;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function clampNumber(value, fallback, min, max) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, Math.round(value)))
        : fallback;
}
export function normalizeAppearanceColor(value) {
    if (value === null || value === undefined || value === '')
        return null;
    if (typeof value !== 'string' || !SAFE_COLOR.test(value))
        return null;
    return value.toUpperCase();
}
function parseColorOverrides(value) {
    if (!isRecord(value))
        return { ...EMPTY_COLORS };
    return {
        accent: normalizeAppearanceColor(value.accent),
        background: normalizeAppearanceColor(value.background),
        foreground: normalizeAppearanceColor(value.foreground),
        ...(typeof value.accentPreset === 'string' &&
            ['blue', 'cyan', 'green', 'yellow', 'orange', 'purple'].includes(value.accentPreset)
            ? { accentPreset: value.accentPreset }
            : {}),
    };
}
export function normalizeAppearancePreferences(value) {
    if (!isRecord(value))
        return structuredClone(DEFAULT_APPEARANCE_PREFERENCES);
    const colors = isRecord(value.colors) ? value.colors : {};
    return {
        uiFontFamily: UI_FONT_FAMILIES.has(value.uiFontFamily)
            ? value.uiFontFamily
            : DEFAULT_APPEARANCE_PREFERENCES.uiFontFamily,
        codeFontFamily: CODE_FONT_FAMILIES.has(value.codeFontFamily)
            ? value.codeFontFamily
            : DEFAULT_APPEARANCE_PREFERENCES.codeFontFamily,
        uiFontWeight: FONT_WEIGHTS.has(value.uiFontWeight)
            ? value.uiFontWeight
            : DEFAULT_APPEARANCE_PREFERENCES.uiFontWeight,
        codeFontWeight: FONT_WEIGHTS.has(value.codeFontWeight)
            ? value.codeFontWeight
            : DEFAULT_APPEARANCE_PREFERENCES.codeFontWeight,
        // Legacy "theme" values migrate to the independent default density.
        density: DENSITIES.has(value.density)
            ? value.density
            : DEFAULT_APPEARANCE_PREFERENCES.density,
        chatContentWidth: CHAT_CONTENT_WIDTHS.has(value.chatContentWidth)
            ? value.chatContentWidth
            : typeof value.chatContentWidth === 'number' && Number.isFinite(value.chatContentWidth)
                ? getChatContentWidthPercent(value.chatContentWidth)
                : DEFAULT_APPEARANCE_PREFERENCES.chatContentWidth,
        contrast: clampNumber(value.contrast, DEFAULT_APPEARANCE_PREFERENCES.contrast, 0, 100),
        colors: {
            light: parseColorOverrides(colors.light),
            dark: parseColorOverrides(colors.dark),
        },
    };
}
function normalizeWallpaperProfile(value) {
    if (!isRecord(value))
        return null;
    if (typeof value.schemaVersion !== 'number' || typeof value.assetId !== 'string')
        return null;
    if (value.assetId.length === 0 || value.assetId.length > 200)
        return null;
    return value;
}
export function normalizeDesktopAppearanceState(value) {
    if (!isRecord(value))
        return structuredClone(DEFAULT_DESKTOP_APPEARANCE_STATE);
    const themePackId = typeof value.themePackId === 'string' &&
        value.themePackId.length > 0 &&
        value.themePackId.length <= MAX_THEME_PACK_ID_LENGTH
        ? value.themePackId
        : DEFAULT_THEME_PACK_ID;
    const wallpaperProfile = normalizeWallpaperProfile(value.wallpaperProfile);
    return {
        themeMode: value.themeMode === 'light' || value.themeMode === 'dark' ? value.themeMode : 'system',
        themePackId,
        // Wallpaper mode without a stored profile cannot render; fall back to pack.
        visualThemeSource: value.visualThemeSource === 'wallpaper' && wallpaperProfile ? 'wallpaper' : 'pack',
        preferences: normalizeAppearancePreferences(value.preferences),
        wallpaperProfile,
    };
}
export function desktopAppearanceStatesEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
export const DESKTOP_WINDOW_KIND_ARGUMENT_PREFIX = '--mavis-desktop-window-kind=';
export const DESKTOP_APPEARANCE_CAPABILITY_ARGUMENT_PREFIX = '--mavis-desktop-appearance=';
//# sourceMappingURL=desktop-appearance.js.map