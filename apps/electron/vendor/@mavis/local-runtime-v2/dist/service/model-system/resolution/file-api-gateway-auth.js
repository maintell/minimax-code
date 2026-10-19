import { createHash } from 'node:crypto';
import { managedBackendRoutingHeaders, } from '@mavis/agent-tools/desktop';
/** Builds File API auth only from the managed local login identity. */
export function resolveLocalFileApiGatewayAuth(context, routingContext, buildEnv = currentBuildEnv()) {
    const accessToken = context?.accessToken?.trim();
    if (!accessToken || /[\u0000-\u001f\u007f]/u.test(accessToken))
        return undefined;
    const callerIdentity = context?.realUserID?.trim() || context?.userEmail?.trim();
    if (!callerIdentity)
        return undefined;
    return {
        gatewayHeaders: {
            Authorization: `Bearer ${accessToken}`,
            ...managedBackendRoutingHeaders(routingContext, buildEnv),
        },
        callerIdentityHash: sha256(`local-runtime:${callerIdentity}`),
    };
}
function currentBuildEnv() {
    const value = process.env.MAVIS_BUILD_ENV;
    return value === 'dev' || value === 'test' || value === 'staging' || value === 'prod'
        ? value
        : undefined;
}
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
//# sourceMappingURL=file-api-gateway-auth.js.map