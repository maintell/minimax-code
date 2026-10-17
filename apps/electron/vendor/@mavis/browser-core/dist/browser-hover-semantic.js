function isCountOnly(value) {
    return Boolean(value) && /^[\s\d.,+万亿千百kKmMwW]+$/u.test(value);
}
/**
 * Resolve a bounded before/after hover observation into the public semantic effect.
 *
 * A pre-existing overlay is not promoted unless it is explicitly linked to the
 * target. This keeps an unrelated tooltip elsewhere on the page from becoming a
 * false positive while still allowing delayed hover overlays to be sampled.
 */
export function resolveBrowserHoverSemantic(before, after, fallbackText = '') {
    const target = after?.target ?? before?.target;
    const supportingText = target?.supportingText || (isCountOnly(fallbackText.trim()) ? fallbackText.trim() : '');
    if (target?.name && !isCountOnly(target.name)) {
        const source = target.source === 'text' ? 'target-text' : target.source;
        return {
            hovered: true,
            tooltipObserved: false,
            semantic: {
                name: target.name,
                source,
                confidence: source === 'aria-label' || source === 'aria-labelledby' ? 'high' : 'medium',
                supportingText,
            },
        };
    }
    const previousFingerprints = new Set((before?.nearby ?? []).map((item) => item.fingerprint));
    const candidate = (after?.nearby ?? [])
        .filter((item) => !isCountOnly(item.text) && (item.linked || !previousFingerprints.has(item.fingerprint)))
        .sort((left, right) => Number(right.linked) - Number(left.linked) ||
        Number(right.role === 'tooltip') - Number(left.role === 'tooltip') ||
        left.distance - right.distance)[0];
    if (candidate) {
        const source = candidate.linked
            ? 'aria-describedby'
            : candidate.role === 'tooltip'
                ? 'hover-tooltip'
                : 'hover-overlay';
        return {
            hovered: true,
            tooltipObserved: true,
            semantic: {
                name: candidate.text,
                source,
                confidence: candidate.linked ? 'high' : source === 'hover-tooltip' ? 'medium' : 'low',
                supportingText,
            },
        };
    }
    return {
        hovered: true,
        tooltipObserved: false,
        semantic: { name: '', source: 'none', confidence: 'low', supportingText },
    };
}
export function isHoverSemanticSnapshot(value) {
    if (!value || typeof value !== 'object')
        return false;
    const snapshot = value;
    if (!snapshot.target || typeof snapshot.target !== 'object' || !Array.isArray(snapshot.nearby)) {
        return false;
    }
    return (typeof snapshot.target.name === 'string' &&
        typeof snapshot.target.source === 'string' &&
        typeof snapshot.target.supportingText === 'string' &&
        snapshot.nearby.every((item) => Boolean(item) &&
            typeof item.fingerprint === 'string' &&
            typeof item.text === 'string' &&
            typeof item.role === 'string' &&
            typeof item.linked === 'boolean' &&
            typeof item.distance === 'number' &&
            Number.isFinite(item.distance)));
}
//# sourceMappingURL=browser-hover-semantic.js.map