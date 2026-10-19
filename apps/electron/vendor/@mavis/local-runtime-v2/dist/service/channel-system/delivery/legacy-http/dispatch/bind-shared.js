import { json, readFirstString } from '../http-helpers.js';
export function readAgentName(body) {
    return readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']) ?? 'mavis';
}
export function isNonFeishuPlatformBody(body) {
    const platform = readFirstString(body, ['platform']);
    if (platform === 'telegram' || platform === 'wechat')
        return true;
    const name = readFirstString(body, ['name', 'clientId', 'client_id']);
    return name?.startsWith('telegram:') === true || name?.startsWith('wechat:') === true;
}
export function isFeishuConnectBody(body) {
    if (isNonFeishuPlatformBody(body))
        return false;
    const name = readFirstString(body, ['name', 'platform', 'clientId', 'client_id']);
    return name === 'feishu' || name?.startsWith('feishu:') === true || hasFeishuCredentials(body);
}
function hasFeishuCredentials(body) {
    return Boolean(readFirstString(body, ['appId', 'app_id']) &&
        readFirstString(body, ['appSecret', 'app_secret']));
}
export function localRunnerUnavailable() {
    return json({
        ok: false,
        error: 'Local channel platform runner is not implemented in G6 channel infra.',
        code: 'LOCAL_CHANNEL_RUNNER_UNAVAILABLE',
        localRuntime: true,
    }, { status: 200 });
}
//# sourceMappingURL=bind-shared.js.map