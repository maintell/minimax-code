import { mapMarkdownOutsideProtected } from '@mavis/shared/asset-markup';
import { logger } from '../common/logger.js';
const DELIVER_ASSETS_RE = /<deliver-assets>([\s\S]*?)<\/deliver-assets>/gu;
const MEDIA_TAG_RE = /<media\s+([^>]*?)\s*\/>/gu;
const ATTRIBUTE_RE = /([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/gu;
const RUNTIME_OWNED_ATTRIBUTE_RE = /(?:^|\s+)(?:node_id|cover)\s*=\s*(?:"[^"]*"|'[^']*')/giu;
export function createWebsiteDeployAfterLlmHook(state) {
    return ({ message }) => {
        if (!state.isProjectionActive())
            return { type: 'continue' };
        const text = message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('');
        if (!text)
            return { type: 'continue' };
        const projected = projectWebsiteDeployText(text, state);
        logger.info({
            stage: 'website_deploy_projection',
            matched_count: projected.stats.matchedCount,
            candidate_node_id_match: projected.stats.candidateNodeIdMatch,
            trusted_node_id_present: projected.stats.trustedNodeIdPresent,
            cover_present: projected.stats.coverPresent,
            candidate_attributes_removed: projected.stats.candidateAttributesRemoved,
            stream_suppression_enabled: true,
        }, 'website deploy result projected');
        // Replace even when the visible text is otherwise unchanged: the raw stream was held back
        // after a successful Tool result, so every completed assistant message with text, including
        // text+toolCall, uses projected text in UI/history.
        return { type: 'replaceText', text: projected.text };
    };
}
export function projectWebsiteDeployText(text, state) {
    const stats = {
        matchedCount: 0,
        candidateNodeIdMatch: false,
        trustedNodeIdPresent: false,
        coverPresent: false,
        candidateAttributesRemoved: 0,
    };
    const projected = mapMarkdownOutsideProtected(text, (unprotected) => unprotected.replace(DELIVER_ASSETS_RE, (wrapper, body) => {
        const projectedBody = body.replace(MEDIA_TAG_RE, (mediaTag, rawAttributes) => {
            const attributes = parseXmlAttributes(rawAttributes);
            if (attributes.type !== 'website')
                return mediaTag;
            const ownedAttributes = rawAttributes.match(RUNTIME_OWNED_ATTRIBUTE_RE) ?? [];
            const cleanAttributes = rawAttributes.replace(RUNTIME_OWNED_ATTRIBUTE_RE, '').trim();
            const trusted = attributes.src ? state.resolveWebsite(attributes.src) : undefined;
            if (!trusted && ownedAttributes.length === 0)
                return mediaTag;
            stats.candidateAttributesRemoved += ownedAttributes.length;
            if (trusted) {
                stats.matchedCount += 1;
                if (trusted.nodeId) {
                    stats.trustedNodeIdPresent = true;
                    if (attributes.node_id === trusted.nodeId)
                        stats.candidateNodeIdMatch = true;
                }
                if (trusted.coverPath)
                    stats.coverPresent = true;
            }
            const runtimeAttributes = trusted
                ? [
                    trusted.nodeId ? ` node_id="${escapeXmlAttribute(trusted.nodeId)}"` : '',
                    trusted.coverPath ? ` cover="${escapeXmlAttribute(trusted.coverPath)}"` : '',
                ].join('')
                : '';
            return `<media${cleanAttributes ? ` ${cleanAttributes}` : ''}${runtimeAttributes} />`;
        });
        return projectedBody === body ? wrapper : `<deliver-assets>${projectedBody}</deliver-assets>`;
    }));
    return { text: projected, stats };
}
function parseXmlAttributes(raw) {
    const attributes = {};
    for (const match of raw.matchAll(ATTRIBUTE_RE)) {
        const name = match[1];
        const value = match[2];
        if (name !== undefined && value !== undefined)
            attributes[name] = decodeXmlAttribute(value);
    }
    return attributes;
}
function decodeXmlAttribute(value) {
    return value.replace(/&(quot|apos|#39|lt|gt|amp);/gu, (entity) => {
        switch (entity) {
            case '&quot;':
                return '"';
            case '&apos;':
            case '&#39;':
                return "'";
            case '&lt;':
                return '<';
            case '&gt;':
                return '>';
            case '&amp;':
                return '&';
            default:
                return entity;
        }
    });
}
function escapeXmlAttribute(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
//# sourceMappingURL=projector.js.map