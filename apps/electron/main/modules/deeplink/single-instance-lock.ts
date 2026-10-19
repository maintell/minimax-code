export function buildSingleInstanceLockKey(protocol, flags) {
    const env = flags.isDev
        ? 'dev'
        : flags.isTest
            ? 'test'
            : flags.isStaging
                ? 'staging'
                : 'prod';
    const devIdentity = flags.isDev ? flags.devIdentity?.trim() : undefined;
    return {
        protocol,
        env,
        ...(devIdentity ? { devIdentity } : {}),
    };
}
