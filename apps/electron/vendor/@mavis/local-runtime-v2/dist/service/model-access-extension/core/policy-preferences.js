const CAPS = ['login', 'subscriptionBorrow', 'apiKeyScan'];
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
function record(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('invalid_policy');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length ||
        keys.some((key) => typeof key !== 'string' || !fields.includes(key) || !('value' in descriptors[key])))
        throw new Error('invalid_policy');
    return value;
}
function identifier(value) {
    if (typeof value !== 'string' || !IDENTIFIER.test(value))
        throw new Error('invalid_policy');
    return value;
}
function enabled(value) {
    if (typeof value !== 'boolean')
        throw new Error('invalid_policy');
    return value;
}
export function capabilityTargetKey(target) {
    return JSON.stringify([
        target.installationId,
        target.sourceId,
        target.capability,
        target.entryId,
        target.target,
    ]);
}
/** Unknown targets may be retained for disabled packages, but never become supported by preference. */
export function parseModelAccessPolicyPreferences(value, profileId) {
    const fields = ['schemaVersion', 'profileId', 'globals', 'targets'];
    if (value && typeof value === 'object' && Object.hasOwn(value, 'subscriptionsEnabled'))
        fields.push('subscriptionsEnabled');
    const root = record(value, fields);
    const subscriptionsEnabled = root.subscriptionsEnabled === undefined ? undefined : enabled(root.subscriptionsEnabled);
    if (root.schemaVersion !== 1 || root.profileId !== profileId)
        throw new Error('invalid_policy');
    const globals = record(root.globals, CAPS);
    if (!Array.isArray(root.targets) || root.targets.length > 8192)
        throw new Error('invalid_policy');
    const seen = new Set();
    const targets = Array.from(root.targets, (targetValue) => {
        const item = record(targetValue, [
            'installationId',
            'sourceId',
            'capability',
            'entryId',
            'target',
            'enabled',
        ]);
        const capability = item.capability;
        if (!CAPS.includes(capability))
            throw new Error('invalid_policy');
        const target = Object.freeze({
            installationId: identifier(item.installationId),
            sourceId: identifier(item.sourceId),
            capability,
            entryId: identifier(item.entryId),
            target: identifier(item.target),
            enabled: enabled(item.enabled),
        });
        const key = capabilityTargetKey(target);
        if (seen.has(key))
            throw new Error('invalid_policy');
        seen.add(key);
        return target;
    });
    return Object.freeze({
        schemaVersion: 1,
        profileId,
        ...(subscriptionsEnabled === undefined ? {} : { subscriptionsEnabled }),
        globals: Object.freeze({
            login: enabled(globals.login),
            subscriptionBorrow: enabled(globals.subscriptionBorrow),
            apiKeyScan: enabled(globals.apiKeyScan),
        }),
        targets: Object.freeze(targets),
    });
}
//# sourceMappingURL=policy-preferences.js.map