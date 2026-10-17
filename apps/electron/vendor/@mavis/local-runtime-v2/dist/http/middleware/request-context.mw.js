import { buildRequestContext } from '../context.js';
export function requestContextMiddleware(deps) {
    return async (c, next) => {
        c.set('requestContext', buildRequestContext(c.req.raw, deps));
        await next();
    };
}
//# sourceMappingURL=request-context.mw.js.map