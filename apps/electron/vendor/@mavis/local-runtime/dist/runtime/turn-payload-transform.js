/**
 * `buildLocalTurnPayloadTransform` — 组合 local-runtime 每次 `startTurn`
 * 需要的 pi-ai `onPayload` transform 链。目前包含:
 *
 *  1. **messages-video-patcher** (only when `capabilities.support_video===true`):
 *     把 Messages payload 里 `type='image', source.media_type='video/*'`
 *     的 content block 改成 `type='video'` 后再发出去(DashScope 等
 *     Messages-compatible provider 需要这个 shape;官方 endpoint 不允许 video
 *     mime,capability 关掉时也不该出现 video)。
 *  2. **messages-file-api-patcher** (only when `support_files_api===true`):
 *     把已经进入 provider payload 的 base64 image/video block 上传并改写为文件引用。
 *  3. **openplatform-thinking-patcher** (always):按模型 capabilities /
 *     本轮 thinking level 把开平的 `thinking` 字段收敛成 variants 里的形状。
 *
 * 顺序:video → file-api → thinking。video patcher 必须先读取 base64 source
 * 的 media_type，File API 随后才把 source 改成 URL。
 *
 * 每个 patcher 各自遵守 pi-ai onPayload 合约:no-op 返回 `undefined`,
 * 返回 patched payload 表示已 mutate。本 helper 把两个链起来,任一
 * patcher 返回非 undefined 就把当前 payload 引用切到它的返回值,再喂
 * 下一个,最终返回给 pi-ai。
 */
import { buildMessagesFileApiPatcher, } from './messages-file-api-patcher.js';
import { resolveGatewayFileUploadEndpoint } from './file-api-endpoint.js';
import { buildMessagesVideoPatcher } from './messages-video-patcher.js';
import { buildOpenPlatformThinkingPatcher } from './openplatform-thinking-patcher.js';
const DEFAULT_FILE_API_REF_SCHEME = 'mm_file://';
const DEFAULT_FILE_API_TTL_SEC = 43_200;
export function buildLocalTurnPayloadTransform(agentConfig, options = {}) {
    const capabilities = agentConfig.model?.capabilities;
    const videoPatcher = capabilities?.support_video === true ? buildMessagesVideoPatcher() : undefined;
    const uploadEndpoint = resolveGatewayFileUploadEndpoint(capabilities?.files_api_upload_endpoint, options.modelBaseUrl);
    const fileApiPatcher = capabilities?.support_files_api === true &&
        uploadEndpoint &&
        options.gatewayHeaders &&
        options.callerIdentityHash &&
        options.fileApiUploadStore
        ? buildMessagesFileApiPatcher({
            uploadEndpoint,
            refScheme: capabilities.files_api_ref_scheme?.trim() || DEFAULT_FILE_API_REF_SCHEME,
            gatewayHeaders: options.gatewayHeaders,
            callerIdentityHash: options.callerIdentityHash,
            ttlSec: resolveFileApiTtlSec(capabilities.files_api_file_id_ttl_sec),
            store: options.fileApiUploadStore,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            ...(options.nowMs ? { nowMs: options.nowMs } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
        })
        : undefined;
    const thinkingPatcher = buildOpenPlatformThinkingPatcher(agentConfig.model);
    return async function patchPayload(payload, model) {
        let p = payload;
        let mutated = false;
        if (videoPatcher) {
            const v = await videoPatcher(p, model);
            if (v !== undefined) {
                p = v;
                mutated = true;
            }
        }
        if (fileApiPatcher) {
            const f = await fileApiPatcher(p, model);
            if (f !== undefined) {
                p = f;
                mutated = true;
            }
        }
        const t = await thinkingPatcher(p, model);
        if (t !== undefined) {
            p = t;
            mutated = true;
        }
        return mutated ? p : undefined;
    };
}
function resolveFileApiTtlSec(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : DEFAULT_FILE_API_TTL_SEC;
}
//# sourceMappingURL=turn-payload-transform.js.map