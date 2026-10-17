// Figma Typography Desktop runtime stacks; preview font names are not runtime assets.
export const DESKTOP_UI_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const DESKTOP_CODE_FONT_FAMILY = 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
export const DESKTOP_TYPOGRAPHY_PRESET_ORDER = [
    'small',
    'standard',
    'large',
    'extraLarge',
];
export const DESKTOP_TYPOGRAPHY_PRESETS = {
    small: { uiBaseFontSize: 12, codeFontSize: 11 },
    standard: { uiBaseFontSize: 14, codeFontSize: 12 },
    large: { uiBaseFontSize: 15, codeFontSize: 15 },
    extraLarge: { uiBaseFontSize: 16, codeFontSize: 17 },
};
export const DEFAULT_DESKTOP_TYPOGRAPHY = {
    ...DESKTOP_TYPOGRAPHY_PRESETS.standard,
};
// Legacy numeric inputs are clamped to these bounds before being migrated to a preset.
export const UI_BASE_FONT_SIZE_RANGE = { min: 11, max: 16 };
export const CODE_FONT_SIZE_RANGE = { min: 8, max: 24 };
export const DESKTOP_TYPOGRAPHY_FONT_WEIGHTS = {
    normal: 400,
    default: 430,
    medium: 500,
    semibold: 600,
    bold: 700,
};
/** Brand display copy is fixed across UI/Code presets, unlike product headings. */
export const DESKTOP_BRAND_SLOGAN_STYLE = {
    fontSize: 28,
    lineHeight: 35,
    fontWeight: DESKTOP_TYPOGRAPHY_FONT_WEIGHTS.semibold,
    letterSpacing: 0,
};
/** Composer AI disclosure stays at a fixed caption size in every preset. */
export const DESKTOP_COMPOSER_DISCLAIMER_STYLE = {
    fontSize: 10,
    lineHeight: 14,
    fontWeight: DESKTOP_TYPOGRAPHY_FONT_WEIGHTS.default,
    letterSpacing: 0,
};
/** Main visual titles for standalone introduction and connection pages. */
const DESKTOP_PAGE_HERO_PRESET_DEFINITIONS = {
    small: [24, 30],
    standard: [28, 35],
    large: [30, 37.5],
    extraLarge: [32, 40],
};
/** Exact values published by the MCode Desktop typography variable collection. */
export const DESKTOP_TYPOGRAPHY_UI_PRESET_DEFINITIONS = {
    small: {
        assist: [10, 13.33],
        small: [11, 15.71],
        body: [12, 18],
        large: [14, 21.78],
        chatBody: [12, 19.5],
        tableFontSize: 11,
        dialogTitleSize: 17,
    },
    standard: {
        assist: [12, 16],
        small: [13, 18.57],
        body: [14, 21],
        large: [16, 24.89],
        chatBody: [14, 22.75],
        tableFontSize: 13,
        dialogTitleSize: 20,
    },
    large: {
        assist: [13, 17.33],
        small: [14, 20],
        body: [15, 22.5],
        large: [17, 26.44],
        chatBody: [15, 24.375],
        tableFontSize: 15,
        dialogTitleSize: 21,
    },
    extraLarge: {
        assist: [14, 18.67],
        small: [15, 21.43],
        body: [16, 24],
        large: [18, 28],
        chatBody: [16, 26],
        tableFontSize: 17,
        dialogTitleSize: 23,
    },
};
/** Exact values published by the MCode Desktop code typography variables. */
export const DESKTOP_TYPOGRAPHY_CODE_PRESET_DEFINITIONS = {
    small: {
        block: [11, 20],
        diff: [11, 19.8],
        terminal: [11, 13.2],
    },
    standard: {
        block: [12, 20],
        diff: [12, 21.6],
        terminal: [12, 14.4],
    },
    large: {
        block: [15, 22.5],
        diff: [15, 27],
        terminal: [15, 18],
    },
    extraLarge: {
        block: [17, 25.5],
        diff: [17, 30.6],
        terminal: [17, 20.4],
    },
};
export const DESKTOP_WINDOW_KIND_ARGUMENT_PREFIX = '--mavis-desktop-window-kind=';
export const DESKTOP_TYPOGRAPHY_CAPABILITY_ARGUMENT_PREFIX = '--mavis-desktop-typography=';
export const DESKTOP_TYPOGRAPHY_ENABLED_CLASS = 'mavis-desktop-typography-enabled';
function normalizeFontSize(value, fallback, range) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.min(range.max, Math.max(range.min, value));
}
const FONT_SIZE_RANGE_BY_SETTING = {
    uiBaseFontSize: UI_BASE_FONT_SIZE_RANGE,
    codeFontSize: CODE_FONT_SIZE_RANGE,
};
/** Resolves legacy or externally supplied values to the nearest visible settings preset. */
export function resolveDesktopTypographyPreset(settingKey, value) {
    const normalizedValue = normalizeFontSize(value, DEFAULT_DESKTOP_TYPOGRAPHY[settingKey], FONT_SIZE_RANGE_BY_SETTING[settingKey]);
    // Start from the default so values equally close to Standard keep the default preset.
    let closestPreset = 'standard';
    let closestDistance = Math.abs(DESKTOP_TYPOGRAPHY_PRESETS.standard[settingKey] - normalizedValue);
    for (const preset of DESKTOP_TYPOGRAPHY_PRESET_ORDER) {
        const distance = Math.abs(DESKTOP_TYPOGRAPHY_PRESETS[preset][settingKey] - normalizedValue);
        if (distance < closestDistance) {
            closestPreset = preset;
            closestDistance = distance;
        }
    }
    return closestPreset;
}
export function normalizeDesktopTypographySnapshot(value) {
    const candidate = value && typeof value === 'object' ? value : {};
    const uiPreset = resolveDesktopTypographyPreset('uiBaseFontSize', candidate.uiBaseFontSize);
    const codePreset = resolveDesktopTypographyPreset('codeFontSize', candidate.codeFontSize);
    return {
        uiBaseFontSize: DESKTOP_TYPOGRAPHY_PRESETS[uiPreset].uiBaseFontSize,
        codeFontSize: DESKTOP_TYPOGRAPHY_PRESETS[codePreset].codeFontSize,
    };
}
function style(fontSize, lineHeight, fontWeight, letterSpacing = 0) {
    return { fontSize, lineHeight, fontWeight, letterSpacing };
}
/**
 * The only semantic Desktop typography computation entry. Consumers adapt this
 * scene to CSS variables, Tailwind, Ant Design, or component runtime options.
 */
export function getDesktopTypographyScene(value) {
    const snapshot = normalizeDesktopTypographySnapshot(value);
    const uiPreset = resolveDesktopTypographyPreset('uiBaseFontSize', snapshot.uiBaseFontSize);
    const codePreset = resolveDesktopTypographyPreset('codeFontSize', snapshot.codeFontSize);
    const definition = DESKTOP_TYPOGRAPHY_UI_PRESET_DEFINITIONS[uiPreset];
    const codeDefinition = DESKTOP_TYPOGRAPHY_CODE_PRESET_DEFINITIONS[codePreset];
    const weights = DESKTOP_TYPOGRAPHY_FONT_WEIGHTS;
    const heroTitle = DESKTOP_PAGE_HERO_PRESET_DEFINITIONS[uiPreset];
    const ui = {
        assist: style(definition.assist[0], definition.assist[1], weights.default),
        small: style(definition.small[0], definition.small[1], weights.default),
        body: style(definition.body[0], definition.body[1], weights.default),
        large: style(definition.large[0], definition.large[1], weights.default),
        heroTitle: style(heroTitle[0], heroTitle[1], weights.semibold),
    };
    const chatBody = style(definition.chatBody[0], definition.chatBody[1], weights.default);
    const spacingUnit = definition.body[0] / 4;
    const markdownBody = style(definition.body[0], definition.chatBody[1], weights.default);
    // Figma markdown/table/font size follows the UI mode, independently of code size.
    const tableFontSize = definition.tableFontSize;
    return {
        preset: { ui: uiPreset, code: codePreset },
        weights,
        ui,
        chat: { body: chatBody },
        markdown: {
            spacingUnit,
            spacing: {
                1: spacingUnit,
                2: spacingUnit * 2,
                3: spacingUnit * 3,
                4: spacingUnit * 4,
                5: spacingUnit * 5,
                6: spacingUnit * 6,
                7: spacingUnit * 7,
            },
            h1: style(spacingUnit * 6, spacingUnit * 8, weights.semibold),
            h2: style(spacingUnit * 5, spacingUnit * 7, weights.semibold),
            h3: style(spacingUnit * 4.5, spacingUnit * 7, weights.semibold),
            h4: style(definition.body[0], definition.body[1], weights.semibold),
            h5: style(definition.body[0], definition.chatBody[1], weights.semibold),
            h6: style(definition.body[0], definition.chatBody[1], weights.semibold),
            body: markdownBody,
            tableHeader: style(tableFontSize, definition.chatBody[0], weights.semibold),
            tableCell: style(tableFontSize, definition.chatBody[1], weights.default),
        },
        dialog: {
            titleMedium: style(definition.dialogTitleSize, 28, weights.medium, -0.36),
            titleSemibold: style(definition.dialogTitleSize, 28, weights.semibold, -0.36),
        },
        code: {
            // Inline code scales with its surrounding text, independently of the Code preset.
            inlineFontScale: 0.92,
            block: style(codeDefinition.block[0], codeDefinition.block[1], weights.normal),
            diff: style(codeDefinition.diff[0], codeDefinition.diff[1], weights.normal),
            terminal: style(codeDefinition.terminal[0], codeDefinition.terminal[1], weights.normal),
        },
        // Product-specific copy remains on the Large semantic size.
        remoteGoal: { fontSize: definition.large[0] },
    };
}
/** Complete text roles, shared by CSS utilities and component adapters.
 * A role owns all four axes; UI Strong is Medium, not Markdown Semibold.
 * Font families deliberately remain owned by the existing renderers.
 */
export function getDesktopTypographyTextStyles(value) {
    const scene = getDesktopTypographyScene(value);
    const strong = (base, fontWeight) => ({
        ...base,
        fontWeight,
    });
    return {
        'brand-slogan': DESKTOP_BRAND_SLOGAN_STYLE,
        'composer-disclaimer': DESKTOP_COMPOSER_DISCLAIMER_STYLE,
        'page-hero': scene.ui.heroTitle,
        'ui-assist': scene.ui.assist,
        'ui-assist-strong': strong(scene.ui.assist, scene.weights.medium),
        'ui-small': scene.ui.small,
        'ui-small-strong': strong(scene.ui.small, scene.weights.medium),
        'ui-body': scene.ui.body,
        // Regular button labels use the design system's Base 14/20 metrics.
        'ui-button': {
            ...scene.ui.body,
            lineHeight: Math.round(((scene.ui.body.fontSize * 20) / 14) * 100) / 100,
            fontWeight: scene.weights.normal,
        },
        'ui-button-strong': {
            ...scene.ui.body,
            lineHeight: Math.round(((scene.ui.body.fontSize * 20) / 14) * 100) / 100,
            fontWeight: scene.weights.medium,
        },
        'empty-state-title': {
            ...scene.ui.large,
            lineHeight: Math.round(((scene.ui.large.fontSize * 26) / 16) * 100) / 100,
            fontWeight: scene.weights.semibold,
        },
        'empty-state-description': {
            ...scene.ui.body,
            lineHeight: Math.round(((scene.ui.body.fontSize * 20) / 14) * 100) / 100,
            fontWeight: scene.weights.normal,
        },
        // Inline tags share the body weight while retaining their 14/20 layout,
        // scaled by the UI preference without changing the surrounding chat leading.
        'input-tag': {
            ...scene.ui.body,
            lineHeight: Math.round(((scene.ui.body.fontSize * 20) / 14) * 100) / 100,
            fontWeight: scene.chat.body.fontWeight,
        },
        'ui-body-strong': strong(scene.ui.body, scene.weights.medium),
        'ui-large': scene.ui.large,
        'ui-large-strong': strong(scene.ui.large, scene.weights.medium),
        'chat-body': scene.chat.body,
        'chat-body-strong': strong(scene.chat.body, scene.weights.semibold),
        'markdown-body': scene.markdown.body,
        'markdown-h1': scene.markdown.h1,
        'markdown-h2': scene.markdown.h2,
        'markdown-h3': scene.markdown.h3,
        'markdown-h4': scene.markdown.h4,
        'markdown-h5': scene.markdown.h5,
        'markdown-h6': scene.markdown.h6,
        'markdown-table-header': scene.markdown.tableHeader,
        'markdown-table-cell': scene.markdown.tableCell,
        'dialog-medium': scene.dialog.titleMedium,
        'dialog-semibold': scene.dialog.titleSemibold,
        'code-block': scene.code.block,
        'code-diff': scene.code.diff,
        'code-terminal': scene.code.terminal,
    };
}
/** Maps legacy fixed UI pixels through the selected exact Desktop body scale. */
export function mapDesktopUiPixelSize(defaultFontSize, value) {
    const scene = getDesktopTypographyScene(value);
    const standardBodySize = DESKTOP_TYPOGRAPHY_UI_PRESET_DEFINITIONS.standard.body[0];
    return Math.round((defaultFontSize * scene.ui.body.fontSize) / standardBodySize);
}
//# sourceMappingURL=desktop-typography.js.map