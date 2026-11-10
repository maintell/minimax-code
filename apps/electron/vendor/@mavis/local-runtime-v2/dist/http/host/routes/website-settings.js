import { logger } from '../../../infra/logging/logger.js';
import { json, notFound, readJsonBody } from '../../../infra/transport/host-http.js';
import { LocalWebsiteManagementClient, WEBSITE_LIST_MAX_OFFSET, } from '../../../service/website/index.js';
import { sanitizeAliasCheckResponse, sanitizeAliasResponse, } from '../../../service/website/index.js';
export async function routeLocalWebsiteSettingsApi(input) {
    const { parts, request } = input;
    const pathname = `/${parts.join('/')}`;
    if (parts[0] !== 'drive')
        return notFound(pathname);
    const client = new LocalWebsiteManagementClient({
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(input.authContextGetter ? { authContext: input.authContextGetter() } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        routingContextGetter: input.routingContextGetter,
    });
    const context = { client, request, operation: 'website_settings' };
    try {
        if (parts[1] === 'websites') {
            if (parts.length !== 2 || input.method !== 'GET')
                return notFound(pathname);
            return await listWebsites(context);
        }
        return await routeWebsiteFile(context, input);
    }
    catch (error) {
        logger.error({ operation: context.operation, err: error }, 'website gateway request failed');
        const message = error instanceof Error ? error.message : 'Website settings request failed.';
        return json({ error: message }, { status: 502 });
    }
}
async function listWebsites(context) {
    const { client, request } = context;
    const url = new URL(request.url);
    const offset = readStrictIntegerSearchParam(url, 'offset');
    const limit = readStrictIntegerSearchParam(url, 'limit');
    if (offset === undefined || offset < 0 || offset > WEBSITE_LIST_MAX_OFFSET) {
        return json({ error: `offset must be an integer between 0 and ${WEBSITE_LIST_MAX_OFFSET}.` }, { status: 400 });
    }
    if (limit === undefined || limit < 1 || limit > 100) {
        return json({ error: 'limit must be an integer between 1 and 100.' }, { status: 400 });
    }
    const sort = readWebsiteListSort(url);
    if (!sort.ok)
        return json({ error: sort.error }, { status: 400 });
    context.operation = 'list_websites';
    logger.info({ operation: context.operation, offset, limit, ...sort.value }, 'website gateway request');
    return json(await client.listWebsites(offset, limit, sort.value, request.signal));
}
async function routeWebsiteFile(context, input) {
    const { parts, method } = input;
    const pathname = `/${parts.join('/')}`;
    if (parts[1] !== 'file' || parts[2] === undefined)
        return notFound(pathname);
    const nodeId = parts[2].trim();
    const route = `${method} ${parts.slice(3).join('/')}`;
    const isSettings = parts[3] === 'website-settings';
    if (!isSettings && !['GET traffic', 'GET website-project-source/download-url'].includes(route)) {
        return notFound(pathname);
    }
    if (!nodeId)
        return json({ error: 'node_id is required.' }, { status: 400 });
    if (route === 'GET traffic')
        return getWebsiteTraffic(context, nodeId);
    if (route === 'GET website-project-source/download-url') {
        const bodyError = await rejectNonEmptyBody(context.request, 'website-project-source download');
        if (bodyError)
            return bodyError;
        context.operation = 'get_project_source_download_url';
        return json(await context.client.getProjectSourceDownloadUrl(nodeId, context.request.signal));
    }
    return routeWebsiteSettings(context, nodeId, route, pathname);
}
async function getWebsiteTraffic(context, nodeId) {
    const { client, request } = context;
    const url = new URL(request.url);
    const days = readStrictIntegerSearchParam(url, 'days');
    if (days !== 7 && days !== 30)
        return json({ error: 'days must be 7 or 30.' }, { status: 400 });
    const paths = url.searchParams.getAll('path');
    if (paths.length > 1) {
        return json({ error: 'path must be provided at most once.' }, { status: 400 });
    }
    const path = paths[0];
    const granularity = readWebsiteTrafficGranularity(url);
    if (!granularity.ok)
        return json({ error: granularity.error }, { status: 400 });
    const options = {
        ...(path !== undefined ? { path } : {}),
        ...(granularity.value ? { granularity: granularity.value } : {}),
    };
    context.operation = 'get_website_traffic';
    logger.info({ operation: context.operation, nodeId, days, pathProvided: path !== undefined,
        ...(granularity.value ? { granularity: granularity.value } : {}) }, 'website gateway request');
    // Preserve an explicitly empty path; ArchonServer owns its "/" normalization.
    return json(await client.getTraffic(nodeId, days, options, request.signal));
}
async function routeWebsiteSettings(context, nodeId, route, pathname) {
    const { client, request } = context;
    switch (route) {
        case 'GET website-settings':
            return json(await client.getState(nodeId, request.signal));
        case 'DELETE website-settings':
            return mutateWebsitePublication(context, nodeId, 'cancel');
        case 'POST website-settings/unpublish':
            return mutateWebsitePublication(context, nodeId, 'unpublish');
        case 'POST website-settings/republish':
            return mutateWebsitePublication(context, nodeId, 'republish');
        case 'PUT website-settings/watermark': {
            const validation = readWatermarkBody(await readJsonBody(request));
            if (!validation.ok)
                return json({ error: validation.error }, { status: 400 });
            return json(await client.updateWatermark(nodeId, validation.enabled, request.signal));
        }
        case 'PUT website-settings/name': {
            const validation = readNameBody(await readJsonBody(request));
            if (!validation.ok)
                return json({ error: validation.error }, { status: 400 });
            return json(await client.updateName(nodeId, validation.displayName, request.signal));
        }
        default:
            return routeWebsiteAlias(context, nodeId, route, pathname);
    }
}
async function mutateWebsitePublication({ client, request }, nodeId, action) {
    const label = action === 'cancel' ? 'deletion' : action;
    const bodyError = await rejectNonEmptyBody(request, `website-settings ${label}`);
    if (bodyError)
        return bodyError;
    // ArchonServer owns the publication and deletion state transitions.
    return json(await client[action](nodeId, request.signal));
}
async function routeWebsiteAlias({ client, request }, nodeId, route, pathname) {
    if (route === 'DELETE website-settings/alias') {
        const body = await readJsonBody(request);
        if (Object.keys(body).length > 0) {
            return json({ error: 'website-settings alias removal does not accept a request body.' }, { status: 400 });
        }
        return json(await client.removeAlias(nodeId, request.signal));
    }
    if (!['PUT website-settings/alias', 'POST website-settings/alias/check', 'POST website-settings/alias/unbind'].includes(route)) {
        return notFound(pathname);
    }
    const validation = readAliasBody(await readJsonBody(request));
    if (!validation.ok)
        return json({ error: validation.error }, { status: 400 });
    if (route === 'PUT website-settings/alias') {
        return json(await client.setAlias(nodeId, validation.alias, request.signal));
    }
    if (route === 'POST website-settings/alias/check') {
        return json(sanitizeAliasCheckResponse(await client.checkAlias(nodeId, validation.alias, request.signal), nodeId));
    }
    return json(sanitizeAliasResponse(await client.unbindAlias(nodeId, validation.alias, request.signal)));
}
function readStrictIntegerSearchParam(url, name) {
    const values = url.searchParams.getAll(name);
    if (values.length !== 1 || !/^-?\d+$/.test(values[0] ?? ''))
        return undefined;
    const value = Number(values[0]);
    return Number.isSafeInteger(value) ? value : undefined;
}
function readWebsiteTrafficGranularity(url) {
    const values = url.searchParams.getAll('granularity');
    if (values.length === 0)
        return { ok: true };
    if (values.length !== 1 || (values[0] !== 'hour' && values[0] !== 'day')) {
        return { ok: false, error: 'granularity must be hour or day.' };
    }
    return { ok: true, value: values[0] };
}
function readWebsiteListSort(url) {
    const sortByValues = url.searchParams.getAll('sort_by');
    if (sortByValues.length > 1 ||
        sortByValues.some((value) => !['deployed_at', 'updated_at'].includes(value))) {
        return { ok: false, error: 'sort_by must be deployed_at or updated_at.' };
    }
    const sortOrderValues = url.searchParams.getAll('sort_order');
    if (sortOrderValues.length > 1 ||
        sortOrderValues.some((value) => !['asc', 'desc'].includes(value))) {
        return { ok: false, error: 'sort_order must be asc or desc.' };
    }
    const sortBy = sortByValues[0] === 'deployed_at' ? 'deployed_at' : 'updated_at';
    const sortOrder = sortOrderValues[0] === 'asc' ? 'asc' : 'desc';
    return {
        ok: true,
        value: {
            sortBy,
            sortOrder,
        },
    };
}
function readWatermarkBody(body) {
    const unexpected = Object.keys(body).find((key) => key !== 'watermark_enabled');
    if (unexpected) {
        return { ok: false, error: `Unsupported website-settings field: ${unexpected}.` };
    }
    if (typeof body.watermark_enabled !== 'boolean') {
        return { ok: false, error: 'watermark_enabled must be a boolean.' };
    }
    return { ok: true, enabled: body.watermark_enabled };
}
function readAliasBody(body) {
    const unexpected = Object.keys(body).find((key) => key !== 'alias');
    if (unexpected) {
        return { ok: false, error: `Unsupported website-settings field: ${unexpected}.` };
    }
    if (typeof body.alias !== 'string' || !body.alias.trim()) {
        return { ok: false, error: 'alias must be a non-empty string.' };
    }
    return { ok: true, alias: body.alias.trim() };
}
function readNameBody(body) {
    const unexpected = Object.keys(body).find((key) => key !== 'display_name');
    if (unexpected) {
        return { ok: false, error: `Unsupported website-settings field: ${unexpected}.` };
    }
    if (typeof body.display_name !== 'string' || !body.display_name.trim()) {
        return { ok: false, error: 'display_name must be a non-empty string.' };
    }
    return { ok: true, displayName: body.display_name.trim() };
}
async function rejectNonEmptyBody(request, label) {
    if ((await request.text()).length === 0)
        return undefined;
    return json({ error: `${label} does not accept a request body.` }, { status: 400 });
}
//# sourceMappingURL=website-settings.js.map