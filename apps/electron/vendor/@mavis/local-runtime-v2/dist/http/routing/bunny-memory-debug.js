import { getRuntimeBuildEnv } from '@mavis/config';
/** Developer Tools replay endpoint; uses the runtime's own profile and model configuration. */
export function mountBunnyMemoryDebugRoutes(app, memory) {
    app.post('/mavis/api/developer/bunny-memory/run', async (context) => {
        if (!['dev', 'test'].includes(getRuntimeBuildEnv()))
            return context.json({ error: 'Not found' }, 404);
        if (!memory)
            return context.json({ error: 'Bunny memory unavailable' }, 503);
        const body = await context.req.json();
        if (body.action === 'capture')
            return context.json(await memory.capture(body.session_id));
        if (body.action === 'lint')
            return context.json(await memory.lint(true));
        return context.json({ error: 'action must be capture or lint' }, 400);
    });
}
//# sourceMappingURL=bunny-memory-debug.js.map