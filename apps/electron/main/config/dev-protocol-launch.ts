/**
 * Windows URI protocol handler 只保存可执行文件和固定参数，不会继承注册它的
 * dev launcher 环境。因此在 Electron 获取单实例锁前恢复身份与 profile 所需的输入。
 */
const DEV_PROTOCOL_LAUNCH_FLAG = '--mavis-electron-dev-protocol-launch';
const DEV_PROTOCOL_ENV_ARGS = {
    NEXT_PUBLIC_BUILD_ENV: '--mavis-build-env',
    NEXT_PUBLIC_LOCALE: '--mavis-locale',
    NODE_ENV: '--mavis-node-env',
    MAVIS_DATA_DIR: '--mavis-data-dir',
    MAVIS_DEV_USE_GIT_PROFILE: '--mavis-use-git-profile',
    MAVIS_ELECTRON_DEV_APP_ID: '--mavis-dev-app-id',
    MAVIS_ELECTRON_DEV_APP_NAME: '--mavis-dev-app-name',
    MAVIS_ELECTRON_DEV_DISPLAY_NAME: '--mavis-dev-display-name',
    MAVIS_ELECTRON_DEV_LABEL: '--mavis-dev-label',
    MAVIS_ELECTRON_DEV_USER_DATA_DIR: '--mavis-dev-user-data-dir',
    MAVIS_ELECTRON_DEV_PORT: '--mavis-dev-port',
};
export function buildDevProtocolLaunchArgs(env) {
    const args = [DEV_PROTOCOL_LAUNCH_FLAG];
    for (const [envName, flag] of Object.entries(DEV_PROTOCOL_ENV_ARGS)) {
        const value = env[envName]?.trim();
        if (value)
            args.push(`${flag}=${value}`);
    }
    return args;
}
export function applyDevProtocolLaunchArgs(argv = process.argv, env = process.env, isDefaultApp = process.defaultApp, platform = process.platform) {
    if (platform !== 'win32' || !isDefaultApp || !argv.includes(DEV_PROTOCOL_LAUNCH_FLAG))
        return false;
    for (const [envName, flag] of Object.entries(DEV_PROTOCOL_ENV_ARGS)) {
        const prefix = `${flag}=`;
        const value = argv
            .find((arg) => arg.startsWith(prefix))
            ?.slice(prefix.length)
            .trim();
        if (value)
            env[envName] = value;
    }
    return true;
}
