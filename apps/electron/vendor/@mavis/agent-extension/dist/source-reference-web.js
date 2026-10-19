import { collectFetchedWebSources, collectWebSourceCitations, } from '@mavis/agent-runtime';
import { escapeMarkdownLabel, invokedToolName, normalizeToolName, parseMcpToolName, readNonEmptyString, readRecord, safeHttpUrl, } from './source-reference-utils.js';
export function renderWebFetchSourceMarker(reference) {
    return `Final URL: [${escapeMarkdownLabel(reference.name)}](${reference.url})`;
}
export function webSourceReferencesForToolResult(input, directReference = webFetchSourceReferenceForToolResult(input)) {
    if (directReference) {
        const references = collectFetchedWebSources(directReference, input.result.content);
        return { references, markerReferences: references.slice(0, 1) };
    }
    const isKnownWebSearch = isWebSearchToolCall(input.toolName, input.args);
    return {
        references: collectWebSourceCitations(input.result, isKnownWebSearch ? {} : { includeText: false, requireSourceMetadata: true }),
        markerReferences: [],
    };
}
export function webFetchSourceReferenceForToolResult(input) {
    const details = readRecord(input.result.details);
    if (details?.ok === false)
        return undefined;
    const args = readRecord(input.args);
    const nestedArgs = readRecord(args?.arguments) ?? readRecord(args?.args);
    const resultUrl = safeHttpUrl(readNonEmptyString(details?.final_url) ??
        readNonEmptyString(details?.finalUrl) ??
        readNonEmptyString(details?.url));
    const argumentUrl = safeHttpUrl(readNonEmptyString(args?.url) ??
        readNonEmptyString(args?.href) ??
        readNonEmptyString(args?.link) ??
        readNonEmptyString(nestedArgs?.url) ??
        readNonEmptyString(nestedArgs?.href) ??
        readNonEmptyString(nestedArgs?.link));
    const url = resultUrl ??
        (isExplicitWebSourceToolCall(input.toolName, input.args) ? argumentUrl : undefined);
    if (!url)
        return undefined;
    return {
        name: preferredWebSourceName(url, [
            readNonEmptyString(args?.title),
            readNonEmptyString(args?.name),
            readNonEmptyString(args?.label),
            readNonEmptyString(nestedArgs?.title),
            readNonEmptyString(nestedArgs?.name),
            readNonEmptyString(nestedArgs?.label),
            readNonEmptyString(details?.source_title),
            readNonEmptyString(details?.sourceTitle),
            readNonEmptyString(details?.name),
            readNonEmptyString(details?.label),
        ], [
            readNonEmptyString(details?.title),
            readNonEmptyString(details?.page_title),
            readNonEmptyString(details?.pageTitle),
            readWebDocumentTitle(input.result.content),
        ]),
        url,
    };
}
function preferredWebSourceName(url, semanticTitles, documentTitles) {
    return ([...semanticTitles, ...documentTitles].find((title) => typeof title === 'string' && !isFallbackWebSourceTitle(title, url)) ?? url);
}
function isFallbackWebSourceTitle(title, url) {
    if (safeHttpUrl(title) === url)
        return true;
    const hostname = new URL(url).hostname.toLowerCase();
    const normalizedTitle = title
        .toLowerCase()
        .replace(/^https?:\/\//u, '')
        .replace(/\/$/u, '');
    return normalizedTitle === hostname || normalizedTitle === hostname.replace(/^www\./u, '');
}
export function persistedWebReference(input, reference) {
    return {
        version: 1,
        type: 'web',
        source_id: `web:${Buffer.from(reference.url, 'utf8').toString('base64url')}`,
        name: reference.name,
        url: reference.url,
        ...(reference.favicon ? { icon_url: reference.favicon } : {}),
        tool_call_id: input.toolCallId,
        tool_name: invokedToolName(input.args) ?? input.toolName,
        result_path: '$',
    };
}
function isWebSearchToolCall(toolName, args) {
    const candidates = [toolName, invokedToolName(args)]
        .filter((value) => Boolean(value))
        .map(normalizeToolName);
    return candidates.some((name) => name === 'web' || name === 'web_search' || name.endsWith('__web_search'));
}
export function isExplicitWebSourceToolCall(toolName, args) {
    return [toolName, invokedToolName(args)]
        .filter((value) => Boolean(value))
        .map(normalizeToolName)
        .some((name) => name === 'web_search' ||
        name === 'web_fetch' ||
        name === 'webfetch' ||
        name.endsWith('__web_search') ||
        name.endsWith('__web_fetch'));
}
/**
 * A platform WebSearch may include companion App metadata (for example, a
 * result-enrichment provider). That metadata must not suppress the distinct
 * public Web result sources. Connector-owned `*_web_search` methods remain
 * App-only, because their returned homepage or asset URL is not WebSearch
 * provenance.
 */
export function isPlatformWebSourceToolCall(toolName, args) {
    return [toolName, invokedToolName(args)].some((value) => {
        if (!value)
            return false;
        const normalized = normalizeToolName(value);
        if (normalized === 'web_search' || normalized === 'web_fetch' || normalized === 'webfetch') {
            return true;
        }
        const mcp = parseMcpToolName(value);
        return (normalizeToolName(mcp?.server ?? '') === 'matrix' &&
            (normalizeToolName(mcp?.tool ?? '') === 'web_search' ||
                normalizeToolName(mcp?.tool ?? '') === 'web_fetch'));
    });
}
export function readToolResultText(content) {
    return content
        .map((block) => readRecord(block))
        .map((block) => (block?.type === 'text' ? readNonEmptyString(block.text) : undefined))
        .filter((value) => Boolean(value))
        .join('\n');
}
function readWebDocumentTitle(content) {
    const text = readToolResultText(content);
    const htmlTitle = /<title[^>]*>\s*([^<]{2,120})\s*<\/title>/iu.exec(text)?.[1]?.trim();
    if (htmlTitle)
        return htmlTitle;
    const markdownHeading = /^#{1,2}\s+(.{2,120})$/mu.exec(text)?.[1]?.trim();
    return markdownHeading || undefined;
}
//# sourceMappingURL=source-reference-web.js.map