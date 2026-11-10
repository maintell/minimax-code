import { LocalAgentContractError } from '../../../infra/legacy-db/agent-contract.js';
import { json } from '../../../infra/transport/host-http.js';
const VALID_GROUP_BY = new Set(['agent', 'session', 'model', 'day']);
export async function routeLocalUsageSummaryApi(input) {
    const range = parseUsageRange(input.url);
    const groupBy = parseUsageGroupBy(input.url.searchParams.get('group'));
    const agentNames = await resolveUsageAgentNames(input.url, input.agentResolver);
    const filter = agentNames === undefined ? range : { ...range, agentNames };
    const summary = await input.usageStore.summarizeGlobal(filter);
    if (!groupBy)
        return json({ summary });
    const groups = await input.usageStore.summarizeGroupBy(groupBy, filter);
    return json({ summary, groups });
}
export async function recordLocalTokenUsageFromPiMessages(input) {
    for (const message of input.messages) {
        const usage = readPiUsage(message);
        if (!usage)
            continue;
        await input.usageStore.append({
            sessionId: input.session.sessionId,
            agentName: input.session.agentName,
            frameworkType: 'pi-agent',
            turnId: input.turnId,
            model: input.model ?? null,
            ts: readMessageTimestamp(message) ?? input.nowMs(),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            costUsd: usage.costUsd ?? null,
            raw: JSON.stringify(usage.raw),
        });
    }
}
function parseUsageRange(url) {
    const from = parseTimestampQuery(url.searchParams.get('from'), 'from');
    const to = parseTimestampQuery(url.searchParams.get('to'), 'to');
    if (from !== undefined && to !== undefined && from > to) {
        throw new Error(`Invalid range: from (${String(from)}) > to (${String(to)})`);
    }
    return {
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
    };
}
async function resolveUsageAgentNames(url, resolver) {
    const requestedName = url.searchParams.get('agentName') ?? url.searchParams.get('agent');
    if (requestedName === null)
        return undefined;
    if (!resolver) {
        throw new LocalAgentContractError(503, 'Agent read resolver is unavailable', 'AGENT_RESOLVER_UNAVAILABLE');
    }
    const scope = await resolver.resolveAgentReadScope(requestedName);
    return normalizeUsageAgentNames(scope.compatibleNames, scope.canonicalName);
}
function normalizeUsageAgentNames(compatibleNames, canonicalName) {
    const names = compatibleNames?.length ? compatibleNames : [canonicalName];
    return [...new Set(names)].filter((name) => name.length > 0);
}
function parseTimestampQuery(value, paramName) {
    if (value === null || value === '')
        return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`Invalid query param ${paramName}: "${value}"`);
    }
    return parsed;
}
function parseUsageGroupBy(value) {
    if (value === null || value === '')
        return undefined;
    if (!VALID_GROUP_BY.has(value)) {
        throw new Error(`Invalid group "${value}"`);
    }
    return value;
}
function readPiUsage(message) {
    const record = message;
    if (record.role !== 'assistant')
        return undefined;
    if (!record.usage || typeof record.usage !== 'object')
        return undefined;
    const usage = record.usage;
    const tokens = readPiUsageTokens(usage);
    if (Object.values(tokens).every((value) => value === 0))
        return undefined;
    const costUsd = typeof usage.cost?.total === 'number' && Number.isFinite(usage.cost.total)
        ? usage.cost.total
        : null;
    return { ...tokens, costUsd, raw: record.usage };
}
function readPiUsageTokens(usage) {
    const piInput = numericOrZero(usage.input);
    const piOutput = numericOrZero(usage.output);
    const reasoningTokens = numericOrZero(usage.reasoning);
    const cacheReadTokens = numericOrZero(usage.cacheRead ?? usage.cache?.read ?? usage.cache_read);
    const cacheWriteTokens = numericOrZero(usage.cacheWrite ?? usage.cache?.write ?? usage.cache_write);
    const protocolTotal = numericOrZero(usage.total_tokens);
    const hasPiTokens = piInput > 0 || piOutput > 0;
    return {
        inputTokens: hasPiTokens ? piInput : protocolTotal,
        outputTokens: hasPiTokens ? piOutput : 0,
        reasoningTokens,
        cacheReadTokens,
        cacheWriteTokens,
    };
}
function readMessageTimestamp(message) {
    const record = message;
    return numericOrUndefined(record.timestamp ?? record.created_at);
}
function numericOrZero(value) {
    return numericOrUndefined(value) ?? 0;
}
function numericOrUndefined(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
//# sourceMappingURL=usage-api.js.map