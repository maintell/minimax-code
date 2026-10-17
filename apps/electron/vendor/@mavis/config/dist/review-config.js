/** 保留默认配置引用，仅将合法的用户选择标记为显式配置。 */
export function parseReviewConfig(raw, defaults) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        return defaults;
    }
    const mode = Reflect.get(raw, 'mode');
    const turnDiffCard = Reflect.get(raw, 'turnDiffCard');
    return {
        mode: mode === 'inline' || mode === 'subagent' ? mode : defaults.mode,
        turnDiffCard: turnDiffCard === 'concise' || turnDiffCard === 'standard'
            ? turnDiffCard
            : defaults.turnDiffCard,
        modeSource: mode === 'inline' || mode === 'subagent' ? 'explicit' : 'default',
    };
}
//# sourceMappingURL=review-config.js.map