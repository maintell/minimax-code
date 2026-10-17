/**
 * 桌面端错误批次的 Matrix Gateway 客户端。
 *
 * 传输要求（方案 §4）：登录方式与 local-runtime 现有 managed-cloud 调用保持一致，
 * 包括 content-safety `/mavis/api/v1/content` 与 skill-hub
 * `/minimax-cloud/api/v1/skill-hub` 的 connectors 路径：
 *
 * - POST `/minimax-cloud/api/v1/observability/desktop-errors/batch`
 * - 与其他 Shared OAuth managed cloud 调用一样，access token 放入
 *   `Authorization: Bearer` 请求头，不放入查询参数；真实用户 ID 放入 `user_id` 查询参数。
 *   token 不进入 URL，避免 Gateway、Ingress 或代理的访问日志记录它。方案的 Thrift
 *   草稿曾把 `token` 设计为查询参数，但当前要求改为遵循 connectors 方式。
 * - managed backend 路由请求头与其他调用保持一致，确保各环境请求落到正确后端。
 * - 只允许 HTTPS，并限制请求超时。
 * - 登录态缺失、传输错误、超时或非 2xx 响应均丢弃当前批次，只记录不含 token 的
 *   warn 日志。错误上报不得产生新的错误事件，也不得阻塞调用方。
 *
 * 每条事件的 `event_log` 到达本客户端前必须已经加密（见 ./crypto.ts）；本客户端
 * 不检查或脱敏事件内容。
 */
import { getRuntimeBuildEnv, getRuntimeRegion, } from '@mavis/config';
import { logger } from '../common/logger.js';
import { managedBackendRoutingHeaders, } from '../runtime/routing-headers.js';
/** 单次请求超时上限，与其他 managed cloud 调用保持一致。 */
const DESKTOP_ERROR_BATCH_TIMEOUT_MS = 10_000;
/** 当前要求指定的固定 API 路径，拼接在 region host 之后。 */
const DESKTOP_ERROR_BATCH_PATH = '/minimax-cloud/api/v1/observability/desktop-errors/batch';
/**
 * region/build env 到 Matrix host 的映射，与 Electron、content-safety 和
 * local-runtime 的 managed Matrix 环境保持一致。
 */
const DESKTOP_ERROR_API_HOST = {
    cn: {
        dev: 'https://matrix-test.xaminim.com',
        test: 'https://matrix-test.xaminim.com',
        staging: 'https://matrix-pre.xaminim.com',
        prod: 'https://agent.minimax.cn',
    },
    en: {
        dev: 'https://matrix-overseas-test.xaminim.com',
        test: 'https://matrix-overseas-test.xaminim.com',
        staging: 'https://matrix-overseas-pre.xaminim.com',
        prod: 'https://agent.minimax.io',
    },
};
/**
 * 向 Gateway POST 一批加密事件。函数不抛错，也不返回需要调用方处理的值；整条链路
 * 故障不影响主流程。登录态不完整时直接返回并丢弃该批次。
 */
export async function sendDesktopErrorBatch(params) {
    if (params.events.length === 0)
        return;
    // 当前批次使用最新登录态。同一个 token 同时用于请求认证和上游派生 event_log 密钥，
    // 因此批次之间刷新 token 不会导致 Gateway 无法解密。
    const accessToken = params.authContext?.accessToken?.trim();
    const realUserID = params.authContext?.realUserID?.trim();
    if (!accessToken || !realUserID) {
        // 登录态不完整时按方案 §4.1 丢弃批次；为避免泄漏部分认证材料，此处不记录内容。
        return;
    }
    const region = (params.region ?? getRuntimeRegion)();
    const buildEnv = (params.buildEnv ?? getRuntimeBuildEnv)();
    const requestUrl = new URL(`${DESKTOP_ERROR_API_HOST[region][buildEnv]}${DESKTOP_ERROR_BATCH_PATH}`);
    // Matrix API 公共参数 `user_id` 携带 uid，token 只放在请求头中。
    requestUrl.searchParams.set('user_id', realUserID);
    // 只允许 HTTPS，拒绝通过明文连接发送登录态。
    if (requestUrl.protocol !== 'https:')
        return;
    try {
        const response = await params.fetchImpl(requestUrl, {
            method: 'POST',
            headers: {
                'User-Agent': 'MiniMaxAgent',
                'Content-Type': 'application/json',
                // Shared OAuth 凭证请求头，与 model-resolver、content-safety 保持一致。
                Authorization: `Bearer ${accessToken}`,
                ...managedBackendRoutingHeaders(params.routingContext, buildEnv),
            },
            // 请求体只包含事件数组，token 与 user_id 不得出现在其中。
            body: JSON.stringify({ events: params.events }),
            signal: AbortSignal.timeout(DESKTOP_ERROR_BATCH_TIMEOUT_MS),
        });
        if (!response.ok) {
            // 任意非 2xx 响应都丢弃批次，只记录状态码，不记录 token 或 URL。
            logger.warn({ status: response.status, count: params.events.length }, '[error-reporting] desktop error batch upload rejected');
        }
    }
    catch (error) {
        // 传输错误或超时：丢弃当前批次，不影响主流程。
        logger.warn({
            error: error instanceof Error ? error.message : String(error),
            count: params.events.length,
        }, '[error-reporting] desktop error batch upload failed');
    }
}
//# sourceMappingURL=matrix-api-client.js.map