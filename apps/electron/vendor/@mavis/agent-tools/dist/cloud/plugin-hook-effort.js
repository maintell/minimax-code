import { pluginHookEffort } from '@mavis/plugin-hooks';
import { ThinkingLevel } from '@mavis/protocol';
/** Resolve Cloud's authoritative per-turn ModelRef into Compatible Hook effort. */
export function cloudPluginHookEffort(model) {
    const level = model?.thinking_level;
    switch (level) {
        case ThinkingLevel.LOW:
            return pluginHookEffort('low');
        case ThinkingLevel.MEDIUM:
            return pluginHookEffort('medium');
        case ThinkingLevel.HIGH:
            return pluginHookEffort('high');
        case ThinkingLevel.XHIGH:
            return pluginHookEffort('xhigh');
        default:
            // OFF is inactive; MINIMAL is not a documented Compatible effort level.
            return undefined;
    }
}
//# sourceMappingURL=plugin-hook-effort.js.map