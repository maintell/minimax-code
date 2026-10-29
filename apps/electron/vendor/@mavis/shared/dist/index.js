export { MEMORY_SOFT_LIMIT_BYTES, MEMORY_HARD_LIMIT_BYTES, MEMORY_INJECTION_CAP_CHARS, MEMORY_CONTEXT_CAP_CHARS, MEMORY_TOOL_OUTPUT_MAX_BYTES, MEMORY_SUMMARY_INJECTION_CAP_CHARS, MEMORY_TAIL_INJECTION_CAP_CHARS, DAILY_RECENT_CAP_CHARS, MEMORY_CLEANUP_TRIGGER_BYTES, MEMORY_CLEANUP_MIN_BYTES, MAX_TOPIC_FILES, MAX_TOPIC_FILE_BYTES, DAILY_DIGEST_TTL_DAYS, CLEANUP_DEDUP_WINDOW_MS, } from './memory-limits.js';
export { createMemoryContextBudget, memoryContextCharsUsed } from './memory-context-budget.js';
export { loadBetterSqlite3 } from './sqlite-driver.js';
export { normalizeProductBuildEnvironment, resolveProductBuildIdentity, } from './product-build-identity.js';
export { buildPluginSkillRuntimeName } from './plugin-skill-name.js';
export { toNavigationPlainText } from './navigation-text.js';
export { collectFetchedWebSources } from './fetched-web-sources.js';
export { collectUsedWebEvidenceIds } from './web-source-evidence.js';
export { collectWebSourceCitations, } from './markdown-source-citation.js';
export { buildToolCallCitationId, compactToolCallCitationKey, findUniqueSingleSubstitutionCitationAlias, resolveKnownCitationAlias, } from './source-citation-id.js';
export { KeyedOperationLane } from './keyed-operation-lane.js';
export { isSensitiveHandoffPath } from './session-handoff-sensitive-path.js';
export { OPENROUTER_ATTRIBUTION_HEADERS, isOpenRouterApiUrl, withOpenRouterAttributionHeaders, } from './openrouter-attribution.js';
export { retryWindowsFileSystemOperation, } from './windows-file-system.js';
export { SESSION_LLM_RETRY_EVENT_TYPE } from './llm-retry-event.js';
export { MAVIS_BROWSER_EXTENSION_ID, getHostName, generateManifest, serializeManifest, getNativeHostDirs, getManifestFileName, getManifestPath, generateHostWrapper, getWindowsRegistryEntries, } from './browser-manifest.js';
// Owner `<mavis-thinking>` and `<mavis-progress>` block helpers — single
// source of truth for daemon, IM forwarders, and UI. Keep both packages on
// the same regex/strip semantics; do not redefine the regex elsewhere.
export { MAVIS_THINKING_BLOCK_RE, MAVIS_PROGRESS_BLOCK_RE, MAVIS_INNERMOST_PAIRED_BLOCK_RE, stripMavisThinkingTags, stripMavisProgressTags, stripMavisTagsForIm, extractVisibleContent, isThinkingOrProgressOnly, isThinkingOnlyContent, containsMavisProgressBlock, containsMavisThinkingBlock, containsMavisPairedBlock, } from './mavis-tags.js';
export { parseWatchInterval, parseSelfReminderTtl, appendTtlPromptSuffix, generateWatchCronName, DEFAULT_SELF_REMINDER_TTL_SECONDS, MAX_SELF_REMINDER_TTL_SECONDS, TTL_NEVER, } from './watch-interval.js';
// Mid-turn queued-user-message injection wrapper — shared by local-runtime
// compatibility imports (Path A) and cloud-runtime (Path B) so the wire
// format stays identical.
export { QUEUED_USER_MESSAGE_TAG, escapeQueuedUserMessageTags, wrapQueuedMessageText, wrapQueuedMessageBatch, } from './queued-message-wrapper.js';
// Shared aggregator for drained queued user-message batches — local-runtime
// and cloud-runtime both apply the same IM-priority rule: any IM wins,
// multiple IMs → last IM in FIFO order.
export { isChannelSource, aggregateQueuedSource } from './queued-message-source.js';
export { CRON_SESSION_PURPOSE_PREFIX, MEMORY_CLEANUP_CRON_NAME, createCronSessionPurpose, formatCronRunTitle, isLegacyMemoryCleanupTitle, parseCronSessionPurpose, } from './cron-purpose.js';
export { DESKTOP_METRICS_BATCH_PATH, MetricsClient, MetricsReporter, MetricsReportError, buildMetricKey, createDesktopReporter, createMetricsClient, } from './metrics-proxy.js';
export { createStructuredLogger, wrapTraceContextLogger, createDiskLogTransport, formatHourKey, } from './logging/index.js';
export { channelRoutingModeForStrategy, normalizeSessionStrategy } from './channel-route.js';
export { AGENT_REQUEST_REF_DESCRIPTION, CANONICAL_SUBAGENT_ROLES, LOCAL_MAVIS_AGENT_NAME_DESCRIPTION, RESERVED_SUBAGENT_NAMES, SUBAGENT_ROLES, agentNameDescription, isCanonicalSubagentRole, isTrustedBuiltinCreationSource, resolveCanonicalSubagentRole, roleDirectoryText, toAgentRequestRef, } from './subagent-roles.js';
export { createTraceContext, childSpan, createChannelContext, toRequestContext, traceToRequestContext, } from './channel-context.js';
export { getResponseFormatHint } from './channel-format-hints.js';
// ---------------------------------------------------------------------------
// Canonical media-asset metadata inferers (mime / kind) + the strict,
// structured outbound-media tag parser. PORTED from the feat/im-genui-full
// branch to give the IM outbound side a UI-free canonical implementation.
// `inferAssetMimeType` infers a MIME type from type/extension (the agent never
// emits one); `deriveMediaKind` maps onto the four IM send primitives
// (image/file/audio/video); `parseMediaTags` extracts `<media>` / wrapper tags
// from a reply. The UI's result-card-utils.ts still has a parallel copy;
// deduping it to re-export from here is a tracked follow-up.
// ---------------------------------------------------------------------------
export { MIME_BY_EXTENSION, WORKSPACE_IMAGE_PREVIEW_MIME_TYPES, inferAssetMimeType, getWorkspaceImagePreviewMimeType, isImageAsset, isWebAsset, isWebsiteAsset, supportsCanvasImageAnnotation, supportsWorkspaceImagePreview, deriveMediaKind, } from './media-asset-meta.js';
export { parseMediaTags } from './outbound-media.js';
// IM-outbound text sanitizer: rewrites agent-emitted `<media>` /
// `<deliver-assets>` XML to short placeholders so unrecognized media-ish tags
// never leak as literal XML. Belt-and-suspenders fallback after `parseMediaTags`
// (the structured extractor) on the local-runtime outbound path.
export { placeholderMediaTags } from './im-text-sanitize.js';
export { ASK_OTHER_PLACEHOLDER, ASK_USER_TOOL_NAME } from './questionnaire.js';
export { withOpenCodeGoHeaders } from './opencode-go-headers.js';
export { MINIMAX_CODE_USER_AGENT, withMiniMaxCodeUserAgent } from './minimax-code-user-agent.js';
//# sourceMappingURL=index.js.map