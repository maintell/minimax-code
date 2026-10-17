import { createHash } from 'node:crypto';
import nodePath from 'node:path';
import { createSourceReferenceMarkerBlock } from './source-reference-marker.js';
import { buildToolCallCitationId, collapseAdjacentDuplicateFileCitations, collectUsedWebEvidenceIds, resolveKnownCitationAlias, } from '@mavis/agent-runtime';
import { filePathsMatch, generatedFilePathsForToolCall, isGeneratedFileReference, isTemporaryOrInternalFilePath, knownFileReferencesUsedByShellCommand, normalizeFilePath, recordGeneratedFilePaths, registeredAssetPathsFromShellCommand, workspaceFilePathsFromShellCommand, } from './source-reference-files.js';
import { escapeMarkdownLabel, invokedToolName, normalizeToolName, parseMcpToolName, readNonEmptyString, readRecord, safeHttpUrl, } from './source-reference-utils.js';
import { isExplicitWebSourceToolCall, isPlatformWebSourceToolCall, persistedWebReference, readToolResultText, renderWebFetchSourceMarker, webFetchSourceReferenceForToolResult, webSourceReferencesForToolResult, } from './source-reference-web.js';
export const SOURCE_REFERENCE_DETAILS_KEY = 'source_references';
export const SOURCE_REFERENCE_MARKER_TAG = 'source_reference';
const CODE_FILE_EXTENSION_RE = /\.(?:astro|bash|bat|c|cc|cjs|clj|cljs|cljc|cmd|cpp|cs|css|cts|cxx|dart|elm|erl|ex|exs|fish|fs|fsi|fsx|go|gradle|groovy|h|handlebars|hbs|hcl|hh|hpp|hrl|htm|html|java|jl|js|json|jsx|kt|kts|less|lua|m|mjs|mm|mts|nim|php|pl|pm|proto|ps1|py|pyi|r|rb|rs|sass|scala|scss|sh|sol|sql|svelte|swift|tf|thrift|toml|ts|tsx|vb|vbs|vue|xml|yaml|yml|zig|zsh)$/iu;
const CODE_FILE_BASENAME_RE = /(?:^|[\\/])(?:cmakelists\.txt|dockerfile|gemfile|jenkinsfile|makefile|rakefile)$/iu;
const MAX_SOURCE_EVIDENCE_CHARS = 200_000;
const MAX_HISTORICAL_FILE_REFERENCES = 32;
const MAX_HISTORICAL_MESSAGES = 200;
/**
 * Standardizes provenance after a tool has completed. The normalized metadata
 * stays in ToolResult.details for durable access-history reconstruction. Every
 * WebSearch results already contain their exact URLs, so they are persisted
 * without duplicating every result into an extra model-visible marker. WebFetch
 * alone receives one compact final-URL marker because redirects can make that
 * URL unavailable in the original ToolResult. Safe legacy links and malformed
 * File tags are normalized deterministically. App/MCP candidates use a
 * target-only marker plus a six-character, per-turn hash; the hash is expanded
 * back to the canonical ID before validation. If a terminal answer
 * demonstrably reuses App/MCP/File/Web evidence but omits its candidate reference,
 * one bounded model retry asks for a citation-correct version; unused source
 * access remains history only.
 */
export function sourceReferenceExtension(options = {}) {
    const adapters = options.adapters ?? [
        mcpSourceAdapter,
        appSourceAdapter,
        createFileSourceAdapter(options.resolveFileSourcePath),
    ];
    const turnSources = new Map();
    const afterToolCall = (toolContext, _signal, turnCtx) => {
        if (toolContext.isError)
            return undefined;
        const state = sourceStateFor(turnSources, turnCtx);
        const adapterInput = {
            toolCallId: toolContext.toolCall.id,
            toolName: toolContext.toolCall.name,
            args: toolContext.args,
            result: toolContext.result,
            isError: toolContext.isError,
            turn: turnCtx,
        };
        recordGeneratedFilePaths(state, generatedFilePathsForToolCall(adapterInput));
        const adaptedReferences = adapters.flatMap((adapter) => {
            const adapted = adapter.adapt(adapterInput);
            const adapterReferences = Array.isArray(adapted) ? adapted : adapted ? [adapted] : [];
            return adapterReferences
                .map((reference) => withCallCitationId(reference))
                .filter((reference) => !isGeneratedFileReference(reference, state.generatedFilePaths));
        });
        const reusedFileReferences = knownFileReferencesUsedByShellCommand(adapterInput, state.references.values()).filter((reference) => !isGeneratedFileReference(reference, state.generatedFilePaths));
        const references = Array.from(new Map([...adaptedReferences, ...reusedFileReferences].map((reference) => [
            citationIdFor(reference),
            reference,
        ])).values());
        const hasAppReference = references.some((reference) => reference.type === 'app');
        // A successful fetch result is identified by the HTTP(S) URL it reports,
        // not by a particular runtime/tool wrapper name. Explicit App metadata
        // remains authoritative for connector-owned results.
        const directWebReference = hasAppReference
            ? undefined
            : webFetchSourceReferenceForToolResult(adapterInput);
        const { references: webReferences, markerReferences: webMarkerReferences } = directWebReference ||
            references.length === 0 ||
            (!hasAppReference && isExplicitWebSourceToolCall(adapterInput.toolName, adapterInput.args)) ||
            isPlatformWebSourceToolCall(adapterInput.toolName, adapterInput.args)
            ? webSourceReferencesForToolResult(adapterInput, directWebReference)
            : { references: [], markerReferences: [] };
        const persistedWebReferences = webReferences.map((reference) => persistedWebReference(adapterInput, reference));
        if (references.length === 0 && webReferences.length === 0)
            return undefined;
        const modelReferences = references.map((reference) => withModelCitationAlias(reference, state));
        const persistedReferences = [...modelReferences, ...persistedWebReferences];
        const details = persistedReferences.length > 0
            ? mergeSourceReferenceDetails(toolContext.result.details, persistedReferences)
            : toolContext.result.details;
        const evidence = readToolResultText(toolContext.result.content);
        for (const reference of modelReferences) {
            const citationId = citationIdFor(reference);
            state.references.set(citationId, reference);
            state.evidence.set(citationId, appendEvidence(state.evidence.get(citationId), evidence));
        }
        persistedWebReferences.forEach((webReference, index) => {
            const citationId = citationIdFor(webReference);
            const webEvidence = webReferences[index]?.evidence ?? evidence;
            state.references.set(citationId, webReference);
            state.evidence.set(citationId, appendEvidence(state.evidence.get(citationId), webEvidence));
        });
        const markerText = [
            ...modelReferences.map((reference) => renderSourceReferenceMarker(reference, state)),
            ...webMarkerReferences.map(renderWebFetchSourceMarker),
        ]
            .filter((marker) => Boolean(marker))
            .join('\n');
        return {
            ...(markerText
                ? {
                    content: [
                        ...toolContext.result.content,
                        createSourceReferenceMarkerBlock(`\n${markerText}\n`),
                    ],
                }
                : {}),
            details,
        };
    };
    const afterLlmCall = (event, turnCtx) => {
        if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') {
            return undefined;
        }
        if (event.message.content.some((block) => block.type === 'toolCall'))
            return undefined;
        const text = readAssistantText(event.message.content);
        if (!text.trim())
            return undefined;
        // Review owns validation/retries and file targets for these protocol documents.
        // Citation rewriting must not mutate their attributes or retry a finalized review.
        if (/<\s*(?:annotation-result|review-candidates|review-candidate-corrections)(?=[\s/>])/iu.test(text)) {
            return undefined;
        }
        const state = sourceStateFor(turnSources, turnCtx);
        if (state?.retryAttempted && isCitationRetryPromptLeak(text)) {
            const fallback = restoreMissingAssetMarkup(state.retryDraft, state.retryAssetMarkup);
            return fallback === text ? undefined : { type: 'replaceText', text: fallback };
        }
        const retrySafeText = state?.retryAttempted
            ? restoreMissingAssetMarkup(text, state.retryAssetMarkup)
            : text;
        const safeSourceText = removeDisallowedFileCitations(retrySafeText);
        if (!state) {
            return safeSourceText === text ? undefined : { type: 'replaceText', text: safeSourceText };
        }
        const allReferences = Array.from(state.references.values());
        const normalizedCitationTags = normalizeMisclassifiedSourceFilePathTags(normalizeFilePathCitationTags(safeSourceText, allReferences), allReferences, state.evidence);
        const normalizedSourceText = removeUnbackedFileCitations(normalizeFileCitationLabels(normalizeBareToolSourceLines(normalizeExplicitSourceLinks(normalizedCitationTags, allReferences.filter((reference) => reference.type === 'app' || reference.type === 'mcp'), state.evidence, state.citationIdsByAlias)), allReferences), allReferences);
        const sectionDeduplicatedText = state.retryAttempted
            ? collapseRepeatedCitationTargetsByMarkdownSection(normalizedSourceText, allReferences)
            : normalizedSourceText;
        const projectedSourceText = collapseRepeatedPresentedSourceLists(sectionDeduplicatedText, allReferences);
        const usedWebEvidenceIds = collectUsedWebEvidenceIds(projectedSourceText, state.evidence);
        const usedSources = allReferences.filter((reference) => {
            const citationId = citationIdFor(reference);
            if (reference.type === 'web')
                return usedWebEvidenceIds.has(citationId);
            return answerUsesReferenceEvidence(reference, projectedSourceText, state.evidence.get(citationId) ?? '', competingEvidenceForReference(reference, allReferences, state.evidence), allReferences);
        });
        const normalizedText = collapseAdjacentDuplicateFileCitations(normalizeFileCitationLineAddresses(localizeMentionedFileCitations(unwrapSyntheticFileMentionMarkdownLinks(projectedSourceText, usedSources), usedSources), usedSources));
        // Missing citations are repaired only for positively identified usage.
        // Returning search candidates does not mean the answer adopted them.
        const citationRequiredSources = usedSources;
        const missingUsedSources = citationRequiredSources.filter((reference) => !answerCitesReference(normalizedText, reference));
        const webBackfilledText = appendMissingWebSourceSummary(normalizedText, missingUsedSources);
        const sourcesStillMissing = citationRequiredSources.filter((reference) => !answerCitesReference(webBackfilledText, reference));
        if (sourcesStillMissing.length > 0 && !state.retryAttempted) {
            state.retryAttempted = true;
            state.retryAssetMarkup = collectAssetMarkupSegments(webBackfilledText);
            state.retryDraft = webBackfilledText;
            return {
                type: 'retry',
                reason: 'missing_source_citation',
                prompt: buildCitationRetryPrompt(sourcesStillMissing, webBackfilledText, state),
            };
        }
        return webBackfilledText === text
            ? undefined
            : { type: 'replaceText', text: webBackfilledText };
    };
    return {
        id: options.id ?? 'source-reference',
        description: options.description ??
            'Standardize source history and validate evidence-backed App/MCP/File/Web citations.',
        init(api) {
            api.on('after_tool_call', afterToolCall);
            api.on('after_llm_call', afterLlmCall);
            api.on('turn_end', (_event, turnCtx) => {
                turnSources.delete(turnKey(turnCtx));
            });
        },
    };
}
export const mcpSourceAdapter = {
    id: 'mcp',
    adapt(input) {
        const details = readRecord(input.result.details);
        const invokedName = invokedToolName(input.args);
        const parsed = parseMcpToolName(input.toolName) ?? (invokedName ? parseMcpToolName(invokedName) : undefined);
        if (details?.mcp === undefined && !parsed)
            return null;
        const rawServer = readNonEmptyString(details?.server) ?? parsed?.server;
        const tool = readNonEmptyString(details?.tool) ?? parsed?.tool ?? invokedToolName(input.args);
        if (!rawServer || isWebSearchMcp(rawServer, tool, input.toolName, input.args))
            return null;
        const server = canonicalMcpServerName(rawServer);
        return {
            version: 1,
            type: 'mcp',
            source_id: `mcp:${Buffer.from(server, 'utf8').toString('base64url')}`,
            name: server,
            ...(rawServer === server ? {} : { provider: rawServer }),
            tool_call_id: input.toolCallId,
            tool_name: tool ?? input.toolName,
            result_path: details?.mcp === undefined ? '$' : 'details.mcp',
        };
    },
};
export const fileSourceAdapter = createFileSourceAdapter();
export const appSourceAdapter = {
    id: 'app',
    adapt(input) {
        const details = readRecord(input.result.details);
        if (details?.kind === 'skill')
            return null;
        const app = readRecord(details?.app);
        const invokedName = invokedToolName(input.args);
        const connector = parseConnectorToolName(input.toolName) ??
            (invokedName ? parseConnectorToolName(invokedName) : undefined);
        const provider = readNonEmptyString(app?.provider) ?? connector?.provider;
        if (!provider)
            return null;
        if (normalizeToolName(provider) === 'matrix')
            return null;
        const name = readNonEmptyString(app?.display_name) ?? provider;
        const iconUrl = readNonEmptyString(app?.icon_url);
        const tool = readNonEmptyString(app?.tool) ?? connector?.tool ?? input.toolName;
        return {
            version: 1,
            type: 'app',
            source_id: `app:${Buffer.from(provider, 'utf8').toString('base64url')}`,
            name,
            provider,
            ...(iconUrl ? { icon_url: iconUrl } : {}),
            tool_call_id: input.toolCallId,
            tool_name: tool,
            result_path: 'content.0.text',
        };
    },
};
function parseConnectorToolName(value) {
    const match = /^connector__(.+?)__(.+)$/u.exec(value.trim());
    const provider = match?.[1]?.trim();
    const tool = match?.[2]?.trim();
    return provider && tool ? { provider, tool } : undefined;
}
function mergeSourceReferenceDetails(details, references) {
    const record = readRecord(details);
    const base = record ?? (details === undefined ? {} : { original_details: details });
    const existing = Array.isArray(base[SOURCE_REFERENCE_DETAILS_KEY])
        ? base[SOURCE_REFERENCE_DETAILS_KEY]
        : [];
    return {
        ...base,
        [SOURCE_REFERENCE_DETAILS_KEY]: [...existing, ...references],
    };
}
function renderSourceReferenceMarker(reference, citationAliasState) {
    if (reference.type === 'file' && reference.path) {
        if (reference.citation_mode === 'implicit')
            return undefined;
        return `Citation candidate: [${escapeMarkdownLabel(reference.name)}](${sourceReferenceHref(citationIdFor(reference))})`;
    }
    const citationId = citationIdFor(reference);
    const modelCitationId = reference.type === 'app' || reference.type === 'mcp'
        ? shortCitationIdFor(citationId, citationAliasState)
        : citationId;
    return `Citation candidate: #mavis-source=${modelCitationId}`;
}
function withModelCitationAlias(reference, citationAliasState) {
    if (reference.type !== 'app' && reference.type !== 'mcp')
        return reference;
    const citationId = citationIdFor(reference);
    const alias = shortCitationIdFor(citationId, citationAliasState);
    const aliases = Array.from(new Set([...(reference.citation_aliases ?? []), alias]));
    for (const existingAlias of reference.citation_aliases ?? []) {
        const normalizedAlias = existingAlias.trim().toLowerCase();
        if (!normalizedAlias)
            continue;
        if (!citationAliasState.citationIdsByAlias.has(normalizedAlias)) {
            citationAliasState.citationIdsByAlias.set(normalizedAlias, citationId);
        }
    }
    return { ...reference, citation_aliases: aliases };
}
const SHORT_CITATION_ID_LENGTH = 6;
/**
 * Return a compact, collision-safe ID for the model while retaining the full
 * citation ID in the durable source reference and in the rendered answer.
 * Aliases are scoped to one turn, so a six-character hash is sufficient for
 * the model-facing candidate; the selected alias is also retained in source
 * metadata so the UI can resolve a short link after the turn is complete.
 */
function shortCitationIdFor(citationId, state) {
    const existing = state.citationAliases.get(citationId);
    if (existing)
        return existing;
    for (let attempt = 0;; attempt += 1) {
        const seed = attempt === 0 ? citationId : `${citationId}\u0000${String(attempt)}`;
        const candidate = createHash('sha256')
            .update(seed, 'utf8')
            .digest('hex')
            .slice(0, SHORT_CITATION_ID_LENGTH);
        const owner = state.citationIdsByAlias.get(candidate);
        if (!owner || owner === citationId) {
            state.citationAliases.set(citationId, candidate);
            state.citationIdsByAlias.set(candidate, citationId);
            return candidate;
        }
    }
}
function withCallCitationId(reference) {
    if (reference.citation_id || (reference.type !== 'app' && reference.type !== 'mcp')) {
        return reference;
    }
    return {
        ...reference,
        citation_id: buildToolCallCitationId(reference.source_id, reference.tool_call_id),
    };
}
function citationIdFor(reference) {
    return reference.citation_id ?? reference.source_id;
}
function isWebSearchMcp(server, tool, runtimeToolName, args) {
    const invokedName = invokedToolName(args);
    const candidates = [server, tool, runtimeToolName, invokedName]
        .filter((value) => Boolean(value))
        .map(normalizeToolName);
    const isWebSearchTool = candidates.some((candidate) => candidate === 'web_search' ||
        candidate.endsWith('__web_search') ||
        candidate === 'web_fetch' ||
        candidate.endsWith('__web_fetch'));
    return isWebSearchTool && candidates.some((candidate) => candidate.includes('matrix'));
}
function canonicalMcpServerName(value) {
    return value.replace(/_h[0-9a-f]{16,}$/iu, '').replaceAll('_', '-');
}
function isFileReadToolCall(value) {
    const normalized = normalizeToolName(value);
    return normalized === 'read' || normalized === 'read_file';
}
function createFileSourceAdapter(resolveFileSourcePath) {
    return {
        id: 'file',
        adapt(input) {
            return fileSourcePaths(input, resolveFileSourcePath).map(({ path, name, resultPath, citationMode }) => ({
                version: 1,
                type: 'file',
                source_id: `file:${Buffer.from(normalizeFilePath(path), 'utf8').toString('base64url')}`,
                name: name ?? fileDisplayName(path),
                tool_call_id: input.toolCallId,
                tool_name: input.toolName,
                result_path: resultPath ?? '$',
                path,
                ...(citationMode ? { citation_mode: citationMode } : {}),
            }));
        },
    };
}
function fileSourcePaths(input, resolveFileSourcePath) {
    const args = readRecord(input.args);
    const toolName = input.toolName;
    const readPath = isFileReadToolCall(toolName)
        ? (readNonEmptyString(args?.path) ?? readNonEmptyString(args?.file_path))
        : undefined;
    const command = normalizeToolName(toolName) === 'bash' ? (readNonEmptyString(args?.command) ?? '') : '';
    const registeredAssetPaths = command ? registeredAssetPathsFromShellCommand(command) : [];
    const resolvableShellPaths = command && resolveFileSourcePath
        ? workspaceFilePathsFromShellCommand(command, input.turn.workspaceDir)
        : [];
    const diffResultPaths = command && resolveFileSourcePath ? codeFilePathsFromDiffResult(input, command) : [];
    const candidates = [
        ...(readPath
            ? [
                {
                    path: readPath,
                    requiresResolution: false,
                    resultPath: '$',
                    citationMode: undefined,
                    origin: 'tool-argument',
                },
            ]
            : []),
        ...registeredAssetPaths.map((path) => ({
            path,
            requiresResolution: false,
            resultPath: '$',
            citationMode: undefined,
            origin: 'tool-argument',
        })),
        ...resolvableShellPaths.map((path) => ({
            path,
            requiresResolution: true,
            resultPath: '$',
            citationMode: undefined,
            origin: 'shell-argument',
        })),
        ...diffResultPaths.map((path) => ({
            path,
            requiresResolution: true,
            resultPath: 'content.0.text',
            citationMode: 'implicit',
            origin: 'diff-result',
        })),
    ];
    const resolved = candidates.flatMap(({ path, requiresResolution, resultPath, citationMode, origin }) => {
        const resolution = resolveFileSourcePath?.({
            path,
            toolName,
            turn: input.turn,
            origin,
        });
        if (requiresResolution && !resolution)
            return [];
        const source = { ...(resolution ?? { path }), resultPath, citationMode };
        return !safeHttpUrl(source.path) && !isTemporaryOrInternalFilePath(source.path)
            ? [source]
            : [];
    });
    return Array.from(new Map(resolved.map((source) => [normalizeFilePath(source.path), source])).values());
}
function codeFilePathsFromDiffResult(input, command) {
    const text = readToolResultText(input.result.content);
    if (!text)
        return [];
    const lines = text.split(/\r?\n/u);
    const hasUnifiedDiff = lines.some((line) => /^diff --git\s+/u.test(line));
    const normalizedCommand = command.toLocaleLowerCase();
    const isGitListing = /(?:^|[\s;&|])git(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+(?:-[^\s]+\s+)*(?:diff|show|log)\b/u.test(normalizedCommand);
    if (!hasUnifiedDiff && !isGitListing)
        return [];
    const rawPaths = [];
    for (const line of lines) {
        const unifiedPath = /^\+\+\+\s+b\/(.+)$/u.exec(line)?.[1];
        if (unifiedPath)
            rawPaths.push(unifiedPath);
        const renamedPath = /^rename to\s+(.+)$/u.exec(line)?.[1];
        if (renamedPath)
            rawPaths.push(renamedPath);
        if (!isGitListing)
            continue;
        const statPath = /^\s*(.+?)\s+\|\s+\d+/u.exec(line)?.[1];
        if (statPath && !statPath.includes('=>'))
            rawPaths.push(statPath);
        const numstatPath = /^\d+\s+\d+\s+(.+)$/u.exec(line)?.[1];
        if (numstatPath && !numstatPath.includes('\t'))
            rawPaths.push(numstatPath);
        const nameStatus = /^([ACDMRTUXB])\d*\s+(.+)$/u.exec(line);
        if (nameStatus?.[1] && nameStatus[1] !== 'D' && nameStatus[2]) {
            const paths = nameStatus[2].split(/\t/u);
            rawPaths.push(paths.at(-1) ?? '');
        }
        if (/--name-only\b/u.test(normalizedCommand) && /^\S.*\.[A-Za-z0-9]{1,16}$/u.test(line)) {
            rawPaths.push(line);
        }
    }
    const workspaceDir = input.turn.workspaceDir;
    const pathApi = nodePath.win32.isAbsolute(workspaceDir) ? nodePath.win32 : nodePath.posix;
    return Array.from(new Set(rawPaths
        .map((value) => value.trim())
        .filter((value) => value &&
        value !== '/dev/null' &&
        !value.startsWith('"') &&
        !['*', '?', '[', ']', '{', '}', '$'].some((marker) => value.includes(marker)))
        .map((value) => value.replace(/^[ab]\//u, ''))
        .filter(isCodeFilePath)
        .map((value) => normalizeFilePath(pathApi.isAbsolute(value) ? value : pathApi.resolve(workspaceDir, value)))));
}
function fileName(value) {
    return normalizeFilePath(value).split('/').filter(Boolean).at(-1) ?? value;
}
function fileDisplayName(value) {
    const name = fileName(value);
    return (/^\d{2}-\d{2}-\d{2}-\d{3}-asset_\d{8}-\d{6}-\d{3}_[a-f0-9]{12}_[a-f0-9]{8}-(.+)$/iu.exec(name)?.[1] ?? name);
}
function sourceStateFor(states, ctx) {
    const key = turnKey(ctx);
    const existing = states.get(key);
    if (existing)
        return existing;
    const created = {
        references: new Map(),
        evidence: new Map(),
        generatedFilePaths: new Set(),
        citationAliases: new Map(),
        citationIdsByAlias: new Map(),
        retryAttempted: false,
        retryAssetMarkup: [],
        retryDraft: '',
    };
    seedHistoricalFileReferences(created, ctx.history);
    states.set(key, created);
    return created;
}
function seedHistoricalFileReferences(state, history) {
    const recentHistory = history.slice(-MAX_HISTORICAL_MESSAGES);
    for (let index = recentHistory.length - 1; index >= 0; index -= 1) {
        if (state.references.size >= MAX_HISTORICAL_FILE_REFERENCES)
            return;
        const message = readRecord(recentHistory[index]);
        if (message?.role !== 'toolResult')
            continue;
        const details = readRecord(message.details);
        const references = Array.isArray(details?.[SOURCE_REFERENCE_DETAILS_KEY])
            ? details[SOURCE_REFERENCE_DETAILS_KEY]
            : [];
        for (const value of references) {
            const reference = historicalFileReference(value, message);
            if (!reference || state.references.has(reference.source_id))
                continue;
            state.references.set(reference.source_id, reference);
            state.evidence.set(reference.source_id, '');
            if (state.references.size >= MAX_HISTORICAL_FILE_REFERENCES)
                return;
        }
    }
}
function historicalFileReference(value, message) {
    const reference = readRecord(value);
    if (reference?.type !== 'file')
        return undefined;
    const sourceId = readNonEmptyString(reference.source_id);
    const name = readNonEmptyString(reference.name);
    const path = readNonEmptyString(reference.path);
    const toolCallId = readNonEmptyString(reference.tool_call_id) ?? readNonEmptyString(message.toolCallId);
    const toolName = readNonEmptyString(reference.tool_name) ?? readNonEmptyString(message.toolName);
    if (!sourceId || !name || !path || !toolCallId || !toolName)
        return undefined;
    return {
        version: 1,
        type: 'file',
        source_id: sourceId,
        name,
        path,
        tool_call_id: toolCallId,
        tool_name: toolName,
        ...(readNonEmptyString(reference.result_path)
            ? { result_path: readNonEmptyString(reference.result_path) }
            : {}),
    };
}
function turnKey(ctx) {
    return `${ctx.sessionId}\u0000${ctx.turnId}`;
}
function appendEvidence(previous, current) {
    return `${previous ?? ''}\n${current}`.slice(-MAX_SOURCE_EVIDENCE_CHARS);
}
function readAssistantText(content) {
    return content
        .map((block) => readRecord(block))
        .map((block) => (block?.type === 'text' ? readNonEmptyString(block.text) : undefined))
        .filter((value) => Boolean(value))
        .join('\n');
}
function answerUsesEvidence(answer, evidence, otherEvidence) {
    if (answerUsesDistinctiveTextEvidence(answer, evidence, otherEvidence))
        return true;
    return answerUsesNumericEvidence(answer, evidence, otherEvidence);
}
function answerUsesReferenceEvidence(reference, answer, evidence, otherEvidence, references) {
    if (reference.type === 'file') {
        if (reference.citation_mode === 'implicit') {
            return answerMentionsFileReference(answer, reference, references);
        }
        return (answerMentionsFileReference(answer, reference, references) ||
            answerUsesFileEvidence(answer, evidence, otherEvidence));
    }
    return answerUsesEvidence(answer, evidence, otherEvidence);
}
function answerMentionsFileReference(answer, reference, references) {
    if (reference.type !== 'file' || !reference.path)
        return false;
    const candidates = fileMentionCandidates(reference, references);
    const normalized = normalizeMalformedFileMentionLinks(answer, candidates, reference.path);
    return (answerCitesReference(normalized, reference) ||
        hasSemanticFileMention(unwrapSyntheticFileMentionMarkdownLinks(answer, [reference]), candidates));
}
function competingEvidenceForReference(reference, references, evidenceByCitationId) {
    return references.flatMap((candidate) => {
        if (citationIdFor(candidate) === citationIdFor(reference))
            return [];
        if (reference.type === 'file' &&
            candidate.type === 'file' &&
            candidate.tool_call_id === reference.tool_call_id) {
            return [];
        }
        if ((reference.type === 'app' || reference.type === 'mcp') &&
            (candidate.type !== reference.type || candidate.source_id !== reference.source_id)) {
            return [];
        }
        return [evidenceByCitationId.get(citationIdFor(candidate)) ?? ''];
    });
}
function answerUsesFileEvidence(answer, evidence, otherEvidence) {
    const candidates = collectFileEvidenceLines(evidence);
    const shared = new Set(otherEvidence.flatMap(collectFileEvidenceLines));
    if (candidates.some((candidate) => !shared.has(candidate) && answer.includes(candidate))) {
        return true;
    }
    if (answerUsesFileNumericEvidence(answer, evidence, otherEvidence))
        return true;
    return answerUsesFileTextSegment(answer, evidence, otherEvidence);
}
function collectFileEvidenceLines(evidence) {
    return Array.from(new Set(evidence
        .split(/\r?\n/gu)
        .map((line) => line
        .replace(/^\s*\d+[→\t|:]\s*/u, '')
        .replace(/^\s*==\s*Page\s+\d+\s*==\s*$/iu, '')
        .trim())
        .filter((line) => {
        if (!line || /^\[[^\]]*(?:truncated|lines? omitted)[^\]]*\]$/iu.test(line)) {
            return false;
        }
        const compactLength = line.replace(/\s+/gu, '').length;
        return compactLength >= (/\p{Script=Han}/u.test(line) ? 8 : 12) && compactLength <= 500;
    })));
}
function answerUsesFileNumericEvidence(answer, evidence, otherEvidence) {
    const evidenceNumbers = collectComparableNumbers(evidence);
    const sharedNumbers = new Set(otherEvidence.flatMap(collectComparableNumbers));
    return collectNumberValues(answer).some((value) => {
        if (!isDistinctiveFileNumber(value))
            return false;
        const comparable = comparableNumber(value);
        return (comparable !== undefined &&
            evidenceNumbers.includes(comparable) &&
            !sharedNumbers.has(comparable));
    });
}
function answerUsesFileTextSegment(answer, evidence, otherEvidence) {
    const comparableAnswer = comparableFileText(answer);
    const comparableOtherEvidence = otherEvidence.map(comparableFileText);
    return collectFileEvidenceSegments(evidence).some((candidate) => comparableAnswer.includes(candidate) &&
        !comparableOtherEvidence.some((other) => other.includes(candidate)));
}
function collectFileEvidenceSegments(evidence) {
    return Array.from(new Set(evidence
        .split(/\r?\n/gu)
        .map((line) => line
        .replace(/^\s*\d+[→\t|:]\s*/u, '')
        .replace(/^\s*(?:[-*+]\s+|#{1,6}\s*)/u, '')
        .trim())
        .filter((line) => line && !/^==\s*Page\s+\d+\s*==$/iu.test(line))
        .flatMap((line) => line.split(/[。！？!?；;，,：:\t|]+/gu))
        .map(comparableFileText)
        .filter((value) => {
        if (!/\p{L}/u.test(value))
            return false;
        const minimumLength = /\p{Script=Han}/u.test(value) ? 4 : 8;
        return value.length >= minimumLength && value.length <= 500;
    })));
}
function comparableFileText(value) {
    return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '');
}
function isDistinctiveFileNumber(value) {
    const digitCount = (value.match(/\d/gu) ?? []).length;
    return digitCount >= 4 || value.includes(',') || value.includes('%') || /\.\d{2,}/u.test(value);
}
function collectNumberValues(value) {
    return Array.from(value.matchAll(/[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/gu), (match) => match[0]);
}
function collectComparableNumbers(value) {
    return collectToolNumericTokens(value).flatMap(comparableToolNumericValues);
}
function answerUsesNumericEvidence(answer, evidence, otherEvidence) {
    if (!evidence)
        return false;
    const evidenceNumbers = new Set(collectComparableNumbers(evidence));
    const sharedNumbers = new Set(otherEvidence.flatMap(collectComparableNumbers));
    return collectToolNumericTokens(answer).some((value) => {
        if (!isDistinctiveToolNumber(value))
            return false;
        return comparableToolNumericValues(value).some((comparable) => evidenceNumbers.has(comparable) && !sharedNumbers.has(comparable));
    });
}
function collectToolNumericTokens(value) {
    return Array.from(value.matchAll(/[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:%|万|亿)?/gu), (match) => match[0].replace(/\s+/gu, ''));
}
function comparableToolNumericValues(value) {
    const unit = /[%万亿]$/u.exec(value)?.[0];
    const numeric = Number(value.replaceAll(',', '').replace(/[%万亿]$/u, ''));
    if (!Number.isFinite(numeric))
        return [];
    const values = new Set([String(numeric)]);
    if (unit === '%')
        values.add(String(numeric / 100));
    if (unit === '万')
        values.add(String(numeric * 10_000));
    if (unit === '亿')
        values.add(String(numeric * 100_000_000));
    return [...values];
}
function isDistinctiveToolNumber(value) {
    const digitCount = (value.match(/\d/gu) ?? []).length;
    return (digitCount >= 4 || value.includes(',') || /[%万亿]$/u.test(value) || /\.\d{2,}/u.test(value));
}
function answerUsesDistinctiveTextEvidence(answer, evidence, otherEvidence) {
    const candidates = collectEvidenceTextValues(evidence);
    const otherValues = new Set(otherEvidence.flatMap(collectEvidenceTextValues));
    return candidates.some((candidate) => {
        const value = candidate.trim();
        const compactLength = value.replace(/\s+/gu, '').length;
        const minimumLength = /[\u3400-\u9fff]/u.test(value) ? 4 : 8;
        return compactLength >= minimumLength && answer.includes(value) && !otherValues.has(value);
    });
}
function collectEvidenceTextValues(evidence) {
    const values = new Set();
    const visit = (value, depth) => {
        if (depth > 6)
            return;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed)
                return;
            values.add(trimmed);
            if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
                (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                try {
                    visit(JSON.parse(trimmed), depth + 1);
                }
                catch {
                    // Keep the original scalar when a JSON-looking string is malformed.
                }
            }
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((entry) => visit(entry, depth + 1));
            return;
        }
        const record = readRecord(value);
        if (record)
            Object.values(record).forEach((entry) => visit(entry, depth + 1));
    };
    try {
        visit(JSON.parse(evidence), 0);
    }
    catch {
        // Concatenated or prose-wrapped ToolResults still expose JSON string leaves below.
    }
    for (const match of evidence.matchAll(/:\s*"((?:\\.|[^"\\])+)"/gu)) {
        try {
            visit(JSON.parse(`"${match[1] ?? ''}"`), 0);
        }
        catch {
            visit(match[1] ?? '', 0);
        }
    }
    return Array.from(values);
}
function comparableNumber(value) {
    const number = Number(value.replaceAll(',', '').replace(/%$/u, ''));
    return Number.isFinite(number) ? String(number) : undefined;
}
function sourceReferenceHref(sourceId) {
    return `#mavis-source=${sourceId}`;
}
function answerCitesReference(answer, reference) {
    if (reference.type === 'web') {
        return Boolean(reference.url && answer.includes(reference.url));
    }
    if (reference.type === 'app' || reference.type === 'mcp') {
        return (answer.includes(sourceReferenceHref(citationIdFor(reference))) ||
            answer.includes(`${sourceReferenceHref(reference.source_id)}:call:`) ||
            answer.includes(`${sourceReferenceHref(reference.source_id)})`));
    }
    if (reference.type !== 'file') {
        return answer.includes(sourceReferenceHref(citationIdFor(reference)));
    }
    return answer.includes(sourceReferenceHref(citationIdFor(reference)));
}
/**
 * Web searches already return canonical result URLs. Append any missing links
 * to the completed draft immediately instead of making source visibility
 * depend on a citation-repair LLM call.
 */
function appendMissingWebSourceSummary(text, missingReferences) {
    const referencesByUrl = new Map();
    for (const reference of missingReferences) {
        if (reference.type !== 'web' || !reference.url || text.includes(reference.url))
            continue;
        if (!referencesByUrl.has(reference.url))
            referencesByUrl.set(reference.url, reference);
    }
    const citations = Array.from(referencesByUrl.values()).map((reference) => `[${escapeMarkdownLabel(reference.name)}](${reference.url})`);
    if (citations.length === 0)
        return text;
    const isChinese = /\p{Script=Han}/u.test(text);
    const separator = isChinese ? '、' : ', ';
    const label = isChinese ? '来源：' : 'Sources: ';
    return `${text.trimEnd()}\n\n${label}${citations.join(separator)}`;
}
function normalizeFilePathCitationTags(text, references) {
    return text
        .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/gu)
        .map((segment, index) => {
        if (index % 2 === 1)
            return segment;
        return segment
            .split(/(`[^`\n]*`)/gu)
            .map((part, inlineIndex) => inlineIndex % 2 === 1
            ? normalizeInlineOrphanFilePathCitation(part, references)
            : normalizeStandardFilePathCitationTags(part, references))
            .join('');
    })
        .join('');
}
function normalizeStandardFilePathCitationTags(text, references) {
    const normalized = normalizeFilePathTagSyntax(text)
        .replace(/<<>\s*(?=[^<\n]+<\/filepath>)/giu, '<filepath>')
        .replace(/<filepath\b([^>]*)>\s*(?:data-path|path)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>\s*([^<]+?)\s*<\/filepath>/giu, (_tag, attributes, doubleQuotedPath, singleQuotedPath, label) => `<filepath${attributes} path="${escapeHtmlAttribute(doubleQuotedPath ?? singleQuotedPath ?? '')}">${label.trim()}</filepath>`)
        .replace(/<filepath\b([^>]*)>\s*([^<\n]+?)\s+\((?:line|lines)\s+(\d+)(?:\s*[-–—:]\s*(\d+))?\)\s*<\/filepath>/giu, (_tag, attributes, path, lineStart, lineEnd) => `<filepath${attributes}>${path.trim()}:${lineStart}${lineEnd ? `:${lineEnd}` : ''}</filepath>`)
        .replace(/<((?:(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])[^<>\n]*?|[^<>\s]+)\.[A-Za-z0-9][A-Za-z0-9._-]*)\s+\((?:line|lines)\s+(\d+)(?:\s*[-–—:]\s*(\d+))?\)>?\s*<\/filepath>/giu, (_tag, path, lineStart, lineEnd) => `<filepath>${path.trim()}:${lineStart}${lineEnd ? `:${lineEnd}` : ''}</filepath>`)
        .replace(/<filepath\b([^>]*)>([^<\n]+)(?=\n|$)/giu, (_tag, attributes, body) => normalizeUnclosedFilePathCitation(attributes, body, references));
    return stripOrphanFilePathClosers(normalized
        .split(/(<filepath\b[^>]*>[\s\S]*?<\/filepath>)/giu)
        .map((part, index) => index % 2 === 1 ? part : normalizeKnownOrphanFilePathClosers(part, references))
        .join(''));
}
function normalizeUnclosedFilePathCitation(attributes, rawBody, references) {
    const body = rawBody.trim();
    const path = filePathFromCitationTag(attributes, body);
    const isBacked = references.some((reference) => reference.type === 'file' &&
        typeof reference.path === 'string' &&
        filePathsMatch(path, reference.path));
    const isPlausibleFile = isBacked ||
        (isMalformedFileCitationPlaceholder(body) &&
            references.filter((reference) => reference.type === 'file' && Boolean(reference.path))
                .length === 1) ||
        isCodeFilePath(path) ||
        /^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|[/\\])/u.test(path) ||
        (/[/\\]/u.test(path) && !/\s/u.test(path)) ||
        /(?:^|[\\/])[^\\/]+\.[A-Za-z0-9][A-Za-z0-9._-]*(?::\d+(?::\d+)?)?$/u.test(path);
    if (!isPlausibleFile)
        return body;
    return `<filepath${attributes}>${body}</filepath>`;
}
function normalizeInlineOrphanFilePathCitation(text, references) {
    const body = normalizeFilePathTagSyntax(text.slice(1, -1));
    if (!body.includes('</filepath>'))
        return text;
    const normalized = normalizeKnownOrphanFilePathClosers(body, references);
    return normalized === body ? body.replaceAll('</filepath>', '') : normalized;
}
function normalizeKnownOrphanFilePathClosers(text, references) {
    const fileReferences = references.filter((reference) => reference.type === 'file' && Boolean(reference.path));
    let normalized = text;
    fileReferences.forEach((reference) => {
        const aliases = Array.from(new Set([reference.path, normalizeFilePath(reference.path), fileName(reference.path)])).sort((left, right) => right.length - left.length);
        aliases.forEach((alias) => {
            const pattern = new RegExp(`(^|[^>])(${escapeRegExp(alias)})(?::(\\d+)(?::(\\d+))?)?(\\s*[（(][^<>\\n]{1,120}[）)])?\\s*<\\/filepath>`, 'giu');
            normalized = normalized.replace(pattern, (_tag, prefix, _alias, lineStart, lineEnd, locator) => {
                const line = lineStart && isCodeFilePath(reference.path)
                    ? `:${lineStart}${lineEnd ? `:${lineEnd}` : ''}`
                    : '';
                return `${prefix}<filepath path="${escapeHtmlAttribute(reference.path)}">${escapeHtmlText(fileName(reference.path))}${line}</filepath>${locator ?? ''}`;
            });
        });
    });
    return normalized;
}
function stripOrphanFilePathClosers(text) {
    let openTagCount = 0;
    return text.replace(/<\p{Cf}*filepath\b[^>]*>|<\p{Cf}*\/\p{Cf}*filepath\p{Cf}*\s*>/giu, (tag) => {
        const normalizedTag = normalizeFilePathTagSyntax(tag);
        if (/^<filepath\b/iu.test(normalizedTag)) {
            openTagCount += 1;
            return normalizedTag;
        }
        if (openTagCount === 0)
            return '';
        openTagCount -= 1;
        return normalizedTag;
    });
}
function normalizeFilePathTagSyntax(text) {
    return text
        .replace(/<\p{Cf}*(?=<\p{Cf}*filepath\b)/giu, '')
        .replace(/<\p{Cf}*filepath\b([^>]*)>/giu, '<filepath$1>')
        .replace(/<\p{Cf}*\/\p{Cf}*filepath\p{Cf}*\s*>/giu, '</filepath>')
        .replace(/(<\/filepath>)\p{Cf}*>/giu, '$1')
        .replace(/<filepath\b[^<>]*?\bpath\s*=\s*(["'])<filepath\b([^>]*)>([^<]+?)<\/filepath>\1\s*>\s*([^<]+?)<\/filepath>/giu, (_tag, _quote, innerAttributes, innerLabel, outerLabel) => `<filepath${innerAttributes}>${outerLabel.trim() || innerLabel.trim()}</filepath>`);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
function normalizeMisclassifiedSourceFilePathTags(text, references, evidenceByCitationId) {
    const webReferences = references.filter((reference) => reference.type === 'web' && Boolean(reference.url));
    return text
        .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/gu)
        .map((segment, index) => {
        if (index % 2 === 1)
            return segment;
        return segment.replace(/<filepath\b([^>]*)>([^<]+?)<\/filepath>/giu, (tag, attributes, rawLabel, offset) => {
            const pathMatch = /\b(?:data-path|path)\s*=\s*(?:"([^"]*)"|'([^']*)')/iu.exec(attributes);
            const candidate = decodeBasicHtmlEntities(pathMatch?.[1] ?? pathMatch?.[2] ?? '').trim();
            const label = decodeBasicHtmlEntities(rawLabel.trim());
            const sourceId = sourceIdFromCandidateHref(candidate);
            if (sourceId) {
                return `[${escapeMarkdownLabel(label)}](${sourceReferenceHref(sourceId)})`;
            }
            const candidateUrl = httpUrlFromMisclassifiedFilePath(candidate);
            if (!candidateUrl)
                return String(tag);
            const candidateComparable = comparableHttpUrl(candidateUrl);
            const exactReference = webReferences.find((reference) => comparableHttpUrl(reference.url) === candidateComparable);
            const candidateHost = safeHttpUrl(candidateUrl)
                ? new URL(candidateUrl).hostname.toLowerCase()
                : undefined;
            const sameHostReferences = candidateHost
                ? webReferences.filter((reference) => {
                    const url = safeHttpUrl(reference.url);
                    return url ? new URL(url).hostname.toLowerCase() === candidateHost : false;
                })
                : [];
            const labelAlias = normalizedSourceAlias(label);
            const labelReference = labelAlias
                ? sameHostReferences.find((reference) => normalizedSourceAlias(reference.name) === labelAlias)
                : undefined;
            const contextualReference = contextualReferenceForAlias(segment.slice(0, offset), sameHostReferences, evidenceByCitationId);
            const resolvedUrl = exactReference?.url ??
                labelReference?.url ??
                contextualReference?.url ??
                (sameHostReferences.length === 1 ? sameHostReferences[0]?.url : undefined) ??
                candidateUrl;
            return `[${escapeMarkdownLabel(label)}](${resolvedUrl})`;
        });
    })
        .join('');
}
function httpUrlFromMisclassifiedFilePath(value) {
    const existing = safeHttpUrl(value);
    if (existing)
        return existing;
    const domainPath = /^((?:[a-z0-9-]+\.)+[a-z]{2,63})([:/])(.+)$/iu.exec(value);
    if (!domainPath)
        return undefined;
    const [, domain, separator, suffix] = domainPath;
    if (!domain || !separator || !suffix)
        return undefined;
    const address = separator === ':' && /^\d+(?:\/|$)/u.test(suffix)
        ? `https://${domain}:${suffix}`
        : `https://${domain}/${suffix.replace(/^\/+/, '')}`;
    return safeHttpUrl(address);
}
function comparableHttpUrl(value) {
    const normalized = safeHttpUrl(value);
    if (!normalized)
        return undefined;
    const url = new URL(normalized);
    url.hash = '';
    return url.href.replace(/\/$/u, '');
}
function removeDisallowedFileCitations(text) {
    return text
        .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/gu)
        .map((segment, index) => {
        if (index % 2 === 1)
            return segment;
        return segment.replace(/<filepath\b([^>]*)>([^<]+?)<\/filepath>([ \t]*[：:][ \t]*)?/giu, (tag, attributes, rawBody, separator) => {
            const path = filePathFromCitationTag(attributes, rawBody);
            if (!path || !isTemporaryOrInternalFilePath(path))
                return String(tag);
            const label = decodeBasicHtmlEntities(rawBody.trim());
            return isSemanticFileCitationLabel(label, path)
                ? ''
                : `${rawBody.trim()}${separator ?? ''}`;
        });
    })
        .join('');
}
function removeUnbackedFileCitations(text, references) {
    const fileReferences = references.filter((reference) => reference.type === 'file' && Boolean(reference.path));
    const isBacked = (attributes, body) => {
        const path = filePathFromCitationTag(attributes, body);
        return fileReferences.some((reference) => filePathsMatch(path, reference.path));
    };
    return text
        .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/gu)
        .map((segment, index) => {
        if (index % 2 === 1)
            return segment;
        const withoutStandaloneLines = segment.replace(/^[ \t]*(?:[-*][ \t]+)?(?:(?:来源[：:]|Source:)[ \t]*)?<filepath\b([^>]*)>\s*([^<\n]+?)\s*<\/filepath>[ \t]*$/gimu, (line, attributes, body) => isBacked(attributes, body) ? String(line) : '');
        return withoutStandaloneLines.replace(/<filepath\b([^>]*)>([^<]+?)<\/filepath>/giu, (tag, attributes, body) => isBacked(attributes, body) ? String(tag) : body.trim());
    })
        .join('');
}
function normalizeFileCitationLabels(text, references) {
    const fileReferences = references.filter((reference) => reference.type === 'file' && Boolean(reference.path));
    if (fileReferences.length === 0)
        return text;
    return text.replace(/<filepath\b([^>]*)>([^<]+?)<\/filepath>/giu, (tag, attributes, rawBody) => {
        const citedPath = filePathFromCitationTag(attributes, rawBody);
        const label = decodeBasicHtmlEntities(rawBody.trim());
        const malformedPlaceholder = isMalformedFileCitationPlaceholder(label);
        const reference = fileReferences.find((candidate) => filePathsMatch(citedPath, candidate.path)) ??
            (malformedPlaceholder && fileReferences.length === 1 ? fileReferences[0] : undefined);
        if (!reference)
            return malformedPlaceholder ? '' : String(tag);
        if (malformedPlaceholder) {
            return renderSemanticFileCitation(reference.path, fileDisplayName(reference.path));
        }
        if (isSemanticFileCitationLabel(label, reference.path)) {
            return renderSemanticFileCitation(reference.path, label);
        }
        const localizedCitation = renderSemanticFileCitation(reference.path, fileDisplayName(reference.path));
        const separator = /\p{Script=Han}/u.test(label) ? '：' : ': ';
        return `${localizedCitation}${separator}${rawBody.trim()}`;
    });
}
function isMalformedFileCitationPlaceholder(value) {
    return /^\/?filepath\s*>?$/iu.test(value.trim());
}
function isSemanticFileCitationLabel(label, path) {
    const withoutLineAddress = extractFileLineAddress(label).label;
    const candidates = new Set([
        path,
        normalizeFilePath(path),
        fileName(path),
        fileDisplayName(path),
        ...semanticFileMentionLabels(path),
    ]);
    const comparableLabel = comparableFileText(withoutLineAddress);
    return Array.from(candidates).some((candidate) => comparableFileText(candidate) === comparableLabel);
}
function isCodeFilePath(path) {
    return CODE_FILE_BASENAME_RE.test(path) || CODE_FILE_EXTENSION_RE.test(fileName(path));
}
function localizeMentionedFileCitations(text, references) {
    const fileReferences = references.filter((reference) => reference.type === 'file' && Boolean(reference.path));
    return fileReferences.reduce((answer, reference) => {
        const candidates = fileMentionCandidates(reference, fileReferences);
        const normalizedMalformedLinks = normalizeMalformedFileMentionLinks(answer, candidates, reference.path);
        const withoutOldCitations = removeMatchingFileCitations(normalizedMalformedLinks, reference.path);
        if (!hasSemanticFileMention(withoutOldCitations, candidates))
            return normalizedMalformedLinks;
        return replaceSemanticFileMentions(normalizeMalformedFileMentionLinks(withoutOldCitations, candidates, reference.path), candidates, reference.path);
    }, text);
}
function fileMentionCandidates(reference, references) {
    if (reference.type !== 'file' || !reference.path)
        return [];
    const referencePath = reference.path;
    const fileReferencesByPath = new Map();
    references.forEach((candidate) => {
        if (candidate.type !== 'file' || !candidate.path)
            return;
        fileReferencesByPath.set(comparableFileText(normalizeFilePath(candidate.path)), {
            ...candidate,
            path: candidate.path,
        });
    });
    const ownersByLabel = new Map();
    const labelsByPath = new Map();
    fileReferencesByPath.forEach((candidate, pathKey) => {
        const extension = fileExtension(candidate.path);
        const labels = Array.from(new Set([
            candidate.path,
            normalizeFilePath(candidate.path),
            candidate.name,
            ...semanticFileMentionLabels(candidate.path),
            ...filePathSuffixMentionLabels(candidate.path),
            ...(extension ? fileTypeMentionLabels(extension) : []),
        ])).filter(Boolean);
        labelsByPath.set(pathKey, labels);
        labels.forEach((label) => {
            const labelKey = comparableFileText(label);
            const owners = ownersByLabel.get(labelKey) ?? new Set();
            owners.add(pathKey);
            ownersByLabel.set(labelKey, owners);
        });
    });
    const referencePathKey = comparableFileText(normalizeFilePath(referencePath));
    return (labelsByPath.get(referencePathKey) ?? [referencePath])
        .filter((label) => ownersByLabel.get(comparableFileText(label))?.size === 1)
        .sort((left, right) => right.length - left.length);
}
function removeMatchingFileCitations(text, path) {
    const href = sourceReferenceHref(fileSourceId(path));
    const internalLink = new RegExp(`\\[([^\\]\\n]+)\\]\\(\\s*${escapeRegExp(href)}\\s*\\)`, 'giu');
    const withoutStandaloneInternalLinks = text.replace(new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?(?:(?:来源[：:]|Source:)[ \\t]*)?${internalLink.source}[ \\t]*$`, 'gimu'), '');
    const withoutStandaloneSourceLines = withoutStandaloneInternalLinks.replace(/^[ \t]*(?:[-*][ \t]+)?(?:(?:来源[：:]|Source:)[ \t]*)?<filepath\b([^>]*)>\s*([^<\n]+?)\s*<\/filepath>[ \t]*$/gimu, (line, attributes, body) => filePathsMatch(filePathFromCitationTag(attributes, body), path) ? '' : String(line));
    return withoutStandaloneSourceLines
        .replace(internalLink, (_link, label) => label)
        .replace(/<filepath\b([^>]*)>\s*([^<]+?)\s*<\/filepath>/giu, (tag, attributes, body) => filePathsMatch(filePathFromCitationTag(attributes, body), path) ? '' : String(tag));
}
function semanticFileMentionLabels(path) {
    const name = fileDisplayName(path);
    const extension = /\.([a-z0-9]{1,10})$/iu.exec(name)?.[1];
    const stem = extension ? name.slice(0, -(extension.length + 1)) : name;
    const core = stem
        .replace(/[（(【[][^）)】\]]*[）)】\]]/gu, '')
        .replace(/[\s_-]*\d{4,}[\s_-]*$/u, '')
        .replace(/[\s_-]+$/u, '')
        .trim();
    const spacedCore = core
        .replace(/([a-z0-9])([\u3400-\u9fff])/giu, '$1 $2')
        .replace(/([\u3400-\u9fff])([a-z0-9])/giu, '$1 $2');
    const extensionLabel = extension?.toUpperCase();
    return Array.from(new Set([
        name,
        stem,
        core,
        spacedCore,
        ...(extensionLabel
            ? [`${core} ${extensionLabel}`, `${spacedCore} ${extensionLabel}`, `${core}.${extension}`]
            : []),
    ].filter((value) => value.length >= 4)));
}
function filePathSuffixMentionLabels(path) {
    const segments = normalizeFilePath(path).split('/').filter(Boolean);
    return segments.slice(0, -1).map((_, index) => segments.slice(index).join('/'));
}
function fileExtension(path) {
    return /\.([a-z0-9]{1,16})$/iu.exec(fileName(path))?.[1]?.toLocaleLowerCase();
}
function fileTypeMentionLabels(extension) {
    const lower = extension.toLocaleLowerCase();
    const upper = extension.toLocaleUpperCase();
    return [`${upper} 文件`, `${upper} 文档`, `${lower} 文件`, `${lower} 文档`];
}
function matchesSemanticFileMention(value, candidates) {
    const address = extractFileLineAddress(value.trim());
    const comparableLabel = comparableFileText(address.label);
    return candidates.some((candidate) => comparableFileText(candidate) === comparableLabel);
}
function normalizeMalformedFileMentionLinks(text, candidates, path) {
    if (candidates.length === 0)
        return text;
    // Unwrap only an already-backed File citation with an empty/line-only outer
    // target. A real Web link wrapping a filename remains untouched.
    const normalizedWrappers = text
        .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/gu)
        .map((segment, index) => index % 2 === 1
        ? segment
        : segment.replace(/\[(\[[^\]\n]+\]\((#mavis-source=file:[^\s)"'<>]+)\))\]\(((?:[^()\n]|\([^()\n]*\))*)\)/gu, (wrapper, citation, href, outerHref) => {
            const target = decodePercentEncodedText(outerHref)
                .replace(/^\((.*)\)$/u, '$1')
                .trim();
            return href === sourceReferenceHref(fileSourceId(path)) &&
                (!target || /^(?:line|lines)\s+\d+(?:\s*[-–—:]\s*\d+)?$/iu.test(target))
                ? citation
                : wrapper;
        }))
        .join('');
    const lineLabelPattern = `(?:line|lines)\\s+${FILE_LINE_LIST_PATTERN}`;
    const pattern = new RegExp(`\\[([^\\]\\n]+)\\]\\(((?:[^()\\n]|\\([^()\\n]*\\))*)\\)(?:\\s*\\(\\s*(${lineLabelPattern})\\s*\\))?`, 'giu');
    return splitFileCitationSegments(normalizedWrappers)
        .map((segment) => {
        if (isFilePathTag(segment) ||
            isFileSourceMarkdownLink(segment) ||
            isAssetMarkup(segment) ||
            isFencedCode(segment) ||
            isInlineCode(segment)) {
            return segment;
        }
        return segment.replace(pattern, (link, rawLabel, rawHref, trailingLineLabel) => {
            const label = rawLabel.trim();
            const href = decodePercentEncodedText(decodeBasicHtmlEntities(rawHref.trim()))
                .replace(/^<|>$/gu, '')
                .trim();
            const unwrappedHref = /^\((.*)\)$/u.exec(href)?.[1]?.trim() ?? href;
            const hrefLineLabel = new RegExp(`^${lineLabelPattern}$`, 'iu').exec(unwrappedHref)?.[0];
            const hrefAddress = extractFileLineAddress(href.replace(/^file:\/\//iu, ''));
            const backedLocalPath = Boolean(href &&
                !safeHttpUrl(href) &&
                (filePathsMatch(hrefAddress.label, path) ||
                    matchesFlattenedFilePathAlias(hrefAddress.label, path)));
            const uniquelyMatchedLabel = matchesSemanticFileMention(label, candidates);
            if (!uniquelyMatchedLabel &&
                !(backedLocalPath && isSemanticFileCitationLabel(label, path))) {
                return String(link);
            }
            const emptyOrBackedHref = !href || hrefLineLabel || backedLocalPath;
            if (!emptyOrBackedHref)
                return String(link);
            const labelAddress = extractFileLineAddress(label);
            const lineLabel = labelAddress.lineRanges.length > 0
                ? undefined
                : (hrefLineLabel ??
                    trailingLineLabel ??
                    (hrefAddress.lineRanges.length > 0
                        ? `lines ${hrefAddress.lineRanges.join(', ')}`
                        : undefined));
            return renderSemanticFileCitation(path, lineLabel ? `${label}(${lineLabel})` : label);
        });
    })
        .join('');
}
function matchesFlattenedFilePathAlias(value, path) {
    const comparableValue = value
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/^\.\//u, '')
        .replace(/[\\/\s_-]+/gu, '');
    if (!comparableValue)
        return false;
    return filePathSuffixMentionLabels(path).some((suffix) => suffix
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\\/\s_-]+/gu, '') === comparableValue);
}
function decodePercentEncodedText(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
function hasSemanticFileMention(text, candidates) {
    return splitFileCitationSegments(text).some((segment) => {
        if (isFilePathTag(segment) ||
            isFileSourceMarkdownLink(segment) ||
            isFileMentionLink(segment) ||
            isAssetMarkup(segment) ||
            isFencedCode(segment)) {
            return false;
        }
        if (isInlineCode(segment)) {
            const value = segment.slice(1, -1).trim();
            return matchesSemanticFileMention(value, candidates);
        }
        return fileMentionPattern(candidates).test(segment);
    });
}
function replaceSemanticFileMentions(text, candidates, path) {
    let replacedNaturalMention = false;
    const replaceAllCodeMentions = isCodeFilePath(path);
    return splitFileCitationSegments(text)
        .map((segment) => {
        if (isFilePathTag(segment) ||
            isFileSourceMarkdownLink(segment) ||
            isFileMentionLink(segment) ||
            isAssetMarkup(segment) ||
            isFencedCode(segment)) {
            return segment;
        }
        if (isInlineCode(segment)) {
            const value = segment.slice(1, -1).trim();
            if (!matchesSemanticFileMention(value, candidates))
                return segment;
            return renderSemanticFileCitation(path, value);
        }
        if (replacedNaturalMention && !replaceAllCodeMentions)
            return segment;
        const lineAddress = `(?:${FILE_LINE_ADDRESS_PATTERN})?`;
        const pattern = fileMentionPattern(candidates, lineAddress);
        return segment.replace(pattern, (mention) => {
            if (replacedNaturalMention && !replaceAllCodeMentions)
                return String(mention);
            replacedNaturalMention = true;
            return renderSemanticFileCitation(path, String(mention));
        });
    })
        .join('');
}
// Ordinary links/URLs are syntax boundaries, never file mentions to rewrite.
function isFileMentionLink(value) {
    return /^(?:!?\[|https?:\/\/|<https?:\/\/)/iu.test(value.trimStart());
}
function fileMentionPattern(candidates, suffix = '') {
    const alternatives = [...candidates]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|');
    return new RegExp(`(?<![\\w./\\\\-])(?:${alternatives})${suffix}(?![\\w/\\\\-]|\\.[\\w.])`, 'giu');
}
function renderSemanticFileCitation(path, label) {
    return `[${escapeMarkdownLabel(canonicalFileCitationLabel(path, label))}](${sourceReferenceHref(fileSourceId(path))})`;
}
function fileSourceId(path) {
    return `file:${Buffer.from(normalizeFilePath(path), 'utf8').toString('base64url')}`;
}
function unwrapSyntheticFileMentionMarkdownLinks(text, references) {
    const fileNames = new Set(references.flatMap((reference) => reference.type === 'file' && reference.path ? [fileName(reference.path).toLowerCase()] : []));
    if (fileNames.size === 0)
        return text;
    return text.replace(/\[([^\]\n]+)\]\(https?:\/\/([^/)\s]+)[^\n)]*\)/giu, (link, label, rawHost) => {
        const host = rawHost.replace(/:\d+$/u, '').toLowerCase();
        return fileNames.has(host) ? label : String(link);
    });
}
function canonicalFileCitationLabel(path, rawLabel) {
    const label = decodeBasicHtmlEntities(rawLabel.trim());
    const address = extractFileLineAddress(label);
    const baseLabel = isCodeFilePath(path)
        ? fileName(path)
        : address?.label || label || fileDisplayName(path);
    if (!address.lineRanges.length || !isCodeFilePath(path))
        return baseLabel;
    return `${baseLabel}(line ${address.lineRanges.join(', ')})`;
}
function extractFileLineAddress(value) {
    const match = new RegExp(`^(.*?)(?::\\s*(${FILE_LINE_LIST_PATTERN})|\\s*\\((?:line|lines)\\s+(${FILE_LINE_LIST_PATTERN})\\))\\s*$`, 'iu').exec(value);
    if (!match)
        return { label: value.trim(), lineRanges: [] };
    const rawRanges = match[2] ?? match[3] ?? '';
    return {
        label: (match[1] ?? '').trim(),
        lineRanges: rawRanges.split(/\s*[,，]\s*/u).flatMap((range) => {
            const rangeMatch = /^(\d+)(?:\s*[-–—:]\s*(\d+))?$/u.exec(range);
            if (!rangeMatch?.[1])
                return [];
            return [rangeMatch[2] ? `${rangeMatch[1]}-${rangeMatch[2]}` : rangeMatch[1]];
        }),
    };
}
const FILE_LINE_RANGE_PATTERN = '\\d+(?:\\s*[-–—:]\\s*\\d+)?';
const FILE_LINE_LIST_PATTERN = `${FILE_LINE_RANGE_PATTERN}(?:\\s*[,，]\\s*${FILE_LINE_RANGE_PATTERN})*`;
const FILE_LINE_ADDRESS_PATTERN = `(?::\\s*${FILE_LINE_LIST_PATTERN}|\\s*\\((?:line|lines)\\s+${FILE_LINE_LIST_PATTERN}\\))`;
function normalizeFileCitationLineAddresses(text, references) {
    const fileNamesBySourceHref = new Map(references.flatMap((reference) => reference.type === 'file' && reference.path
        ? [[sourceReferenceHref(citationIdFor(reference)), reference.path]]
        : []));
    if (fileNamesBySourceHref.size === 0)
        return text;
    return text.replace(new RegExp(`\\[([^\\]\\n]+)\\]\\((#mavis-source=file:[^\\s)"'<>]+)\\)(${FILE_LINE_ADDRESS_PATTERN})`, 'giu'), (citation, label, href, lineAddress) => {
        const path = fileNamesBySourceHref.get(href);
        if (!path || !lineAddress)
            return String(citation);
        return renderSemanticFileCitation(path, `${label}${lineAddress}`);
    });
}
function filePathFromCitationTag(attributes, body) {
    const pathMatch = /\b(?:data-path|path)\s*=\s*(?:"([^"]*)"|'([^']*)')/iu.exec(attributes);
    return decodeBasicHtmlEntities(pathMatch?.[1] ?? pathMatch?.[2] ?? body.trim());
}
function escapeHtmlAttribute(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
function escapeHtmlText(value) {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function decodeBasicHtmlEntities(value) {
    return value
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
}
function splitFileCitationSegments(text) {
    return text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|<(?:deliver-assets|deliver_assets)\b[^>]*>[\s\S]*?<\/(?:deliver-assets|deliver_assets)>|<media\b(?:[^>"']|"[^"]*"|'[^']*')*?\/>|<filepath\b[^>]*>[\s\S]*?<\/filepath>|!?\[[^\]\n]+\](?:\((?:[^()\n]|\([^()\n]*\))*\)|\[[^\]\n]*\])|^[ \t]{0,3}\[[^\]\n]+\]:[^\n]*|<https?:\/\/[^>\n]+>|https?:\/\/[^\s<>"`]+|`[^`\n]*`)/gimu);
}
function isFilePathTag(value) {
    return /^<filepath\b/iu.test(value);
}
function isFileSourceMarkdownLink(value) {
    return /^\[[^\]\n]+\]\(#mavis-source=file:/iu.test(value);
}
function isAssetMarkup(value) {
    return /^<(?:deliver-assets|deliver_assets|media)\b/iu.test(value);
}
function collectAssetMarkupSegments(text) {
    return splitFileCitationSegments(text).filter(isAssetMarkup);
}
function restoreMissingAssetMarkup(text, preserved) {
    if (preserved.length === 0)
        return text;
    const present = new Set(collectAssetMarkupSegments(text));
    const missing = preserved.filter((segment) => !present.has(segment));
    if (missing.length === 0)
        return text;
    return `${text.trimEnd()}\n\n${missing.join('\n')}`;
}
function isFencedCode(value) {
    return value.startsWith('```') || value.startsWith('~~~');
}
function isInlineCode(value) {
    return value.startsWith('`') && value.endsWith('`');
}
function normalizeExplicitSourceLinks(text, references, evidenceByCitationId, citationIdsByAlias) {
    const sourceById = new Map();
    const sourceByAlias = new Map();
    const sourcesByAlias = new Map();
    const sourceByGroupId = new Map();
    const sourcesByGroupId = new Map();
    for (const reference of references) {
        sourceById.set(citationIdFor(reference), reference);
        sourcesByGroupId.set(reference.source_id, [
            ...(sourcesByGroupId.get(reference.source_id) ?? []),
            reference,
        ]);
        const grouped = sourceByGroupId.get(reference.source_id);
        if (!sourceByGroupId.has(reference.source_id)) {
            sourceByGroupId.set(reference.source_id, reference);
        }
        else if (grouped && citationIdFor(grouped) !== citationIdFor(reference)) {
            sourceByGroupId.set(reference.source_id, null);
        }
        const aliases = new Set([reference.provider, reference.name]
            .map((alias) => normalizedSourceAlias(alias))
            .filter((alias) => Boolean(alias)));
        for (const normalized of aliases) {
            sourcesByAlias.set(normalized, [...(sourcesByAlias.get(normalized) ?? []), reference]);
            const existing = sourceByAlias.get(normalized);
            if (!sourceByAlias.has(normalized)) {
                sourceByAlias.set(normalized, reference);
            }
            else if (existing && citationIdFor(existing) !== citationIdFor(reference)) {
                sourceByAlias.set(normalized, null);
            }
        }
    }
    sourceByGroupId.forEach((reference, sourceId) => {
        if (reference)
            sourceById.set(sourceId, reference);
    });
    return text
        .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/gu)
        .map((segment, index) => {
        if (index % 2 === 1)
            return segment;
        return segment.replace(/\[([^\]\n]+)\]\(\s*([^\s)]+)\s*\)/gu, (link, label, href, offset) => {
            const hrefText = String(href);
            const rawSourceId = sourceIdFromCandidateHref(hrefText);
            const resolvedSourceId = rawSourceId
                ? resolveKnownCitationAlias(rawSourceId, sourceById.keys(), citationIdsByAlias)
                : undefined;
            const collapsedSourceId = resolvedSourceId
                ? collapseRepeatedCallCitationId(resolvedSourceId)
                : undefined;
            const sourceId = collapsedSourceId && sourceById.has(collapsedSourceId)
                ? collapsedSourceId
                : resolvedSourceId;
            const sourceGroupId = sourceId ? sourceGroupIdFromCitationId(sourceId) : undefined;
            const legacyLocator = legacyToolSourceLocator(hrefText) ??
                legacySplitToolSourceLocator(String(label), hrefText);
            const alias = normalizedSourceAlias(legacyLocator?.provider ?? hrefText);
            const labelAlias = safeHttpUrl(hrefText)
                ? normalizedSourceAlias(String(label))
                : undefined;
            const aliasReferences = alias ? (sourcesByAlias.get(alias) ?? []) : [];
            const matchingReferences = legacyLocator
                ? aliasReferences.filter((candidate) => normalizedSourceAlias(candidate.tool_name) ===
                    normalizedSourceAlias(legacyLocator.toolName))
                : aliasReferences;
            const reference = sourceId
                ? (sourceById.get(sourceId) ??
                    contextualReferenceForAlias(segment.slice(0, offset), sourceGroupId ? (sourcesByGroupId.get(sourceGroupId) ?? []) : [], evidenceByCitationId))
                : ((legacyLocator
                    ? matchingReferences.length === 1
                        ? matchingReferences[0]
                        : undefined
                    : (sourceByAlias.get(alias ?? '') ?? sourceByAlias.get(labelAlias ?? ''))) ??
                    contextualReferenceForAlias(segment.slice(0, offset), matchingReferences, evidenceByCitationId) ??
                    undefined);
            if (!reference)
                return link;
            return `[${escapeMarkdownLabel(reference.name)}](${sourceReferenceHref(citationIdFor(reference))})`;
        });
    })
        .join('');
}
function sourceGroupIdFromCitationId(value) {
    return /^((?:app|mcp):[^:]+):call:/u.exec(value)?.[1];
}
function collapseRepeatedCallCitationId(value) {
    const match = /^((?:app|mcp):[^:]+):call:(.+)$/u.exec(value);
    if (!match?.[1] || !match[2]?.includes(':call:'))
        return value;
    const finalCallId = match[2].split(':call:').at(-1);
    return finalCallId ? `${match[1]}:call:${finalCallId}` : value;
}
function contextualReferenceForAlias(precedingText, references, evidenceByCitationId) {
    if (references.length === 1)
        return references[0];
    if (references.length === 0)
        return undefined;
    const context = precedingCitationBlock(precedingText);
    const valuesByReference = new Map(references.map((reference) => [
        citationIdFor(reference),
        collectEvidenceTextValues(evidenceByCitationId.get(citationIdFor(reference)) ?? ''),
    ]));
    const scores = references.map((reference) => {
        const citationId = citationIdFor(reference);
        const otherValues = new Set(references
            .filter((candidate) => citationIdFor(candidate) !== citationId)
            .flatMap((candidate) => valuesByReference.get(citationIdFor(candidate)) ?? []));
        const score = (valuesByReference.get(citationId) ?? []).reduce((total, value) => {
            const compactLength = value.replace(/\s+/gu, '').length;
            if (compactLength < (/[\u3400-\u9fff]/u.test(value) ? 4 : 8))
                return total;
            if (otherValues.has(value) || !context.includes(value))
                return total;
            return total + Math.min(compactLength, 80);
        }, 0);
        return { reference, score };
    });
    scores.sort((left, right) => right.score - left.score);
    if ((scores[0]?.score ?? 0) === 0 || scores[0]?.score === scores[1]?.score)
        return undefined;
    return scores[0]?.reference;
}
function precedingCitationBlock(text) {
    const bounded = text.slice(-6_000);
    const boundary = Math.max(bounded.lastIndexOf('\n\n'), bounded.lastIndexOf('\n#'));
    return boundary >= 0 ? bounded.slice(boundary + 2) : bounded;
}
/**
 * Citation repair is model-authored, so enforce its block contract before the
 * repaired answer becomes user-visible. A Markdown heading starts a sourced
 * block; only repeats in explicit citation-only summaries may collapse.
 * Descriptive links and file locations retain their text and targets.
 */
function collapseRepeatedCitationTargetsByMarkdownSection(text, references) {
    const citationIdentityByHref = new Map();
    references.forEach((reference) => {
        if (reference.type === 'file')
            return;
        if (reference.type === 'web') {
            if (reference.url)
                citationIdentityByHref.set(reference.url, `web:${reference.url}`);
            return;
        }
        const citationId = citationIdFor(reference);
        citationIdentityByHref.set(sourceReferenceHref(citationId), `tool:${citationId}`);
        citationIdentityByHref.set(sourceReferenceHref(reference.source_id), `tool:${reference.source_id}`);
    });
    if (citationIdentityByHref.size === 0)
        return text;
    const protectedPattern = /(`[^`\n]*`)/gu;
    const citationPattern = /\[([^\]\n]+)\]\(\s*([^\s)"'<>]+)\s*\)/gu;
    const seen = new Set();
    let fence;
    return text
        .split('\n')
        .map((line) => {
        const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line);
        if (fence) {
            if (fenceMatch?.[1]?.startsWith(fence.character) && fenceMatch[1].length >= fence.length) {
                fence = undefined;
            }
            return line;
        }
        if (fenceMatch?.[1]) {
            fence = {
                character: fenceMatch[1][0],
                length: fenceMatch[1].length,
            };
            return line;
        }
        if (/^\s{0,3}#{1,6}\s+/u.test(line))
            seen.clear();
        const sourceOnlyLine = isCitationOnlySummaryLine(line);
        let removedCitation = false;
        const projected = line
            .split(protectedPattern)
            .map((segment, protectedIndex) => {
            if (protectedIndex % 2 === 1)
                return segment;
            return segment.replace(citationPattern, (link, _label, href) => {
                const identity = citationIdentityByHref.get(href.trim());
                if (!identity)
                    return link;
                if (!seen.has(identity)) {
                    seen.add(identity);
                    return link;
                }
                if (!sourceOnlyLine)
                    return link;
                removedCitation = true;
                return '';
            });
        })
            .join('');
        return removedCitation ? cleanRemovedCitationLine(projected) : projected;
    })
        .join('\n');
}
/**
 * A source summary may list multiple call-specific links for one provider as
 * `Source A + Source A`. Collapse only delimiter-connected source lists, so
 * separate factual citations remain call-specific and independently usable.
 */
function collapseRepeatedPresentedSourceLists(text, references) {
    const presentationIdentityByHref = new Map();
    references.forEach((reference) => {
        if (reference.type === 'file')
            return;
        if (reference.type === 'web') {
            if (reference.url) {
                presentationIdentityByHref.set(reference.url, `web:${reference.url}`);
            }
            return;
        }
        const identity = `tool:${reference.source_id}`;
        presentationIdentityByHref.set(sourceReferenceHref(citationIdFor(reference)), identity);
        presentationIdentityByHref.set(sourceReferenceHref(reference.source_id), identity);
    });
    if (presentationIdentityByHref.size === 0)
        return text;
    const protectedPattern = /(`[^`\n]*`)/gu;
    const citationPattern = /\[([^\]\n]+)\]\(\s*([^\s)"'<>]+)\s*\)/gu;
    const sourceListSeparator = /^\s*[+、,，;；/·•]\s*$/u;
    let fence;
    return text
        .split('\n')
        .map((line) => {
        const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line);
        if (fence) {
            if (fenceMatch?.[1]?.startsWith(fence.character) && fenceMatch[1].length >= fence.length) {
                fence = undefined;
            }
            return line;
        }
        if (fenceMatch?.[1]) {
            fence = {
                character: fenceMatch[1][0],
                length: fenceMatch[1].length,
            };
            return line;
        }
        if (line.includes('|'))
            return line;
        const trailingSourceList = isCitationOnlySummaryLine(line.replace(/^.*?(?=(?:数据来源|来源|Sources?)\s*[：:])/iu, ''));
        let removedCitation = false;
        const projected = line
            .split(protectedPattern)
            .map((segment, protectedIndex) => {
            if (protectedIndex % 2 === 1)
                return segment;
            const seenInList = new Set();
            let previousCitationEnd;
            return segment.replace(citationPattern, (link, _label, href, offset) => {
                const connectedToPrevious = previousCitationEnd !== undefined &&
                    sourceListSeparator.test(segment.slice(previousCitationEnd, offset));
                if (!connectedToPrevious)
                    seenInList.clear();
                previousCitationEnd = offset + String(link).length;
                const identity = presentationIdentityByHref.get(href.trim());
                if (!identity) {
                    seenInList.clear();
                    return link;
                }
                // App-only source lists may follow prose on the same line. Never
                // use URL identity alone to delete a descriptive Web link label.
                if (connectedToPrevious &&
                    seenInList.has(identity) &&
                    identity.startsWith('tool:') &&
                    trailingSourceList) {
                    removedCitation = true;
                    return '';
                }
                seenInList.add(identity);
                return link;
            });
        })
            .join('');
        return removedCitation ? cleanRemovedCitationLine(projected) : projected;
    })
        .join('\n');
}
function isCitationOnlySummaryLine(line) {
    if (line.includes('|'))
        return false;
    const withoutLinks = line.replace(/\[[^\]\n]+\]\(\s*[^\s)"'<>]+\s*\)/gu, '');
    return /^\s*(?:>\s*)?(?:[-*+]\s*)?(?:已引用的?来源(?:链接)?|数据来源|来源(?:链接)?|Sources?(?: links?)?)\s*[：:][\s+、,，;；/·•()（）]*$/iu.test(withoutLinks);
}
function cleanRemovedCitationLine(line) {
    const sourceSummaryAtStart = /^\s*(?:>\s*)?(?:[-*+]\s*)?(?:已引用的?来源(?:链接)?|数据来源|来源(?:链接)?|Sources?(?: links?)?)\s*[：:]/iu;
    const remainingMarkdownLink = /\[[^\]\n]+\]\(\s*[^)\n]+\s*\)/u;
    if (sourceSummaryAtStart.test(line) && !remainingMarkdownLink.test(line))
        return '';
    const cleaned = line
        .replace(/(?:来源[：:]|Source:)\s*(?=$|[+、,，;；/|·•])/giu, '')
        .replace(/([+、,，;；/|·•])(?:\s*[+、,，;；/|·•])+/gu, '$1')
        .replace(/[（(]\s*[+、,，;；/|·•\s]+[）)]/gu, '')
        .replace(/\s*[+、,，;；/|·•]+\s*$/gu, '')
        .replace(/(?:数据来源|来源(?:链接)?|Source(?: links?)?)\s*[：:]\s*$/giu, '')
        .trimEnd();
    return /^\s*(?:>\s*)?(?:[-*+]\s*)?$/u.test(cleaned) ? '' : cleaned;
}
function normalizeBareToolSourceLines(text) {
    const label = /[\u3400-\u9fff]/u.test(text) ? '来源：' : 'Source: ';
    return text
        .replace(/^([ \t]*)[（(]\s*(\[[^\]\n]+\]\(#mavis-source=[^)\n]+\))\s*[）)][ \t]*$/gmu, (_line, indent, citation) => `${indent}${indent ? '- ' : ''}${label}${citation}`)
        .replace(/^-[ \t]+((?:来源[：:]|Source:)[ \t]*\[[^\]\n]+\]\(#mavis-source=[^)\n]+\))[ \t]*$/gmu, '$1');
}
function sourceIdFromCandidateHref(href) {
    const marker = '#mavis-source=';
    const schemeMarker = '://mavis-source=';
    let decodedHref = href.trim();
    try {
        decodedHref = decodeURIComponent(decodedHref);
    }
    catch {
        // Match the original candidate when malformed escaping is present.
    }
    const markerIndex = decodedHref.indexOf(marker);
    const schemeMarkerIndex = decodedHref.indexOf(schemeMarker);
    const sourceId = markerIndex >= 0
        ? decodedHref.slice(markerIndex + marker.length)
        : schemeMarkerIndex >= 0
            ? decodedHref.slice(schemeMarkerIndex + schemeMarker.length)
            : decodedHref.startsWith('mavis-source=')
                ? decodedHref.slice('mavis-source='.length)
                : /^(?:app|mcp):/u.test(decodedHref)
                    ? decodedHref
                    : undefined;
    if (!sourceId)
        return undefined;
    return sourceId;
}
function legacyToolSourceLocator(href) {
    let decodedHref = href.trim();
    try {
        decodedHref = decodeURIComponent(decodedHref);
    }
    catch {
        // Match the original candidate when malformed escaping is present.
    }
    const match = /^([a-z0-9._-]+)#([a-z0-9._-]+)$/iu.exec(decodedHref);
    if (!match?.[1] || !match[2] || match[2].toLowerCase() === 'mavis-source')
        return undefined;
    return { provider: match[1], toolName: match[2].toLowerCase() };
}
function legacySplitToolSourceLocator(label, href) {
    const providerMatch = /^(?:来源|Source)\s*[：:]\s*([a-z0-9._-]+)$/iu.exec(label.trim());
    const toolName = href.trim();
    if (!providerMatch?.[1] || !/^[a-z0-9._-]+$/iu.test(toolName))
        return undefined;
    return { provider: providerMatch[1], toolName: toolName.toLowerCase() };
}
function normalizedSourceAlias(value) {
    if (!value)
        return undefined;
    let decoded = value.trim();
    try {
        decoded = decodeURIComponent(decoded);
    }
    catch {
        // Compare the original value when malformed escaping is present.
    }
    const normalized = canonicalMcpServerName(decoded.replace(/^\.\//u, '').replace(/\/$/u, '').trim().toLowerCase());
    return normalized || undefined;
}
/**
 * Citation correction is an internal one-shot rewrite. Some models answer the
 * instruction itself instead of the draft, which must never be accepted as a
 * user-visible assistant message. This check only runs after that retry has
 * been requested, and requires multiple distinctive instruction fragments to
 * avoid treating ordinary source-format discussion as a failed correction.
 */
function isCitationRetryPromptLeak(text) {
    const promptFragments = [
        'Cite each used source once per sourced block.',
        'For Markdown tables, remove citations from individual rows/cells',
        'Web: exact URL.',
        'App/MCP:',
        'File: use the exact internal target as a Markdown link.',
        'Current draft JSON:',
        'I need to use the format:',
    ];
    return (text.includes('Rewrite only the current draft supplied below with localized citations.') ||
        promptFragments.filter((fragment) => text.includes(fragment)).length >= 2);
}
function buildCitationRetryPrompt(references, currentDraft, citationAliasState) {
    const candidates = references
        .map((reference) => reference.type === 'file'
        ? `File: [${escapeMarkdownLabel(reference.name)}](${sourceReferenceHref(citationIdFor(reference))})`
        : reference.type === 'web'
            ? `${escapeMarkdownLabel(reference.name)} => ${reference.url ?? ''}`
            : `${escapeMarkdownLabel(reference.name)} (${escapeMarkdownLabel(reference.tool_name)}) => ${sourceReferenceHref(modelCitationIdFor(reference, citationAliasState))}`)
        .join(', ');
    return `Rewrite only the current draft supplied below with localized citations. Do not reuse or rewrite any earlier assistant answer from the conversation. Preserve its content and formatting, including every <deliver-assets>, <deliver_assets>, and <media /> block exactly. Cite each used source once per sourced block. Treat one Markdown heading section as one sourced block; a table and its immediately following explanation belong to that same block. Within that block, cite the same target URL at most once, except that every code-file reference must remain individually sourced. For Markdown tables, remove citations from individual rows/cells and place one source line immediately below the table with each used source once, except code-file references, which stay linked in their cells. Web: exact URL. App/MCP: cite the exact target URL as a Markdown link and always label it with the App/MCP name; the client renders its icon. File: every code filename/path must use its listed exact internal target as a Markdown link; never leave it as inline code or plain text. For code use filename(line N) or filename(lines N-M); for other files use a concise filename/title. Never wrap factual answer text or a sentence/list/table cell. Never invent an HTTP URL for a local file, expose the local path in the link target, or turn an App/MCP tool name, API/interface name, result label, or artifact URL into a File citation. Omit unused targets; never output a bare parenthesized citation, repeat a non-file source within the same block, or list a source/provider name without its target link. Targets: ${candidates}. App/MCP URLs start #mavis-source=. File internal URLs also start #mavis-source=. Current draft JSON: ${JSON.stringify(currentDraft)}`;
}
function modelCitationIdFor(reference, state) {
    const citationId = citationIdFor(reference);
    return reference.type === 'app' || reference.type === 'mcp'
        ? shortCitationIdFor(citationId, state)
        : citationId;
}
//# sourceMappingURL=source-reference.js.map