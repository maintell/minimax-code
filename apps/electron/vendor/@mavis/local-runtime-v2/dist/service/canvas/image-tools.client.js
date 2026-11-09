import { DesktopGatewayHttpError, DesktopMatrixMediaClient, } from '@mavis/agent-tools/desktop';
import { CanvasServiceError, } from './contracts.js';
/** Server-side tool work is bounded at 120s; the download shares the same bound. */
const MATRIX_IMAGE_TOOL_TIMEOUT_MS = 120_000;
const REMOVE_IMAGE_BACKGROUND = {
    path: '/matrix/api/v1/mcp/remove_image_background',
    signInMessage: 'Sign in to remove image backgrounds',
    failedMessage: 'Background removal failed',
    emptyMessage: 'Background removal returned no image',
    downloadFailedMessage: 'Background removal result download failed',
};
const ENHANCE_IMAGE = {
    path: '/matrix/api/v1/mcp/enhance_image',
    signInMessage: 'Sign in to enhance images',
    failedMessage: 'Image enhancement failed',
    emptyMessage: 'Image enhancement returned no image',
    downloadFailedMessage: 'Enhanced image download failed',
};
/**
 * Production image-tool port: uploads the source to the Matrix CDN, calls the Matrix MCP
 * tool with its CDN URL and downloads the result to the requested local path.
 */
export function createMatrixCanvasImageTools(options) {
    return {
        removeBackground: (input) => runMatrixImageTool(options, REMOVE_IMAGE_BACKGROUND, input),
        enhance: (input) => runMatrixImageTool(options, ENHANCE_IMAGE, input),
    };
}
async function runMatrixImageTool(options, tool, input) {
    const client = options.createClient();
    try {
        client.buildHeaders();
    }
    catch {
        throw new CanvasServiceError('AUTH_REQUIRED', tool.signInMessage);
    }
    const media = new DesktopMatrixMediaClient(client);
    let imageUrl;
    try {
        imageUrl = (await media.uploadFile(input.sourcePath, {
            filename: input.fileName,
            mimeType: input.mimeType,
            forceRemoteUrl: true,
        })).signedUrl;
    }
    catch (error) {
        throw upstreamError(error, 'Image upload failed');
    }
    if (!imageUrl)
        throw upstreamError(undefined, 'Image upload failed');
    let response;
    try {
        response = await client.postJson(tool.path, { image_url: imageUrl }, input.signal, {
            timeoutMs: MATRIX_IMAGE_TOOL_TIMEOUT_MS,
        });
    }
    catch (error) {
        throw upstreamError(error, tool.failedMessage);
    }
    const outputUrl = readSuccessfulOutputUrl(response, tool);
    try {
        await media.downloadToFile(outputUrl, input.outputPath, {
            timeoutMs: MATRIX_IMAGE_TOOL_TIMEOUT_MS,
            ...(input.signal ? { signal: input.signal } : {}),
        });
    }
    catch (error) {
        throw upstreamError(error, tool.downloadFailedMessage);
    }
    const mimeType = stringOr(response.mime_type);
    return {
        ...(typeof response.width === 'number' ? { width: response.width } : {}),
        ...(typeof response.height === 'number' ? { height: response.height } : {}),
        ...(mimeType ? { mimeType } : {}),
    };
}
/**
 * Mirrors `callMatrixToolRaw`: the gateway reports failures either through
 * `base_resp.status_code` (the client folds a top-level `code` into it) or a payload
 * `code`. The message is the server's public text and is surfaced as-is.
 */
function readSuccessfulOutputUrl(response, tool) {
    const baseResp = typeof response.base_resp === 'object' ? (response.base_resp ?? {}) : {};
    const statusCode = integerOr(baseResp.status_code, 0) || integerOr(response.code, 0);
    if (statusCode !== 0) {
        const serverMessage = stringOr(baseResp.status_msg) ?? stringOr(response.message) ?? tool.failedMessage;
        throw new CanvasServiceError(errorCodeForStatus(statusCode), serverMessage, {
            upstreamCode: statusCode,
        });
    }
    const outputUrl = stringOr(response.output_url);
    if (!outputUrl) {
        throw new CanvasServiceError('UPSTREAM_FAILED', tool.emptyMessage);
    }
    return outputUrl;
}
function upstreamError(error, fallbackMessage) {
    if (error instanceof CanvasServiceError)
        return error;
    if (error instanceof DesktopGatewayHttpError) {
        return new CanvasServiceError(errorCodeForStatus(error.statusCode), fallbackMessage, {
            upstreamCode: error.statusCode,
        });
    }
    return new CanvasServiceError('UPSTREAM_FAILED', fallbackMessage, {
        cause: error instanceof Error ? error.message : String(error),
    });
}
function errorCodeForStatus(status) {
    switch (status) {
        case 400:
            return 'UNSUPPORTED_MEDIA';
        case 401:
            return 'AUTH_REQUIRED';
        case 402:
            return 'PAYMENT_REQUIRED';
        default:
            return 'UPSTREAM_FAILED';
    }
}
function integerOr(value, fallback) {
    return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}
function stringOr(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
//# sourceMappingURL=image-tools.client.js.map