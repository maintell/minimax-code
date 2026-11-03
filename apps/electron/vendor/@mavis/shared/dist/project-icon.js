/** Stable persisted IDs; display names may change without invalidating saved icons. */
export const PROJECT_ICON_IDS = [
    'instruction',
    'computer',
    'attachment',
    'website',
    'education',
    'stock',
    'knowledge',
    'hermes',
    'music',
    'edit',
    'subscribe',
    'package',
    'video',
    'sheet',
    'experts',
    'web',
    'market',
    'terminal',
    'desktop',
    'presentation',
    'key',
    'memory',
    'research',
    'media',
    'analysis',
    'bot',
    'data',
    'code',
    'browser',
    'goal',
];
export const PROJECT_ICON_COLORS = [
    'neutral',
    'yellow',
    'orange',
    'green',
    'blue',
    'purple',
    'pink',
    'red',
];
/** Validate one bounded Unicode grapheme, independent of the picker's candidate list.
 * The platform font decides how it renders; we do not maintain an emoji repertoire.
 */
export function isProjectIconText(value) {
    if (typeof value !== 'string' || !value || value.length > 64)
        return false;
    if (new TextEncoder().encode(value).length > 64)
        return false;
    if (/[\p{Cc}\p{Cs}\p{Z}\uFFFD]/u.test(value) || /^[\p{M}\p{Cf}]/u.test(value))
        return false;
    for (const char of value) {
        const code = char.codePointAt(0);
        // Emoji ZWJ and tag sequences are the only permitted formatting characters.
        if (/\p{Cf}/u.test(char) && code !== 0x200d && !(code >= 0xe0020 && code <= 0xe007f))
            return false;
    }
    const segments = new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(value);
    return [...segments].length === 1;
}
export function parseProjectIcon(value) {
    if (!value || typeof value !== 'object')
        return null;
    const item = value;
    if (item.type === 'emoji' && isProjectIconText(item.emoji)) {
        return { type: 'emoji', emoji: item.emoji };
    }
    if (item.type === 'icon' &&
        PROJECT_ICON_IDS.some((id) => id === item.icon) &&
        PROJECT_ICON_COLORS.some((color) => color === item.color)) {
        return {
            type: 'icon',
            icon: item.icon,
            color: item.color,
        };
    }
    return null;
}
/** Undefined means no supported canonical value; null is an explicit reset. */
export function parseProjectIconMetadata(json) {
    try {
        const metadata = JSON.parse(json ?? '{}');
        if (!metadata || typeof metadata !== 'object' || !Object.hasOwn(metadata, 'projectIcon'))
            return undefined;
        const value = metadata.projectIcon;
        return value === null ? null : (parseProjectIcon(value) ?? undefined);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=project-icon.js.map