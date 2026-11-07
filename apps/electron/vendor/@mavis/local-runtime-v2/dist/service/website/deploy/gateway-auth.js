/**
 * website_deploy 网关请求的身份绑定。
 *
 * 为什么每次请求现取 token：部署客户端在 Turn 开始组装工具时就创建了，而一个长 Turn 加上
 * 打包、上传两个归档、发布，可能持续几十分钟。这期间 Desktop 主进程会按时刷新 OAuth
 * access token，并把 utility 进程里的 authContext 整个换成新对象，旧对象不会被修改。
 * 构建时拿到的快照因此一直停在旧 token，之后的 get_upload_url / publish_archive 会持续 401。
 * 所以网关 POST 每次都从宿主的 authContextGetter 现取身份。
 *
 * 为什么绑定 loginEpoch：token 刷新保持同一个 loginEpoch，换账号、登出或重新登录会换成新值
 * （或清空）。一次部署从上传到发布必须属于同一次登录，否则站点会发到另一个账号名下，
 * 所以 epoch 变化时直接中止，不用新身份继续。
 *
 * 预签名 PUT 由 URL 自带授权，不带 Authorization 头，也不参与这里的 401 恢复。
 */
import { DesktopGatewayHttpError } from '@mavis/agent-tools/desktop';
import { logger } from '../../../infra/logging/logger.js';
const HTTP_UNAUTHORIZED = 401;
/** 部署途中 Desktop 登录身份变化（换账号、登出、重新登录）。 */
class WebsiteDeployLoginChangedError extends Error {
    constructor() {
        super('the Desktop sign-in changed during this deployment (account switch, sign-out or ' +
            're-login), so it was stopped before anything was published under a different ' +
            'account. Confirm the signed-in account, then deploy again');
        this.name = 'WebsiteDeployLoginChangedError';
    }
}
/**
 * 包装部署网关：每次 POST 前校验登录未变；POST 返回 401 时请宿主刷新 token，并用新 token
 * 只重试一次。内层网关需要读取同一个 authContextGetter 来组装 Authorization 头。
 */
export class FreshAuthWebsiteDeployGateway {
    inner;
    source;
    loginEpoch;
    constructor(inner, source) {
        this.inner = inner;
        this.source = source;
        // 构建时的登录即本次部署的归属；之后只接受同一 loginEpoch 下刷新出来的 token。
        this.loginEpoch = source.authContextGetter()?.loginEpoch;
    }
    async postGatewayJson(...request) {
        const [pathname] = request;
        const rejectedToken = this.readSameLoginAuth(pathname)?.accessToken?.trim();
        try {
            // 内层 LocalMatrixClient 在第一个 await 之前同步读取 getter 组装请求头，
            // 所以本次请求带的正是上面读到的 token，401 时把它作为被拒 token 上报。
            return await this.inner.postGatewayJson(...request);
        }
        catch (err) {
            if (!isUnauthorized(err) || !rejectedToken || !this.source.authContextInvalidator) {
                throw err;
            }
            return this.retryAfterTokenRefresh(err, rejectedToken, request);
        }
    }
    putBytes(...request) {
        return this.inner.putBytes(...request);
    }
    async retryAfterTokenRefresh(unauthorized, rejectedToken, request) {
        const [pathname] = request;
        const fields = {
            stage: gatewayStage(pathname),
            path: pathname,
            status_code: HTTP_UNAUTHORIZED,
        };
        logger.warn({ ...fields, result: 'refreshing' }, 'website deploy gateway unauthorized; refreshing access token once');
        try {
            await this.source.authContextInvalidator?.(rejectedToken, this.loginEpoch);
        }
        catch {
            logGatewayRetry(fields, 'failed', 'invalidator_failed');
            throw unauthorized;
        }
        // 刷新期间若登录已变化，这里抛出 WebsiteDeployLoginChangedError，不以新身份重试。
        const freshToken = this.readSameLoginAuth(pathname)?.accessToken?.trim();
        if (!freshToken || freshToken === rejectedToken) {
            logGatewayRetry(fields, 'failed', 'token_not_refreshed');
            throw unauthorized;
        }
        try {
            const response = await this.inner.postGatewayJson(...request);
            logGatewayRetry(fields, 'ok');
            return response;
        }
        catch (retryErr) {
            logGatewayRetry(fields, 'failed', 'retry_failed', readStatusCode(retryErr));
            throw retryErr;
        }
    }
    readSameLoginAuth(pathname) {
        const auth = this.source.authContextGetter() ?? undefined;
        if (auth?.authState === 'logged_out' || auth?.loginEpoch !== this.loginEpoch) {
            // 只记录有无，不记录 loginEpoch 或 token 的值。
            logger.warn({
                stage: gatewayStage(pathname),
                path: pathname,
                result: 'aborted',
                error_type: 'login_changed',
                bound_login_present: this.loginEpoch !== undefined,
                current_login_present: auth?.loginEpoch !== undefined,
                auth_state: auth?.authState ?? 'none',
            }, 'website deploy aborted: desktop login changed');
            throw new WebsiteDeployLoginChangedError();
        }
        return auth;
    }
}
function isUnauthorized(err) {
    return err instanceof DesktopGatewayHttpError && err.statusCode === HTTP_UNAUTHORIZED;
}
function readStatusCode(err) {
    return err instanceof DesktopGatewayHttpError ? err.statusCode : undefined;
}
/** 网关路径的最后一段即部署操作名：get_upload_url / publish_archive / update_archive。 */
function gatewayStage(pathname) {
    return pathname.slice(pathname.lastIndexOf('/') + 1) || 'gateway';
}
function logGatewayRetry(fields, result, errorType, retryStatusCode) {
    const logFields = {
        ...fields,
        result,
        ...(errorType ? { error_type: errorType } : {}),
        ...(retryStatusCode !== undefined ? { retry_status_code: retryStatusCode } : {}),
    };
    if (result === 'ok') {
        logger.info(logFields, 'website deploy gateway retry after token refresh');
    }
    else {
        logger.warn(logFields, 'website deploy gateway retry after token refresh');
    }
}
//# sourceMappingURL=gateway-auth.js.map