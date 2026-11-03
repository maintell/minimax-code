import { deployFailure } from './deploy-failure.js';
export function readPublishFailure(published) {
    const baseStatusCode = published.base_resp?.status_code ?? 0;
    const statusCode = baseStatusCode !== 0 ? baseStatusCode : (published.code ?? 0);
    if (statusCode === 0)
        return undefined;
    const statusMsg = readFailureMessage(published, baseStatusCode, statusCode);
    const errorCode = baseStatusCode === 0 ? normalizeNonEmptyString(published.error_code) : undefined;
    // 仅业务 envelope 失败时透传限额拒绝；非 record 形态由工具层继续容错。
    const entitlementDenial = baseStatusCode === 0 ? readEntitlementDenial(published.entitlement_denial) : undefined;
    return {
        base_resp: {
            status_code: statusCode,
            status_msg: statusMsg ?? `publish service returned status_code=${statusCode}`,
        },
        ...(errorCode ? { error_code: errorCode } : {}),
        ...(entitlementDenial ? { entitlement_denial: entitlementDenial } : {}),
    };
}
export function publishFailureLogFields(published, failure) {
    const baseStatusCode = published.base_resp?.status_code ?? 0;
    const statusMsg = readFailureMessage(published, baseStatusCode, failure.base_resp.status_code);
    // 只记录后端有没有提供业务真因，不落 message 正文或签名 URL。
    return {
        status_code: failure.base_resp.status_code,
        status_msg_present: Boolean(normalizeNonEmptyString(statusMsg)),
        ...(failure.error_code ? { error_code: failure.error_code } : {}),
        ...(failure.entitlement_denial ? { entitlement_denial_present: true } : {}),
    };
}
function readFailureMessage(published, baseStatusCode, statusCode) {
    if (baseStatusCode !== 0)
        return published.base_resp?.status_msg ?? published.message;
    // Mirrors IDL WebsiteManagementCode_CONTENT_REJECTED; non-zero base_resp always wins.
    return statusCode === 10 ? '网站正文未通过审核，未发布' : published.message;
}
function readEntitlementDenial(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    return value;
}
export function readPublishSuccess(published, requestedNodeId) {
    const cdnUrl = published.cdn_url ?? published.node?.cdn_url ?? '';
    const returnedNodeId = normalizeNonEmptyString(published.node_id ?? published.node?.node_id);
    if (requestedNodeId !== undefined &&
        (!returnedNodeId || returnedNodeId !== requestedNodeId || !cdnUrl)) {
        throw deployFailure('website_deploy update_archive returned an invalid success response.', 'publish_contract_failed', 'update_archive');
    }
    return {
        cdnUrl,
        nodeId: returnedNodeId ?? requestedNodeId,
        screenshotUrl: normalizeNonEmptyString(published.node?.screenshot_url),
    };
}
function normalizeNonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
//# sourceMappingURL=publish-response.js.map