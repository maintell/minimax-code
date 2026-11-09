import { REMOTE_ACCESS_CAPABILITIES, } from './catalog.js';
import { cachedModelAccessIcon } from './icons.js';
function presentation(root, id, entry) {
    const iconPath = cachedModelAccessIcon(root, entry.icon);
    const darkIconPath = cachedModelAccessIcon(root, entry.darkIcon);
    const entries = 'entries' in entry && entry.entries ? Object.entries(entry.entries) : [];
    return {
        id,
        ...(entry.displayName ? { displayName: entry.displayName } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.order !== undefined ? { order: entry.order } : {}),
        // Only verified local cache paths; an icon still downloading falls back to built-in logos.
        ...(iconPath ? { iconPath } : {}),
        ...(darkIconPath ? { darkIconPath } : {}),
        ...(entries.length
            ? {
                entries: entries.map(([entryKey, value]) => ({
                    entryKey,
                    displayName: value.displayName,
                    ...(value.order !== undefined ? { order: value.order } : {}),
                })),
            }
            : {}),
    };
}
/** Rules of each source: whole capabilities, then single entries (`<capability>/<entry>/...`). */
function sourceRules(policy, packageName) {
    const scope = packageName ? { packageName } : {};
    return Object.entries(policy).flatMap(([sourceId, rules]) => [
        ...REMOTE_ACCESS_CAPABILITIES.filter((capability) => rules[capability]).map((capability) => ({
            capability,
            sourceId,
            ...scope,
        })),
        ...Object.keys(rules.entries ?? {}).map((entryKey) => ({
            capability: entryKey.split('/')[0],
            sourceId,
            entryKey,
            ...scope,
        })),
    ]);
}
function capabilityRulesOf(catalog) {
    if (!catalog)
        return [];
    return [
        ...REMOTE_ACCESS_CAPABILITIES.filter((capability) => catalog.capabilityPolicy[capability]).map((capability) => ({ capability })),
        ...sourceRules(catalog.sourcePolicy),
        ...Object.entries(catalog.packagePolicy ?? {}).flatMap(([packageName, scoped]) => sourceRules(scoped.sourcePolicy, packageName)),
    ];
}
function providerRulesOf(catalog) {
    if (!catalog)
        return [];
    return [
        ...Object.keys(catalog.providerPolicy).map((providerId) => ({ providerId })),
        ...Object.entries(catalog.packagePolicy ?? {}).flatMap(([packageName, scoped]) => Object.keys(scoped.providerPolicy).map((providerId) => ({ providerId, packageName }))),
    ];
}
function presentationsOf(root, entries) {
    return Object.entries(entries ?? {}).map(([id, entry]) => presentation(root, id, entry));
}
/** Delivery bookkeeping the UI shows, present fields only. */
function statusFields(status) {
    return {
        ...(status.environment ? { environment: status.environment } : {}),
        ...(status.sequence !== undefined ? { sequence: status.sequence } : {}),
        ...(status.lastSuccessAt !== undefined ? { lastSuccessAtMs: status.lastSuccessAt } : {}),
        ...(status.lastErrorCode ? { lastErrorCode: status.lastErrorCode } : {}),
        ...(status.nextRetryAt !== undefined ? { nextRetryAtMs: status.nextRetryAt } : {}),
    };
}
/**
 * Rules and presentation are empty unless delivery is on and the server master switch is on;
 * with the master switch off the UI hides model access as a whole.
 */
export function modelAccessRemoteView(input) {
    const { status } = input;
    const catalog = status.enabled && !input.serviceDisabled ? input.catalog : undefined;
    return {
        enabled: status.enabled,
        // Off only on an explicit server answer; unknown (never synced) counts as on.
        serviceEnabled: !(status.enabled && input.serviceDisabled),
        switchSource: status.switchSource,
        ...statusFields(status),
        capabilityRules: capabilityRulesOf(catalog),
        providerRules: providerRulesOf(catalog),
        providers: presentationsOf(input.root, catalog?.presentation.providers),
        sources: presentationsOf(input.root, catalog?.presentation.sources),
    };
}
//# sourceMappingURL=remote-view.js.map