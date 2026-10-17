const COMPATIBLE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
/** Project a resolved model effort into Compatible's documented Hook shape. */
export function pluginHookEffort(level) {
    return level && COMPATIBLE_EFFORT_LEVELS.has(level)
        ? { level: level }
        : undefined;
}
//# sourceMappingURL=effort.js.map