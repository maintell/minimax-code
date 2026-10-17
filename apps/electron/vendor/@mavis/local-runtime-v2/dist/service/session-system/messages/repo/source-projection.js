import { and, eq, sql } from 'drizzle-orm';
import { sessionResources, sessionTurnResources, } from '../../../../infra/db/schema/session-resources.js';
const MAX_JSON_TEXT_LENGTH = 2_000_000;
const MAX_PARSE_DEPTH = 8;
const MAX_WEB_SOURCES = 100;
const CITATION_REFERENCES_KEY = 'citation_references';
const WEB_SOURCE_TOOL_NAMES = new Set([
    'web_search',
    'matrix_web_search',
    'mcp__matrix__web_search',
    'mcp:matrix:web_search',
    'connector__matrix__web_search',
    'web',
    'webfetch',
    'web_fetch',
]);
const PATH_FIELD_KEYS = new Set([
    'path',
    'file_path',
    'filePath',
    'location',
    'source_path',
    'sourcePath',
    'target_path',
    'targetPath',
]);
const PATH_LIST_FIELD_KEYS = new Set(['paths', 'file_paths', 'filePaths', 'locations']);
/**
 * Rebuild the durable source projection for one persisted display message.
 * The display message remains canonical; these tables are the indexed Session/Turn view.
 */
export function syncMessageSourceProjection(db, sessionId, message, nowMs) {
    db.delete(sessionTurnResources)
        .where(and(eq(sessionTurnResources.sessionId, sessionId), eq(sessionTurnResources.messageId, message.msgId)))
        .run();
    const projections = collectMessageSourceProjections(message.dataJson);
    if (projections.length === 0)
        return;
    let nextResourceIndex = (db
        .select({ value: sql `coalesce(max(${sessionResources.resourceIndex}), 0)` })
        .from(sessionResources)
        .where(eq(sessionResources.sessionId, sessionId))
        .get()?.value ?? 0) + 1;
    projections.forEach((projection, resourceOrdinal) => {
        const existing = db
            .select({
            resourceIndex: sessionResources.resourceIndex,
            resourceDataJson: sessionResources.resourceDataJson,
        })
            .from(sessionResources)
            .where(and(eq(sessionResources.sessionId, sessionId), eq(sessionResources.resourceType, projection.type), eq(sessionResources.resourceKey, projection.resourceKey)))
            .get();
        const resourceIndex = existing?.resourceIndex ?? nextResourceIndex++;
        const resourceData = mergeResourceData(existing?.resourceDataJson, projection);
        const resourceDataJson = JSON.stringify({ version: 1, ...resourceData });
        if (existing) {
            db.update(sessionResources)
                .set({ resourceDataJson, updatedAtMs: nowMs })
                .where(and(eq(sessionResources.sessionId, sessionId), eq(sessionResources.resourceIndex, resourceIndex)))
                .run();
        }
        else {
            db.insert(sessionResources)
                .values({
                sessionId,
                resourceIndex,
                resourceType: projection.type,
                sourceId: `${projection.type}:${String(resourceIndex)}`,
                resourceKey: projection.resourceKey,
                resourceDataJson,
                resourceDataVersion: 1,
                createdAtMs: message.createdAtMs,
                updatedAtMs: nowMs,
            })
                .run();
        }
        db.insert(sessionTurnResources)
            .values({
            sessionId,
            turnId: message.turnId ?? message.msgId,
            messageId: message.msgId,
            resourceIndex,
            resourceOrdinal,
            toolCallId: projection.toolCallId,
            createdAtMs: message.createdAtMs,
        })
            .run();
    });
}
function collectMessageSourceProjections(dataJson) {
    const message = parseRecord(dataJson);
    const directToolCalls = readDirectToolCalls(message);
    const partToolCalls = readPartToolCalls(message);
    const toolCalls = Array.from(new Map([...directToolCalls, ...partToolCalls].map((value, index) => {
        const toolCall = readRecord(value);
        const id = readString(toolCall?.id) ??
            readString(toolCall?.tool_call_id) ??
            readString(toolCall?.toolCallId) ??
            `tool-call-${String(index)}`;
        return [id, value];
    })).values());
    return toolCalls.flatMap((value, index) => collectToolCallProjections(value, index));
}
function readDirectToolCalls(message) {
    if (Array.isArray(message?.tool_calls))
        return message.tool_calls;
    if (Array.isArray(message?.toolCalls))
        return message.toolCalls;
    return [];
}
function readPartToolCalls(message) {
    if (!Array.isArray(message?.parts))
        return [];
    return message.parts.flatMap((value) => {
        const part = readRecord(value);
        if (part?.type !== 'tool_call')
            return [];
        if (part.tool_call !== undefined)
            return [part.tool_call];
        if (part.toolCall !== undefined)
            return [part.toolCall];
        return [];
    });
}
function collectToolCallProjections(value, toolCallIndex) {
    const toolCall = readRecord(value);
    if (!toolCall || isFailedToolCall(toolCall))
        return [];
    const toolCallId = readToolCallId(toolCall, toolCallIndex);
    const toolName = readToolName(toolCall);
    const input = toolCall.input ?? toolCall.tool_call_args ?? toolCall.toolCallArgs;
    const result = parseJsonValue(toolCall.result ?? toolCall.tool_call_result_data ?? toolCall.toolCallResultData);
    const projections = new Map();
    const context = { toolName, toolCallId, output: projections };
    collectReferenceProjections(result, context);
    collectWebProjections(result, input, context);
    collectFileProjections(input, context);
    return Array.from(projections.values());
}
function readToolCallId(toolCall, index) {
    return (readString(toolCall.id) ??
        readString(toolCall.tool_call_id) ??
        readString(toolCall.toolCallId) ??
        `tool-call-${String(index)}`);
}
function readToolName(toolCall) {
    return (readString(toolCall.name) ??
        readString(toolCall.tool_name) ??
        readString(toolCall.toolName) ??
        '');
}
function collectReferenceProjections(result, context) {
    const details = readRecord(readRecord(result)?.details);
    const references = Array.isArray(details?.source_references) ? details.source_references : [];
    references.forEach((referenceValue) => {
        const reference = readRecord(referenceValue);
        const type = normalizeResourceType(readString(reference?.type));
        const originalSourceId = readString(reference?.source_id);
        const name = readString(reference?.name);
        if (!reference || !type || !originalSourceId || !name)
            return;
        const data = {
            type,
            name,
            original_source_id: originalSourceId,
            tool_name: readString(reference.tool_name) ?? context.toolName,
        };
        copyOptionalString(reference, data, 'provider');
        copyOptionalString(reference, data, 'icon_url');
        copyOptionalString(reference, data, 'citation_id');
        copyOptionalStringArray(reference, data, 'citation_aliases');
        copyOptionalString(reference, data, 'citation_mode');
        copyOptionalString(reference, data, 'result_path');
        copyOptionalString(reference, data, 'url');
        copyOptionalString(reference, data, 'path');
        let resourceKey = originalSourceId;
        if (type === 'web')
            resourceKey = readString(reference.url) ?? originalSourceId;
        if (type === 'file')
            resourceKey = readString(reference.path) ?? originalSourceId;
        context.output.set(`${type}\u0000${resourceKey}`, {
            type,
            resourceKey,
            toolCallId: context.toolCallId,
            data,
        });
    });
}
function copyOptionalString(source, target, key) {
    const value = readString(source[key]);
    if (value)
        target[key] = value;
}
function copyOptionalStringArray(source, target, key) {
    const value = Array.isArray(source[key])
        ? source[key].map(readString).filter((entry) => Boolean(entry))
        : [];
    if (value.length > 0)
        target[key] = Array.from(new Set(value));
}
function mergeResourceData(existingJson, projection) {
    if (projection.type !== 'app' && projection.type !== 'mcp')
        return projection.data;
    const existing = existingJson ? parseRecord(existingJson) : undefined;
    const existingCitations = readCitationReferences(existing?.[CITATION_REFERENCES_KEY]);
    const currentCitation = citationReferenceForProjection(projection);
    const citationReferences = mergeCitationReferences(existingCitations, currentCitation);
    if (citationReferences.length === 0)
        return projection.data;
    return { ...projection.data, [CITATION_REFERENCES_KEY]: citationReferences };
}
function citationReferenceForProjection(projection) {
    if (!projection.toolCallId)
        return undefined;
    const citationId = readString(projection.data.citation_id);
    const citationAliases = readStringArray(projection.data.citation_aliases);
    if (!citationId && citationAliases.length === 0)
        return undefined;
    return {
        tool_call_id: projection.toolCallId,
        ...(citationId ? { citation_id: citationId } : {}),
        ...(citationAliases.length > 0 ? { citation_aliases: citationAliases } : {}),
    };
}
function mergeCitationReferences(existing, current) {
    const merged = new Map();
    existing.forEach((reference) => {
        const toolCallId = readString(reference.tool_call_id) ?? readString(reference.toolCallId);
        if (toolCallId)
            merged.set(toolCallId, reference);
    });
    const currentToolCallId = readString(current?.tool_call_id);
    if (current && currentToolCallId)
        merged.set(currentToolCallId, current);
    return Array.from(merged.values());
}
function readCitationReferences(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((entry) => {
        const reference = readRecord(entry);
        return reference && (readString(reference.tool_call_id) ?? readString(reference.toolCallId))
            ? [reference]
            : [];
    });
}
function collectWebProjections(result, input, context) {
    const isWebTool = isWebSourceTool(context.toolName, input);
    const structuredResults = collectStructuredWebResults(result);
    if (!isWebTool && structuredResults.length === 0)
        return;
    const webSources = isWebTool ? collectWebSources(result) : structuredResults;
    const inputUrl = webSources.length === 0 ? readInputWebUrl(input) : undefined;
    if (inputUrl)
        webSources.push({ title: new URL(inputUrl).hostname, url: inputUrl });
    webSources.forEach((source) => {
        const key = `web\u0000${source.url}`;
        // Explicit references preserve the fetched title/icon and canonical metadata.
        // Generic URL extraction is a fallback, not a replacement for that evidence.
        if (context.output.has(key))
            return;
        context.output.set(key, {
            type: 'web',
            resourceKey: source.url,
            toolCallId: context.toolCallId,
            data: { type: 'web', name: source.title, url: source.url, tool_name: context.toolName },
        });
    });
}
function readInputWebUrl(input) {
    const inputRecord = readRecord(parseJsonValue(input));
    const nestedInput = readRecord(parseJsonValue(inputRecord?.arguments)) ??
        readRecord(parseJsonValue(inputRecord?.args)) ??
        readRecord(parseJsonValue(inputRecord?.parameters));
    return safeHttpUrl(readString(inputRecord?.url) ??
        readString(inputRecord?.href) ??
        readString(inputRecord?.link) ??
        readString(nestedInput?.url) ??
        readString(nestedInput?.href) ??
        readString(nestedInput?.link));
}
function collectFileProjections(input, context) {
    if (!isFileSourceTool(context.toolName))
        return;
    collectStructuredPaths(input).forEach((path) => {
        const key = `file\u0000${path}`;
        if (context.output.has(key))
            return;
        context.output.set(key, {
            type: 'file',
            resourceKey: path,
            toolCallId: context.toolCallId,
            data: { type: 'file', name: fileName(path), path, tool_name: context.toolName },
        });
    });
}
function normalizeResourceType(value) {
    if (value === 'web' || value === 'mcp' || value === 'app' || value === 'file')
        return value;
    return value === 'web_search' || value === 'web_fetch' ? 'web' : undefined;
}
function isFailedToolCall(toolCall) {
    const status = readString(toolCall.status)?.toLowerCase();
    return status === 'error' || status === 'failed' || Boolean(toolCall.error);
}
function isWebSourceTool(toolName, inputValue) {
    if (isWebSourceToolName(normalizeToolName(toolName)))
        return true;
    const input = readRecord(parseJsonValue(inputValue));
    const nestedName = readString(input?.tool) ?? readString(input?.tool_name) ?? readString(input?.toolName);
    return nestedName ? isWebSourceToolName(normalizeToolName(nestedName)) : false;
}
function isWebSourceToolName(value) {
    return (WEB_SOURCE_TOOL_NAMES.has(value) ||
        value.endsWith('__web_search') ||
        value.endsWith('__web_fetch'));
}
function isFileSourceTool(toolName) {
    const normalized = normalizeToolName(toolName);
    return normalized === 'read' || normalized === 'read_file';
}
function normalizeToolName(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/gu, '_');
}
function collectWebSources(value) {
    const collected = [];
    collectWebSourcesInto(value, collected, new Set(), 0);
    const deduped = new Map();
    collected.forEach((source) => {
        if (!deduped.has(source.url))
            deduped.set(source.url, source);
    });
    return Array.from(deduped.values());
}
function collectWebSourcesInto(value, output, visited, depth) {
    if (depth > MAX_PARSE_DEPTH || output.length >= MAX_WEB_SOURCES)
        return;
    const parsed = parseJsonValue(value);
    if (Array.isArray(parsed)) {
        collectWebSourcesFromArray(parsed, output, visited, depth);
        return;
    }
    const record = readRecord(parsed);
    if (!record || visited.has(record))
        return;
    collectWebSourcesFromRecord(record, output, visited, depth);
}
function collectWebSourcesFromArray(values, output, visited, depth) {
    if (visited.has(values))
        return;
    visited.add(values);
    values.forEach((entry) => collectWebSourcesInto(entry, output, visited, depth + 1));
}
function collectWebSourcesFromRecord(record, output, visited, depth) {
    visited.add(record);
    const url = safeHttpUrl(readString(record.url) ?? readString(record.href) ?? readString(record.link));
    if (url) {
        output.push({
            title: readString(record.title) ??
                readString(record.page_title) ??
                readString(record.name) ??
                new URL(url).hostname,
            url,
        });
        // A result record is a source leaf. Page content can contain navigation,
        // recommendations, and other unrelated URLs that must not become sources.
        return;
    }
    Object.values(record).forEach((entry) => collectWebSourcesInto(entry, output, visited, depth + 1));
}
function collectStructuredWebResults(value) {
    const record = readRecord(parseJsonValue(value));
    return record && Array.isArray(record.results) ? collectWebSources(record.results) : [];
}
function collectStructuredPaths(value) {
    const paths = [];
    collectStructuredPathsInto(parseJsonValue(value), paths);
    return Array.from(new Set(paths));
}
function collectStructuredPathsInto(value, output) {
    if (Array.isArray(value)) {
        value.forEach((entry) => collectStructuredPathsInto(entry, output));
        return;
    }
    const record = readRecord(value);
    if (!record)
        return;
    Object.entries(record).forEach(([key, entry]) => {
        if (PATH_FIELD_KEYS.has(key) && typeof entry === 'string' && entry.trim()) {
            output.push(entry.trim());
        }
        else if (PATH_LIST_FIELD_KEYS.has(key) && Array.isArray(entry)) {
            entry.forEach((path) => {
                if (typeof path === 'string' && path.trim())
                    output.push(path.trim());
            });
        }
        else {
            collectStructuredPathsInto(parseJsonValue(entry), output);
        }
    });
}
function fileName(path) {
    return path.replace(/\\/gu, '/').split('/').filter(Boolean).at(-1) ?? path;
}
function safeHttpUrl(value) {
    if (!value)
        return undefined;
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            return undefined;
        parsed.hash = '';
        return parsed.href;
    }
    catch {
        return undefined;
    }
}
function parseRecord(value) {
    try {
        return readRecord(JSON.parse(value));
    }
    catch {
        return undefined;
    }
}
function parseJsonValue(value) {
    if (typeof value !== 'string')
        return value;
    const text = value.trim();
    if (!text ||
        text.length > MAX_JSON_TEXT_LENGTH ||
        (!text.startsWith('{') && !text.startsWith('['))) {
        return value;
    }
    try {
        return JSON.parse(text);
    }
    catch {
        return value;
    }
}
function readRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function readString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function readStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return Array.from(new Set(value.map(readString).filter((entry) => Boolean(entry))));
}
//# sourceMappingURL=source-projection.js.map