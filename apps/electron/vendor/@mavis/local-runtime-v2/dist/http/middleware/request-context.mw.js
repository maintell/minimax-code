import { buildRequestContext } from '../context.js';
export function requestContextMiddleware(deps) {
    return async (c, next) => {
        c.set('requestContext', buildRequestContext(c.req.raw, deps));
        await next();
        try {
            c.get('requestContext').observationHeaders?.forEach((value, name) => {
                if (name.startsWith('x-mavis-observation-') && value.length <= 4096)
                    c.header(name, value);
            });
        }
        catch {
            /* Diagnostics cannot change the status/body, including error responses. */
        }
    };
}
//# sourceMappingURL=request-context.mw.js.map