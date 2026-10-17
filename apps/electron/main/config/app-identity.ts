export function resolveAppIdentity(flags) {
    // internal 包的后端环境是 staging，身份仍属于内部发布车道，不加 Staging 后缀。
    const isStagingIdentity = flags.isStaging && !flags.isInternalBuild;
    const envSuffix = flags.isDev
        ? ' Dev'
        : flags.isTest
            ? ' Test'
            : isStagingIdentity
                ? ' Staging'
                : '';
    const envIdSuffix = flags.isDev
        ? '.dev'
        : flags.isTest
            ? '.test'
            : isStagingIdentity
                ? '.staging'
                : '';
    const appName = flags.isZh ? `MiniMax${envSuffix}` : `MiniMax Agent${envSuffix}`;
    const appId = flags.isZh
        ? `com.minimax.agent.cn${envIdSuffix}`
        : `com.minimax.agent${envIdSuffix}`;
    return {
        appName: flags.devAppName ?? appName,
        appId: flags.devAppId ?? appId,
        userDataAppName: flags.devAppName ?? appName,
    };
}
