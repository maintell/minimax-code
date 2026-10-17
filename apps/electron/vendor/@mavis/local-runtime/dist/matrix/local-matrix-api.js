import { callMatrixTool, MATRIX_TOOL_PATHS } from '@mavis/agent-tools/cloud';
import { json, notFound, readFirstString, readJsonBody, readRecord } from '../api/host-helpers.js';
import { LocalMatrixClient } from './local-matrix-client.js';
export async function routeLocalMatrixApi(input) {
    const { method, parts, request } = input;
    if (parts[1] !== 'tool' || parts[2] !== 'call' || method !== 'POST') {
        return notFound(`/matrix/${parts.slice(1).join('/')}`);
    }
    const body = await readJsonBody(request);
    const toolName = readFirstString(body, ['tool', 'toolName', 'tool_name']);
    if (!toolName)
        return json({ success: false, error: 'tool is required' }, { status: 400 });
    if (toolName !== 'images_understand') {
        return json({
            success: false,
            error: `Matrix tool is not exposed through local HTTP route: ${toolName}`,
        }, { status: 404 });
    }
    const args = readRecord(body.arguments ?? body.args ?? body.input);
    const validated = readInlineImagesUnderstandArgs(args);
    if (!validated.ok)
        return json({ success: false, error: validated.error }, { status: 400 });
    const client = new LocalMatrixClient({
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(input.authContextGetter ? { authContext: input.authContextGetter() } : {}),
        routingContextGetter: input.routingContextGetter,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    try {
        const result = await callMatrixTool({
            toolName,
            path: MATRIX_TOOL_PATHS.images_understand,
            input: validated.input,
            ctx: {
                sessionId: 'local-matrix-http',
                turnId: `matrix-http-${Date.now()}`,
            },
            archonServer: client,
            signal: request.signal,
        });
        return json({ success: true, tool: toolName, result });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json({ success: false, error: message }, { status: 500 });
    }
}
const INLINE_IMAGES_UNDERSTAND_TOP_LEVEL_KEYS = new Set(['image_info']);
const INLINE_IMAGE_INFO_KEYS = new Set(['data', 'mime_type', 'prompt']);
function readInlineImagesUnderstandArgs(args) {
    for (const key of Object.keys(args)) {
        if (!INLINE_IMAGES_UNDERSTAND_TOP_LEVEL_KEYS.has(key)) {
            return {
                ok: false,
                error: `Local Matrix HTTP image understanding does not accept field: ${key}.`,
            };
        }
    }
    const imageInfo = args.image_info;
    if (!Array.isArray(imageInfo) || imageInfo.length === 0) {
        return { ok: false, error: 'images_understand requires a non-empty image_info array.' };
    }
    const sanitized = [];
    for (const [index, item] of imageInfo.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return { ok: false, error: `image_info[${index}] must be an object.` };
        }
        const record = item;
        for (const key of Object.keys(record)) {
            if (!INLINE_IMAGE_INFO_KEYS.has(key)) {
                return {
                    ok: false,
                    error: 'Local Matrix HTTP image understanding only accepts inline image data.',
                };
            }
        }
        if (typeof record.data !== 'string' || record.data.length === 0) {
            return { ok: false, error: `image_info[${index}].data is required.` };
        }
        if (record.mime_type !== undefined && typeof record.mime_type !== 'string') {
            return { ok: false, error: `image_info[${index}].mime_type must be a string.` };
        }
        if (record.prompt !== undefined && typeof record.prompt !== 'string') {
            return { ok: false, error: `image_info[${index}].prompt must be a string.` };
        }
        sanitized.push({
            data: record.data,
            ...(record.mime_type !== undefined ? { mime_type: record.mime_type } : {}),
            ...(record.prompt !== undefined ? { prompt: record.prompt } : {}),
        });
    }
    return { ok: true, input: { image_info: sanitized } };
}
//# sourceMappingURL=local-matrix-api.js.map