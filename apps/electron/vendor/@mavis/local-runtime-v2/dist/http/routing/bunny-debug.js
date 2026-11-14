import { getRuntimeBuildEnv } from '@mavis/config';
import { BunnyDebugError, } from '../../service/bunny/index.js';
const PREFIX = '/mavis/api/developer/bunny-debug';
/**
 * Developer Tools Bunny reset endpoints. Only dev and test builds answer; a
 * production build returns 404 so neither the panel nor a direct call reaches them.
 */
export function mountBunnyDebugRoutes(app, service) {
    const handle = (action) => async (context) => {
        if (!['dev', 'test'].includes(getRuntimeBuildEnv()))
            return context.json({ error: 'Not found' }, 404);
        if (!service)
            return context.json({ error: 'Bunny debug unavailable' }, 503);
        const body = await readBody(context);
        try {
            return context.json((await action(service, body)));
        }
        catch (error) {
            if (error instanceof BunnyDebugError)
                return context.json({ error: error.message, ...error.details }, error.status);
            throw error;
        }
    };
    app.post(`${PREFIX}/preview`, handle((owner) => owner.preview()));
    app.post(`${PREFIX}/simulate-onboarding`, handle((owner, body) => owner.simulateOnboarding({
        clearMemory: body.clearMemory === true,
        clearRoutines: body.clearRoutines === true,
    })));
    app.post(`${PREFIX}/delete-space`, handle((owner, body) => {
        if (typeof body.spaceId !== 'string' || !body.spaceId)
            throw new BunnyDebugError('spaceId is required', 400);
        return owner.deleteSpace(body.spaceId);
    }));
}
async function readBody(context) {
    try {
        const body = await context.req.json();
        return body && typeof body === 'object' ? body : {};
    }
    catch {
        return {};
    }
}
//# sourceMappingURL=bunny-debug.js.map