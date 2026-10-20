/**
 * Late-bound bridge from the app:// protocol handler to project-owned runtimes.
 *
 * Protocol registration happens before SSH project IPC is initialized, so the
 * handler cannot receive the registry through constructor injection. Keeping
 * this seam in a host-free module lets the protocol resolve the current
 * registry at request time without introducing a process-wide SSH singleton.
 */

const PROJECT_RUNTIME_MEDIA_PATH = '/mavis/api/file/media';
const PROJECT_RUNTIME_ID_QUERY = 'runtimeId';
let activeHandler = null;
export function registerProjectRuntimeMediaRequestHandler(handler) {
    activeHandler = handler;
    return () => {
        if (activeHandler === handler)
            activeHandler = null;
    };
}
export function handleProjectRuntimeMediaRequest(runtimeId, request) {
    if (!activeHandler) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'project_runtime_unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
        }));
    }
    return activeHandler(runtimeId, request);
}
/**
 * Routes a project-owned media request when the URL carries a Runtime ID.
 *
 * The Runtime ID is Desktop-only routing metadata. It is removed before the
 * request crosses the RuntimeTransport boundary so the remote file API keeps
 * the same contract as a local Runtime.
 */
export function routeProjectRuntimeMediaRequest(request) {
    const url = new URL(request.url);
    if (url.pathname !== PROJECT_RUNTIME_MEDIA_PATH)
        return null;
    const runtimeId = url.searchParams.get(PROJECT_RUNTIME_ID_QUERY);
    if (!runtimeId)
        return null;
    url.searchParams.delete(PROJECT_RUNTIME_ID_QUERY);
    const init = {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body;
        init.duplex = 'half';
    }
    return handleProjectRuntimeMediaRequest(runtimeId, new Request(url.toString(), init));
}
