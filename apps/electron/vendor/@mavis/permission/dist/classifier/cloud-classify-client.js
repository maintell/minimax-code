/**
 * Cloud permission classifier — endpoint resolution + gating.
 *
 * 桌面端权限的「模型那一步」(Stage-2 LLM 判定) 在服务端跑,入口走 managed
 * `/mavis` 命名空间:`POST /mavis/api/v1/permission/check`(与内容安审
 * `/mavis/api/v1/content` 同一个 managed 网关入口)。本模块只负责两件事:
 *   - {@link getPermissionCheckApiUrl}:按 region × buildEnv 解析端点 URL,
 *     供 `HttpCloudGatewayClient` 发起实际请求。
 *   - {@link shouldUseCloudClassify}:判断当前 runtime 是否走云端判定。
 *
 * 实际的 HTTP 调用 / fail-closed 逻辑在 `../http-cloud-gateway-client.ts`。
 */
import { getRuntimeRegion, getRuntimeBuildEnv, isManagedRuntime, } from '../host-utils.js';
/**
 * permission/check 接口 base URL,按 region × buildEnv 路由。
 * 与 safety-client.ts 的 SAFETY_API_BASE 同一组 managed 网关主机(`/mavis` 同源)。
 */
const PERMISSION_API_BASE = {
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
/** 当前运行时的 permission/check 端点 URL。 */
export function getPermissionCheckApiUrl() {
    const region = getRuntimeRegion();
    const buildEnv = getRuntimeBuildEnv();
    const baseUrl = PERMISSION_API_BASE[region]?.[buildEnv];
    if (!baseUrl) {
        throw new Error(`No permission/check API base configured for region=${region} buildEnv=${buildEnv}`);
    }
    return `${baseUrl}/mavis/api/v1/permission/check`;
}
/**
 * 是否走云端判定。
 *
 * MVP:仅在 managed runtime(桌面托管端/云端化) 走服务端;非托管/纯本地 dev
 * daemon 保持原本地路径,避免影响纯 UI 开发与离线场景。
 */
export function shouldUseCloudClassify() {
    return isManagedRuntime();
}
//# sourceMappingURL=cloud-classify-client.js.map