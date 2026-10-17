import { LocalAgentContractError } from '../agent/contract.js';
import { AmbiguousAgentMemoryError, isRecord } from './desktop-memory-family.js';
import { LocalMemoryError } from './types.js';
const DEFAULT_AGENT_NAME = 'mavis';
export class DesktopMemoryServiceMutations {
    memory;
    agentResolver;
    constructor(memory, agentResolver) {
        this.memory = memory;
        this.agentResolver = agentResolver;
    }
    async resolveWriteAgent(req) {
        const requested = req.agentName?.trim() || DEFAULT_AGENT_NAME;
        if (!this.agentResolver)
            throw agentResolverUnavailable();
        this.assertAgentMemoryScope(await this.agentResolver.resolveAgentReadScope(requested));
        return this.agentResolver.resolveAgentWriteTarget(requested);
    }
    async resolveExactAgent(req) {
        const requested = req.agentName?.trim() || DEFAULT_AGENT_NAME;
        if (!this.agentResolver)
            throw agentResolverUnavailable();
        const scope = await this.agentResolver.resolveAgentReadScope(requested);
        this.assertAgentMemoryScope(scope);
        if (!req.agentName?.trim())
            return this.resolveCanonicalResourceAgent(requested, scope);
        // A bare Mavis identifies the canonical view; it is not an assertion that
        // a pre-Session-V2 Mavis directory exists. Explicit agent:main remains an
        // exact resource reference below.
        if (requested.toLowerCase() === DEFAULT_AGENT_NAME) {
            return this.resolveCanonicalResourceAgent(requested, scope);
        }
        return this.agentResolver.requireExactAgentKey(requested);
    }
    assertAgentMemoryScope(scope) {
        const primaryNames = new Set([DEFAULT_AGENT_NAME, 'main']);
        if (scope.trustedBuiltin !== true ||
            ![scope.canonicalName, scope.exactOwnerName]
                .filter((name) => Boolean(name))
                .some((name) => primaryNames.has(name))) {
            throw new LocalMemoryError('AGENT_SCOPE_DISABLED', 'Agent-scoped Memory is available only to the trusted primary Agent.');
        }
    }
    async resolveCanonicalResourceAgent(requested, scope) {
        if (!this.agentResolver)
            throw agentResolverUnavailable();
        // The shared V1 resolver type permits an older scope with no physical
        // owner. Keep that compatibility fallback on the same write resolver;
        // V2 Main-only scopes always provide exactOwnerName=main.
        return scope.exactOwnerName?.trim() || this.agentResolver.resolveAgentWriteTarget(requested);
    }
    appendMemory(_ctx, req) {
        return this.wrap(async () => {
            const result = await this.memory.appendMemory(await this.resolveWriteAgent(req), req.content);
            return { newSizeBytes: result.sizeBytes };
        });
    }
    writeMemory(_ctx, req) {
        return this.wrap(async () => {
            const result = isUserMemoryRequest(req)
                ? await this.memory.writeUserMemoryForManagement(req.content)
                : await this.memory.writeMemoryForManagement(await this.resolveWriteAgent(req), req.content);
            return { newSizeBytes: result.sizeBytes };
        });
    }
    editMemory(_ctx, req) {
        return this.wrap(async () => {
            const out = await this.memory.editMemory(await this.resolveExactAgent(req), req.oldString, req.newString, req.replaceAll);
            return { replacements: out.replacements, newSizeBytes: out.result.sizeBytes };
        });
    }
    writeMemoryTopic(_ctx, req) {
        return this.wrap(async () => {
            await this.memory.writeTopic(await this.resolveWriteAgent(req), req.topicName, req.description, req.content);
            return {};
        });
    }
    deleteMemoryTopic(_ctx, req) {
        return this.wrap(async () => ({
            deleted: await this.memory.deleteTopic(await this.resolveExactAgent(req), req.topicName),
        }));
    }
    appendMemoryTopic(_ctx, req) {
        return this.wrap(async () => this.memory.appendTopic(await this.resolveWriteAgent(req), req.topicName, req.content));
    }
    editMemoryTopic(_ctx, req) {
        return this.wrap(async () => this.memory.editTopic(await this.resolveExactAgent(req), req.topicName, req.oldString, req.newString, req.replaceAll));
    }
    writeMemoryDaily(_ctx, req) {
        return this.wrap(async () => {
            await this.memory.writeDaily(await this.resolveWriteAgent(req), req.date, req.content);
            return {};
        });
    }
    appendMemoryDaily(_ctx, req) {
        return this.wrap(async () => {
            await this.memory.appendDaily(await this.resolveWriteAgent(req), req.date, req.content);
            return {};
        });
    }
    deleteMemoryDaily(_ctx, req) {
        return this.wrap(async () => ({
            deleted: await this.memory.deleteDaily(await this.resolveExactAgent(req), req.date),
        }));
    }
    writeMemorySummary(_ctx, req) {
        return this.wrap(async () => {
            await this.memory.writeMemorySummary(await this.resolveWriteAgent(req), req.content);
            return {};
        });
    }
    snapshotForMemoryCleanup(_ctx, req) {
        return this.wrap(async () => this.memory.snapshotForCleanup(await this.resolveExactAgent(req), req.date));
    }
    archiveOldMemoryDaily(_ctx, req) {
        return this.wrap(async () => ({
            archivedCount: await this.memory.archiveOldDaily(await this.resolveExactAgent(req), req.ttlDays),
        }));
    }
    triggerMemoryCleanup(_ctx, req) {
        return this.wrap(async () => this.memory.triggerCleanup(await this.resolveExactAgent(req), req.force));
    }
    markMemorySession(_ctx, req) {
        return this.wrap(async () => {
            await this.memory.markSession(req.date, req.sessionId, await this.resolveExactAgent(req), req.wroteMemory);
            return {};
        });
    }
    markMemoryReminded(_ctx, req) {
        return this.wrap(async () => {
            await this.memory.markReminded(req.date, req.sessionId);
            return {};
        });
    }
    markMemoryReflected(_ctx, req) {
        return this.wrap(async () => {
            await this.memory.markReflected(req.date, req.sessionId, await this.resolveExactAgent(req), req.reflectedAt);
            return {};
        });
    }
    getMemoryReflectionTs(_ctx, req) {
        return this.wrap(async () => ({
            lastReflectedAt: await this.memory.getReflectionTs(req.sessionId),
        }));
    }
    async wrap(fn) {
        try {
            const result = await fn();
            const existingBaseResp = result.baseResp;
            return {
                ...result,
                baseResp: {
                    status_code: 0,
                    status_msg: 'OK',
                    ...(isRecord(existingBaseResp) ? existingBaseResp : {}),
                },
            };
        }
        catch (err) {
            const code = err instanceof LocalMemoryError
                ? err.code
                : err instanceof LocalAgentContractError
                    ? err.code
                    : 'LOCAL_MEMORY_ERROR';
            const message = err instanceof Error ? err.message : String(err);
            return {
                baseResp: {
                    status_code: 1,
                    status_msg: message,
                    code,
                    ...(err instanceof AmbiguousAgentMemoryError
                        ? { source_agent_names: [...err.sourceNames] }
                        : {}),
                },
            };
        }
    }
}
function isUserMemoryRequest(req) {
    return req.agentId === 0 && !req.agentName?.trim();
}
export function agentResolverUnavailable() {
    return new LocalMemoryError('AGENT_RESOLVER_UNAVAILABLE', 'Agent resolver is required for agent-scoped memory operations');
}
//# sourceMappingURL=desktop-memory-service-mutations.js.map