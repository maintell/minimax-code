/** Only mapped driver targets are eligible; app discovery never picks a window. */
export function mappedPreviewTarget(request, payload) {
    const nested = payload.target;
    const target = nested && typeof nested === 'object' ? nested : payload;
    const base = { sessionId: request.sessionId, turnId: request.turnId };
    if (request.kind === 'desktop_state' || target.kind === 'desktop') {
        return { ...base, kind: 'desktop' };
    }
    if (Number.isSafeInteger(target.pid) &&
        Number(target.pid) > 0 &&
        Number.isSafeInteger(target.window_id) &&
        Number(target.window_id) > 0) {
        return { ...base, kind: 'window', pid: Number(target.pid), windowId: Number(target.window_id) };
    }
    return undefined;
}
export function createPreviewTargetPublisher(runtime, publish) {
    const names = new Map();
    const activeTargets = new Map();
    return async (request, payload) => {
        const target = mappedPreviewTarget(request, payload);
        if (!target)
            return;
        const previous = activeTargets.get(request.sessionId);
        // A desktop observation can support an app task without changing its preview.
        // Actual desktop input still publishes a desktop target below.
        if (request.kind === 'desktop_state' &&
            previous?.kind === 'window' &&
            previous.turnId === request.turnId)
            return;
        if (target.pid && !names.has(target.pid)) {
            // list_apps does not refresh AX observations/tokens. Metadata failure must
            // never prevent the actual action, nor choose a different capture target.
            try {
                const raw = await runtime.callTool('list_apps', { session: payload.session }, AbortSignal.timeout(1500));
                const record = raw;
                const json = record.structuredJson ?? record.rawJson;
                const apps = (json ? JSON.parse(json) : record).apps;
                if (Array.isArray(apps)) {
                    names.clear();
                    for (const app of apps) {
                        if (typeof app.pid === 'number' && typeof app.name === 'string')
                            names.set(app.pid, {
                                appName: app.name,
                                ...(typeof app.launch_path === 'string' ? { appPath: app.launch_path } : {}),
                            });
                    }
                }
            }
            catch {
                /* Optional presentation metadata. */
            }
        }
        try {
            const next = { ...target, ...(target.pid ? names.get(target.pid) : {}) };
            publish(next);
            activeTargets.set(request.sessionId, next);
            const oldest = activeTargets.keys().next().value;
            if (activeTargets.size > 32 && oldest)
                activeTargets.delete(oldest);
        }
        catch {
            /* Preview delivery must never fail the computer action. */
        }
    };
}
