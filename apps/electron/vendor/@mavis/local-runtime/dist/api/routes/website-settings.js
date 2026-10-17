import { logger } from '../../common/logger.js';
import { json, notFound, readJsonBody } from '../host-helpers.js';
import { LocalWebsiteManagementClient, WEBSITE_LIST_MAX_OFFSET, } from '../../website-management/index.js';
import { sanitizeAliasCheckResponse, sanitizeAliasResponse, } from '../../website-management/website-alias-response.js';
export async function routeLocalWebsiteSettingsApi(input) {
    const { method, parts, request } = input;
    const pathname = `/${parts.join('/')}`;
    if (parts[0] !== 'drive')
        return notFound(pathname);
    const client = new LocalWebsiteManagementClient({
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(input.authContextGetter ? { authContext: input.authContextGetter() } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        routingContextGetter: input.routingContextGetter,
    });
    let operation = 'website_settings';
    try {
        if (parts[1] === 'websites') {
            if (parts.length !== 2 || method !== 'GET')
                return notFound(pathname);
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
            operation = 'list_websites';
            logger.info({ operation, offset, limit, ...sort.value }, 'website gateway request');
            // Keep the BizGateway response, including business codes and payload, unchanged.
            return json(await client.listWebsites(offset, limit, sort.value, request.signal));
        }
        if (parts[1] === 'file' &&
            parts[2] !== undefined &&
            parts[3] === 'traffic' &&
            parts.length === 4 &&
            method === 'GET') {
            const nodeId = parts[2].trim();
            if (!nodeId)
                return json({ error: 'node_id is required.' }, { status: 400 });
            const url = new URL(request.url);
            const days = readStrictIntegerSearchParam(url, 'days');
            if (days === undefined || (days !== 7 && days !== 30)) {
                return json({ error: 'days must be 7 or 30.' }, { status: 400 });
            }
            const paths = url.searchParams.getAll('path');
            if (paths.length > 1) {
                return json({ error: 'path must be provided at most once.' }, { status: 400 });
            }
            const path = paths.length === 1 ? paths[0] : undefined;
            const granularity = readWebsiteTrafficGranularity(url);
            if (!granularity.ok)
                return json({ error: granularity.error }, { status: 400 });
            operation = 'get_website_traffic';
            logger.info({
                operation,
                nodeId,
                days,
                pathProvided: path !== undefined,
                ...(granularity.value ? { granularity: granularity.value } : {}),
            }, 'website gateway request');
            // Preserve an explicitly empty path; ArchonServer owns its "/" normalization.
            return json(await client.getTraffic(nodeId, days, {
                ...(path !== undefined ? { path } : {}),
                ...(granularity.value ? { granularity: granularity.value } : {}),
            }, request.signal));
        }
        if (parts[1] === 'file' &&
            parts[2] !== undefined &&
            parts[3] === 'website-project-source' &&
            parts[4] === 'download-url' &&
            parts.length === 5 &&
            method === 'GET') {
            const nodeId = parts[2].trim();
            if (!nodeId)
                return json({ error: 'node_id is required.' }, { status: 400 });
            const bodyError = await rejectNonEmptyBody(request, 'website-project-source download');
            if (bodyError)
                return bodyError;
            operation = 'get_project_source_download_url';
            return json(await client.getProjectSourceDownloadUrl(nodeId, request.signal));
        }
        if (parts[1] !== 'file' || parts[2] === undefined || parts[3] !== 'website-settings') {
            return notFound(pathname);
        }
        const nodeId = parts[2].trim();
        if (!nodeId)
            return json({ error: 'node_id is required.' }, { status: 400 });
        if (parts.length === 4 && method === 'GET') {
            return json(await client.getState(nodeId, request.signal));
        }
        if (parts.length === 4 && method === 'DELETE') {
            const bodyError = await rejectNonEmptyBody(request, 'website-settings deletion');
            if (bodyError)
                return bodyError;
            // Cancel is irreversible full deletion; ArchonServer owns the state transition.
            return json(await client.cancel(nodeId, request.signal));
        }
        if (parts.length === 5 && parts[4] === 'unpublish' && method === 'POST') {
            const bodyError = await rejectNonEmptyBody(request, 'website-settings unpublish');
            if (bodyError)
                return bodyError;
            // Unpublish is reversible; do not infer publish state in local-runtime.
            return json(await client.unpublish(nodeId, request.signal));
        }
        if (parts.length === 5 && parts[4] === 'republish' && method === 'POST') {
            const bodyError = await rejectNonEmptyBody(request, 'website-settings republish');
            if (bodyError)
                return bodyError;
            return json(await client.republish(nodeId, request.signal));
        }
        if (parts.length === 5 && parts[4] === 'watermark' && method === 'PUT') {
            const body = await readJsonBody(request);
            const validation = readWatermarkBody(body);
            if (!validation.ok)
                return json({ error: validation.error }, { status: 400 });
            return json(await client.updateWatermark(nodeId, validation.enabled, request.signal));
        }
        if (parts.length === 5 && parts[4] === 'name' && method === 'PUT') {
            const body = await readJsonBody(request);
            const validation = readNameBody(body);
            if (!validation.ok)
                return json({ error: validation.error }, { status: 400 });
            return json(await client.updateName(nodeId, validation.displayName, request.signal));
        }
        if (parts.length === 5 && parts[4] === 'alias' && method === 'PUT') {
            const body = await readJsonBody(request);
            const validation = readAliasBody(body);
            if (!validation.ok)
                return json({ error: validation.error }, { status: 400 });
            return json(await client.setAlias(nodeId, validation.alias, request.signal));
        }
        if (parts.length === 5 && parts[4] === 'alias' && method === 'DELETE') {
            const body = await readJsonBody(request);
            if (Object.keys(body).length > 0) {
                return json({ error: 'website-settings alias removal does not accept a request body.' }, { status: 400 });
            }
            return json(await client.removeAlias(nodeId, request.signal));
        }
        if (parts.length === 6 && parts[4] === 'alias' && parts[5] === 'check' && method === 'POST') {
            const body = await readJsonBody(request);
            const validation = readAliasBody(body);
            if (!validation.ok)
                return json({ error: validation.error }, { status: 400 });
            return json(sanitizeAliasCheckResponse(await client.checkAlias(nodeId, validation.alias, request.signal), nodeId));
        }
        if (parts.length === 6 && parts[4] === 'alias' && parts[5] === 'unbind' && method === 'POST') {
            const body = await readJsonBody(request);
            const validation = readAliasBody(body);
            if (!validation.ok)
                return json({ error: validation.error }, { status: 400 });
            return json(sanitizeAliasResponse(await client.unbindAlias(nodeId, validation.alias, request.signal)));
        }
        return notFound(pathname);
    }
    catch (error) {
        logger.error({ operation, err: error }, 'website gateway request failed');
        const message = error instanceof Error ? error.message : 'Website settings request failed.';
        return json({ error: message }, { status: 502 });
    }
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
        (sortByValues.length === 1 &&
            sortByValues[0] !== 'deployed_at' &&
            sortByValues[0] !== 'updated_at')) {
        return { ok: false, error: 'sort_by must be deployed_at or updated_at.' };
    }
    const sortOrderValues = url.searchParams.getAll('sort_order');
    if (sortOrderValues.length > 1 ||
        (sortOrderValues.length === 1 && sortOrderValues[0] !== 'asc' && sortOrderValues[0] !== 'desc')) {
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