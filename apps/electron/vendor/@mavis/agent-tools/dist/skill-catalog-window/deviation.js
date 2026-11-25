import { normalizeSkillUsageKey, skillCatalogDescription, } from '@mavis/context-manager';
import { noticeDue } from '../mcp-disclosure/window-notice.js';
/**
 * Skills by normalized name; of names that normalize alike, the first by name
 * wins. The signature is the description as catalog lines and updates show it
 * (protected Skills whole, others capped): an edit past the cap, or a
 * builtin-tier flip, changes nothing the model sees, so it is no change to announce.
 */
export function skillSnapshot(entries) {
    const snapshot = new Map();
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
        const key = normalizeSkillUsageKey(entry.name);
        if (!snapshot.has(key)) {
            snapshot.set(key, { entry, signature: skillCatalogDescription(entry) });
        }
    }
    return snapshot;
}
/**
 * How the live Skills differ from the frozen catalog. Skills an update
 * announced as added in this window count as known: gone, they are removed.
 */
export function skillDeviation(frozen, live, addedInWindow) {
    const deviation = new Map();
    for (const [key, { entry, signature }] of live) {
        const shown = frozen.get(key);
        if (!shown)
            deviation.set(key, { status: 'added', name: entry.name, signature });
        else if (shown.signature !== signature) {
            deviation.set(key, { status: 'changed', name: entry.name, signature });
        }
    }
    for (const [key, shown] of frozen) {
        if (!live.has(key))
            deviation.set(key, { status: 'removed', name: shown.entry.name });
    }
    for (const [key, name] of addedInWindow) {
        if (!live.has(key) && !frozen.has(key))
            deviation.set(key, { status: 'removed', name });
    }
    return deviation;
}
/**
 * The update this Turn's user message carries, if any: when the deviation
 * differs from the last told one, or when what was told is unknown and there is
 * a deviation to state or an earlier update to supersede. `changedInWindow` is
 * given only when the window continues; without it the window restarted, so
 * nothing can revert to a catalog the model never saw.
 */
export function skillAvailability(told, deviation, live, changedInWindow) {
    if (!noticeDue(told, deviation))
        return undefined;
    const last = told.snapshot;
    const byName = (a, b) => a.localeCompare(b);
    const entries = (status) => [...deviation]
        .flatMap(([key, entry]) => {
        const present = entry.status === status ? live.get(key)?.entry : undefined;
        return present ? [present] : [];
    })
        .sort((a, b) => byName(a.name, b.name));
    const asShown = (key) => !deviation.has(key) && live.has(key);
    const nameOf = (key) => live.get(key)?.entry.name ?? key;
    const restored = changedInWindow
        ? ['removed']
        : ['removed', 'changed'];
    return {
        deviation,
        added: entries('added'),
        changed: entries('changed'),
        removed: [...deviation.values()]
            .flatMap((entry) => (entry.status === 'removed' ? [entry.name] : []))
            .sort(byName),
        availableAgain: [...(last ?? [])]
            .flatMap(([key, entry]) => restored.includes(entry.status) && asShown(key) ? [nameOf(key)] : [])
            .sort(byName),
        // Only Skills the last known update listed as changed: one it listed as
        // removed and that is back is available again, not reverted.
        reverted: [...(changedInWindow ?? [])]
            .filter((key) => asShown(key) && (last === undefined || last.get(key)?.status === 'changed'))
            .map(nameOf)
            .sort(byName),
    };
}
//# sourceMappingURL=deviation.js.map