/**
 * What AgentHost's orchestration core uses of the shared Tool Search and
 * compaction-summary code. Core may not import `@mavis/agent-tools`; this
 * concrete adapter is its one entry to it.
 */
export { compactionSummaryKey, compactionSummaryTimestamp, createToolSearchContextHook, createToolSearchResponseHook, endToolSearchWindow, findLastCompactionSummary, forgetToolSearchAnnouncements, projectToolSearchContext, } from '@mavis/agent-tools';
//# sourceMappingURL=tool-search.js.map