import { logger } from '../common/logger.js';
/** Per-turn trust boundary: only the local website_deploy Tool can activate it. */
export class WebsiteDeployTurnState {
    deploymentsByUrl = new Map();
    isProjectionActive() {
        return this.deploymentsByUrl.size > 0;
    }
    recordSuccessfulToolResult(context) {
        if (context.toolCall.name !== 'website_deploy' || context.isError === true)
            return;
        const details = context.result?.details;
        if (!isRecord(details) || details.ok !== true)
            return;
        const websiteUrl = normalizeNonEmptyString(details.website_url);
        if (!websiteUrl)
            return;
        const nodeId = normalizeNonEmptyString(details.node_id);
        const coverPath = normalizeNonEmptyString(details.cover_path);
        this.deploymentsByUrl.set(normalizeWebsiteDeployUrl(websiteUrl), {
            websiteUrl,
            ...(nodeId ? { nodeId } : {}),
            ...(coverPath ? { coverPath } : {}),
        });
        // The tool result, rather than any model text, activates suppression. Missing optional
        // node/cover values still form a trusted URL boundary and must be projected safely.
        logger.info({
            stage: 'website_deploy_projection_state',
            trusted_node_id_present: Boolean(nodeId),
            cover_present: Boolean(coverPath),
            stream_suppression_enabled: true,
        }, 'website deploy projection state activated');
    }
    resolveWebsite(url) {
        return this.deploymentsByUrl.get(normalizeWebsiteDeployUrl(url));
    }
}
export function createWebsiteDeployAfterToolCallHook(state) {
    return (context) => {
        state.recordSuccessfulToolResult(context);
        return undefined;
    };
}
/** Only whitespace and an otherwise-root `/` differ for matching; no host/domain fuzzing. */
export function normalizeWebsiteDeployUrl(value) {
    return value.trim().replace(/^(https?:\/\/[^/?#]+)\/(?=$|[?#])/u, '$1');
}
function normalizeNonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=turn-state.js.map