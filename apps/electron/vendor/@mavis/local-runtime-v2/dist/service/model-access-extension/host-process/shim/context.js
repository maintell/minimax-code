export function captureHostContext(value, code = 'host_context_invalid') {
    const invalid = () => {
        throw Object.assign(new Error(code), { code });
    };
    if (!value || typeof value !== 'object')
        invalid();
    const input = value;
    const text = (item, maximum = 256) => {
        if (typeof item !== 'string' || !item || item.length > maximum)
            invalid();
        return item;
    };
    const integer = (item, minimum) => {
        if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < minimum)
            invalid();
        return item;
    };
    const targets = input.enabledTargets;
    if (!Array.isArray(targets) || targets.length > 128)
        return invalid();
    return {
        profileId: text(input.profileId),
        installationId: text(input.installationId),
        operationId: text(input.operationId),
        dataDir: text(input.dataDir, 8192),
        hostDataDir: text(input.hostDataDir, 8192),
        generation: integer(input.generation, 1),
        policyRevision: integer(input.policyRevision, 0),
        enabledTargets: targets.map((target) => text(target)),
        ...(input.sessionKey === undefined
            ? {}
            : {
                sessionKey: typeof input.sessionKey === 'string' && /^[0-9a-f]{16,64}$/u.test(input.sessionKey)
                    ? input.sessionKey
                    : invalid(),
            }),
    };
}
//# sourceMappingURL=context.js.map