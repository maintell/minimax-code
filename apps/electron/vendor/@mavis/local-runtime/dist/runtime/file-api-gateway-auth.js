import { createHash } from 'node:crypto';
/**
 * Build gateway auth exclusively from the existing local runtime user session.
 * Provider API keys and token-plan keys are intentionally not accepted here.
 */
export function resolveLocalFileApiGatewayAuth(context) {
    const accessToken = context?.accessToken?.trim();
    if (!accessToken || /[\u0000-\u001f\u007f]/u.test(accessToken))
        return undefined;
    const callerIdentity = context?.realUserID?.trim() || context?.userEmail?.trim();
    if (!callerIdentity)
        return undefined;
    return {
        gatewayHeaders: { Authorization: `Bearer ${accessToken}` },
        callerIdentityHash: sha256(`local-runtime:${callerIdentity}`),
    };
}
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
//# sourceMappingURL=file-api-gateway-auth.js.map