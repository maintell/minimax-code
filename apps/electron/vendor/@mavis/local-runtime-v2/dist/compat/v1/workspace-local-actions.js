import { WorkspaceLocalActionError, } from '../../service/workspace/index.js';
const LOCAL_RUNTIME_ORIGIN = 'http://local-runtime.test';
/**
 * Adapts the existing local file API to the small V2 host-local effects
 * interface.  This keeps OS/IDE launch policy in the established V1
 * implementation while making V2 the only DesktopService owner.
 */
export function createV1WorkspaceLocalActionsPort(api) {
    return {
        openApp: async ({ workspace, path }) => {
            await requestWorkspaceLocalJson(api, workspaceLocalQuery('/mavis/api/file/open-app', { workspace, path }));
        },
        listIdeApps: async () => {
            const body = await requestWorkspaceLocalJson(api, '/mavis/api/file/ide-apps');
            if (!body || typeof body !== 'object')
                return [];
            const apps = Reflect.get(body, 'apps');
            if (!Array.isArray(apps))
                return [];
            return apps.map(toWorkspaceIdeApp).filter((app) => app !== undefined);
        },
        openFile: (input) => requestWorkspaceLocalJson(api, '/mavis/api/file/open', {
            method: 'POST',
            body: input,
        }),
        revealFile: (input) => requestWorkspaceLocalJson(api, '/mavis/api/file/reveal', {
            method: 'POST',
            body: input,
        }),
        openFileInIde: (input) => requestWorkspaceLocalJson(api, '/mavis/api/file/open-in-ide', {
            method: 'POST',
            body: input,
        }),
    };
}
function workspaceLocalQuery(pathname, values) {
    const url = new URL(pathname, LOCAL_RUNTIME_ORIGIN);
    for (const [key, value] of Object.entries(values)) {
        if (value !== undefined)
            url.searchParams.set(key, value);
    }
    return url;
}
async function requestWorkspaceLocalJson(api, pathOrUrl, init = {}) {
    const response = await api.routeLocalApiRequest(new Request(resolveWorkspaceLocalUrl(pathOrUrl), createWorkspaceRequestInit(init)));
    const body = parseWorkspaceResponseBody(await response.text());
    if (!response.ok)
        throw workspaceLocalResponseError(response.status, body);
    return body;
}
function resolveWorkspaceLocalUrl(pathOrUrl) {
    return typeof pathOrUrl === 'string' ? new URL(pathOrUrl, LOCAL_RUNTIME_ORIGIN) : pathOrUrl;
}
function createWorkspaceRequestInit(init) {
    if (init.body === undefined)
        return { method: init.method ?? 'GET' };
    return {
        method: init.method ?? 'GET',
        body: JSON.stringify(init.body),
        headers: { 'Content-Type': 'application/json' },
    };
}
function parseWorkspaceResponseBody(text) {
    if (!text)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function workspaceLocalResponseError(status, body) {
    const error = body && typeof body === 'object' ? Reflect.get(body, 'error') : undefined;
    const code = body && typeof body === 'object' ? Reflect.get(body, 'code') : undefined;
    return new WorkspaceLocalActionError(status, typeof code === 'string' ? code : undefined, typeof error === 'string' && error.trim()
        ? error
        : `Workspace local action failed with status ${status}`);
}
function toWorkspaceIdeApp(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const id = Reflect.get(value, 'id');
    const name = Reflect.get(value, 'name');
    const icon = Reflect.get(value, 'icon') ?? Reflect.get(value, 'iconDataUrl');
    const available = Reflect.get(value, 'available');
    return {
        ...(typeof id === 'string' ? { id } : {}),
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof icon === 'string' ? { icon } : {}),
        ...(typeof available === 'boolean' ? { available } : {}),
    };
}
//# sourceMappingURL=workspace-local-actions.js.map