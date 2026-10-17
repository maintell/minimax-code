import { desktopAppearanceStatesEqual, normalizeDesktopAppearanceState } from "@mavis/shared/desktop-appearance";
export { desktopAppearanceStatesEqual as appearanceStatesEqual };
export { DEFAULT_DESKTOP_APPEARANCE_STATE, desktopAppearanceStatesEqual, normalizeDesktopAppearanceState } from "@mavis/shared/desktop-appearance";

export function getDesktopAppearanceState(config) {
    return normalizeDesktopAppearanceState(config?.appearance);
}
export function mergeDesktopAppearancePatch(current, patch) {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch))
        return current;
    const partial = patch;
    return normalizeDesktopAppearanceState({
        ...current,
        ...partial,
        // Preferences merge field-wise so a single-control commit does not reset
        // sibling preferences to defaults through normalization.
        preferences: { ...current.preferences, ...(partial.preferences ?? {}) },
    });
}
const desktopAppearanceCommittedListeners = new Set();
export function onDesktopAppearanceCommitted(listener) {
    desktopAppearanceCommittedListeners.add(listener);
    return () => desktopAppearanceCommittedListeners.delete(listener);
}
export function emitDesktopAppearanceCommitted(snapshot) {
    for (const listener of desktopAppearanceCommittedListeners) {
        try {
            listener(structuredClone(snapshot));
        }
        catch (error) {
            console.warn('[DesktopAppearance] Commit listener failed:', error);
        }
    }
}
