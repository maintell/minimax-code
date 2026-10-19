import { mergeMemorySources, readMemorySources, selectMemorySource, selectMainMemoryResource, } from './desktop-memory-family.js';
import { DesktopMemoryServiceMutations, agentResolverUnavailable, } from './desktop-memory-service-mutations.js';
/** Default requested key for omitted memory agent names. The shared
 * AgentService resolver maps this primary alias to the active primary row,
 * including a legacy-only `main` row; no operation silently chooses a folder.
 */
const DEFAULT_AGENT_NAME = 'mavis';
/**
 * Memory operations are agent-scoped through the shared AgentService seams;
 * omitted names use the primary alias above. An omitted get-unreminded filter
 * remains the explicit all-sessions case.
 */
export class DesktopMemoryService extends DesktopMemoryServiceMutations {
    telemetryHost;
    constructor(memory, agentResolver, telemetryHost) {
        super(memory, agentResolver);
        this.telemetryHost = telemetryHost;
    }
    async resolveReadScope(req) {
        const requested = req.agentName?.trim() || DEFAULT_AGENT_NAME;
        if (!this.agentResolver)
            throw agentResolverUnavailable();
        const scope = await this.agentResolver.resolveAgentReadScope(requested);
        this.assertAgentMemoryScope(scope);
        const sourceNames = [scope.canonicalName, ...(scope.compatibleNames ?? [])].filter((name, index, names) => name.trim().length > 0 && names.indexOf(name) === index);
        return { canonicalName: scope.canonicalName, sourceNames };
    }
    getMemory(_ctx, req) {
        return this.wrap(async () => {
            if (isUserMemoryRequest(req))
                return this.memory.getUserMemory();
            const scope = await this.resolveReadScope(req);
            const candidates = await readMemorySources(scope.sourceNames, (agentName) => this.memory.getAgentMemory(agentName));
            const selected = selectMainMemoryResource(candidates, scope.canonicalName, this.telemetryHost);
            return {
                ...selected.value,
                baseResp: { source_agent: selected.sourceAgent },
            };
        });
    }
    searchMemory(_ctx, req) {
        return this.wrap(async () => {
            const scope = await this.resolveReadScope(req);
            const results = await readMemorySources(scope.sourceNames, (agentName) => this.memory.searchMemory(agentName, req.query));
            const flattened = results.flatMap(({ sourceAgent, value }) => value.map((result) => ({ result, sourceAgent })));
            return {
                results: flattened.map(({ result }) => result),
                ...(scope.sourceNames.length > 1
                    ? { baseResp: { source_agents: flattened.map(({ sourceAgent }) => sourceAgent) } }
                    : {}),
            };
        });
    }
    listMemoryTopics(_ctx, req) {
        return this.wrap(async () => {
            const scope = await this.resolveReadScope(req);
            const sourceResults = await readMemorySources(scope.sourceNames, (agentName) => this.memory.listTopics(agentName));
            const topics = mergeMemorySources(sourceResults.flatMap(({ sourceAgent, value }) => value.map((entry) => ({ sourceAgent, value: entry }))), scope.canonicalName, (entry) => entry.name, 'topic', this.telemetryHost).sort((a, b) => a.value.name.localeCompare(b.value.name));
            return {
                topics: topics.map(({ value }) => value),
                maxTopics: 100,
                ...(scope.sourceNames.length > 1
                    ? { baseResp: { source_agents: topics.map(({ sourceAgent }) => sourceAgent) } }
                    : {}),
            };
        });
    }
    getMemoryTopic(_ctx, req) {
        return this.wrap(async () => {
            const scope = await this.resolveReadScope(req);
            const sourceResults = await readMemorySources(scope.sourceNames, (agentName) => this.memory.listTopics(agentName));
            const candidates = sourceResults.flatMap(({ sourceAgent, value }) => {
                const topic = value.find((entry) => entry.name === req.topicName);
                return topic ? [{ sourceAgent, value: topic }] : [];
            });
            const selected = selectMemorySource(candidates, scope.canonicalName, `topic:${req.topicName}`, this.telemetryHost);
            const sourceAgent = selected?.sourceAgent ?? scope.canonicalName;
            return {
                ...(await this.memory.getTopic(sourceAgent, req.topicName)),
                ...(scope.sourceNames.length > 1 ? { baseResp: { source_agent: sourceAgent } } : {}),
            };
        });
    }
    searchMemoryTopics(_ctx, req) {
        return this.wrap(async () => {
            const scope = await this.resolveReadScope(req);
            const sourceResults = await readMemorySources(scope.sourceNames, (agentName) => this.memory.searchTopics(agentName, req.keyword, Number.MAX_SAFE_INTEGER));
            const topics = mergeMemorySources(sourceResults.flatMap(({ sourceAgent, value }) => value.map((entry) => ({ sourceAgent, value: entry }))), scope.canonicalName, (entry) => entry.name, 'topic search', this.telemetryHost).sort((a, b) => a.value.name.localeCompare(b.value.name));
            const limit = req.limit === undefined ? 10 : Math.max(0, req.limit);
            const sliced = topics.slice(0, limit);
            return {
                topics: sliced.map(({ value }) => value),
                ...(scope.sourceNames.length > 1
                    ? { baseResp: { source_agents: sliced.map(({ sourceAgent }) => sourceAgent) } }
                    : {}),
            };
        });
    }
    listMemoryDaily(_ctx, req) {
        return this.wrap(async () => {
            const scope = await this.resolveReadScope(req);
            const sourceResults = await readMemorySources(scope.sourceNames, (agentName) => this.memory.listDaily(agentName, Number.MAX_SAFE_INTEGER, 0, req.includeArchived));
            const files = mergeMemorySources(sourceResults.flatMap(({ sourceAgent, value }) => value.files.map((entry) => ({ sourceAgent, value: entry }))), scope.canonicalName, (entry) => `${entry.date}\0${entry.archived ? 'archived' : 'active'}`, 'daily', this.telemetryHost).sort((a, b) => b.value.date.localeCompare(a.value.date) ||
                Number(a.value.archived) - Number(b.value.archived));
            const offset = Math.max(0, req.offset ?? 0);
            const limit = req.limit === undefined ? 20 : Math.max(0, req.limit);
            const sliced = files.slice(offset, offset + limit);
            return {
                files: sliced.map(({ value }) => value),
                total: files.length,
                ...(scope.sourceNames.length > 1
                    ? { baseResp: { source_agents: sliced.map(({ sourceAgent }) => sourceAgent) } }
                    : {}),
            };
        });
    }
    getMemoryDaily(_ctx, req) {
        return this.wrap(async () => {
            const scope = await this.resolveReadScope(req);
            const sourceResults = await readMemorySources(scope.sourceNames, (agentName) => this.memory.listDaily(agentName, Number.MAX_SAFE_INTEGER, 0, false));
            const candidates = sourceResults.flatMap(({ sourceAgent, value }) => {
                const file = value.files.find((entry) => entry.date === req.date && !entry.archived);
                return file ? [{ sourceAgent, value: file }] : [];
            });
            const selected = selectMemorySource(candidates, scope.canonicalName, `daily:${req.date}`, this.telemetryHost);
            const sourceAgent = selected?.sourceAgent ?? scope.canonicalName;
            return {
                ...(await this.memory.getDaily(sourceAgent, req.date)),
                ...(scope.sourceNames.length > 1 ? { baseResp: { source_agent: sourceAgent } } : {}),
            };
        });
    }
    listMemoryArchive(_ctx, req) {
        return this.wrap(async () => {
            const scope = await this.resolveReadScope(req);
            const sourceResults = await readMemorySources(scope.sourceNames, (agentName) => this.memory.listArchive(agentName, Number.MAX_SAFE_INTEGER, 0));
            const entries = mergeMemorySources(sourceResults.flatMap(({ sourceAgent, value }) => value.entries.map((entry) => ({ sourceAgent, value: entry }))), scope.canonicalName, (entry) => `${entry.snapshotDate}\0${entry.fileName}`, 'archive', this.telemetryHost).sort((a, b) => b.value.snapshotDate.localeCompare(a.value.snapshotDate) ||
                a.value.fileName.localeCompare(b.value.fileName));
            const offset = Math.max(0, req.offset ?? 0);
            const limit = req.limit === undefined ? 20 : Math.max(0, req.limit);
            const sliced = entries.slice(offset, offset + limit);
            return {
                entries: sliced.map(({ value }) => value),
                total: entries.length,
                ...(scope.sourceNames.length > 1
                    ? { baseResp: { source_agents: sliced.map(({ sourceAgent }) => sourceAgent) } }
                    : {}),
            };
        });
    }
    getMemoryArchive(_ctx, req) {
        return this.wrap(async () => {
            const scope = await this.resolveReadScope(req);
            const candidates = (await readMemorySources(scope.sourceNames, async (sourceAgent) => {
                const listed = await this.memory.listArchive(sourceAgent, Number.MAX_SAFE_INTEGER, 0);
                return listed.entries.some((entry) => entry.snapshotDate === req.snapshotDate && entry.fileName === req.fileName);
            })).flatMap(({ sourceAgent, value }) => (value ? [{ sourceAgent }] : []));
            const selected = selectMemorySource(candidates.map(({ sourceAgent }) => ({ sourceAgent, value: true })), scope.canonicalName, `archive:${req.snapshotDate}/${req.fileName}`, this.telemetryHost);
            const sourceAgent = selected?.sourceAgent ?? scope.canonicalName;
            return {
                ...(await this.memory.getArchive(sourceAgent, req.snapshotDate, req.fileName)),
                ...(scope.sourceNames.length > 1 ? { baseResp: { source_agent: sourceAgent } } : {}),
            };
        });
    }
    getUnremindedMemory(_ctx, req) {
        return this.wrap(async () => {
            // agent_name optional here: omitted → all sessions for the date.
            const agentName = req.agentName?.trim();
            const readScope = agentName ? await this.resolveReadScope(req) : undefined;
            const entries = agentName
                ? (await readMemorySources(readScope.sourceNames, (sourceAgent) => this.memory.getUnreminded(req.date, sourceAgent))).flatMap(({ value }) => value)
                : await this.memory.getUnreminded(req.date);
            // The generated MemoryUnremindedEntry still carries the cloud `agent_id`
            // (required i64). Local has no snowflake, so report 0 and let agent_name
            // be the real local identifier.
            return {
                entries: entries.map((entry) => ({
                    sessionId: entry.sessionId,
                    agentId: 0,
                    agentName: entry.agentName,
                    wroteMemory: entry.wroteMemory,
                    reminded: entry.reminded,
                    checkedAt: entry.checkedAt,
                    ...(entry.lastReflectedAt ? { lastReflectedAt: entry.lastReflectedAt } : {}),
                })),
                ...(readScope && readScope.sourceNames.length > 1
                    ? { baseResp: { source_agents: entries.map((entry) => entry.agentName) } }
                    : {}),
            };
        });
    }
}
function isUserMemoryRequest(req) {
    return req.agentId === 0 && !req.agentName?.trim();
}
//# sourceMappingURL=desktop-memory-service.js.map