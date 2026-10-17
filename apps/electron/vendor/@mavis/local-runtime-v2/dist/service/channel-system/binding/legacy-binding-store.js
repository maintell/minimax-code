/**
 * Legacy channel binding YAML store (`channel-bindings.yaml`, `bindings` +
 * `messageFilters` sections).
 *
 * Migration copy (MR1): extracted from v1 `channels/infra.ts` (the class
 * lived inline in the 2k-line hub file). Behaviour and on-disk layout are
 * unchanged; the unknown-field preservation contract lives in
 * `channel-binding-codec.ts` (mergeChannelBindingsIntoDocument), and the
 * per-file mutation lane lives in `storage/durable-yaml.ts` (proposal §8).
 */
import { join } from 'node:path';
import { channelRoutingModeForStrategy } from '@mavis/shared';
import { buildLocalChannelBindingKey } from '../ingress/channel-inbound-utils.js';
import { channelBindingProjectConflicts, defaultChannelMessageFilter, hasMultiProjectChannelBindingProfile, mergeChannelBindingsIntoDocument, normalizeChannelBinding, normalizeChannelMessageFilter, validChannelBindingRawKeys, } from './channel-binding-codec.js';
import { attachProjectMainBinding, advanceProjectMainBindings, } from './channel-binding-project-main.js';
import { LocalChannelRootlessError, multiProjectBindingError } from '../errors.js';
import { mutateDurableYaml, readYamlDocument } from './storage/durable-yaml.js';
export class LocalChannelBindingStore {
    dataDir;
    nowMs;
    bindings = new Map();
    messageFilters = new Map();
    constructor(dataDir, nowMs) {
        this.dataDir = dataDir;
        this.nowMs = nowMs;
    }
    async list(filter = {}) {
        await this.refresh();
        return [...this.bindings.values()]
            .filter((binding) => !filter.agentName || binding.agentName === filter.agentName)
            .filter((binding) => !filter.sessionId || binding.sessionId === filter.sessionId)
            .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))
            .map((binding) => ({ ...binding }));
    }
    async get(ctx) {
        return this.getByKey(buildLocalChannelBindingKey(ctx));
    }
    async getByKey(key) {
        await this.refresh();
        const binding = this.bindings.get(key);
        return binding ? { ...binding } : undefined;
    }
    async assertProjectProfile(ctx, exactOwnerName, projectKey, ownKey) {
        await this.refresh();
        if (channelBindingProjectConflicts({
            bindings: this.bindings.values(),
            key: ownKey,
            exactOwnerName,
            platform: ctx.platform,
            clientName: ctx.clientName,
            projectKey,
        })) {
            throw multiProjectBindingError();
        }
    }
    async attachProjectMain(ctx, source, routeRuleId) {
        return this.mutate(() => ({
            changed: true,
            value: attachProjectMainBinding({
                bindings: this.bindings,
                ctx,
                source,
                routeRuleId,
                nowMs: this.nowMs(),
            }),
        }));
    }
    async advanceProjectMain(ctx, source, write) {
        return this.mutate(() => ({
            changed: true,
            value: advanceProjectMainBindings({
                bindings: this.bindings,
                ctx,
                source,
                write,
                nowMs: this.nowMs(),
            }),
        }));
    }
    async upsert(ctx, input) {
        return this.mutate(() => {
            const key = buildLocalChannelBindingKey(ctx);
            const existing = this.bindings.get(key);
            const binding = this.buildBinding(ctx, input, existing, existing?.generation ?? 0);
            this.bindings.set(key, binding);
            return { changed: true, value: { ...binding } };
        });
    }
    /** Publish one v2 binding only when the caller still owns the observed generation. */
    async compareAndSet(ctx, input) {
        return this.mutate(() => {
            const key = buildLocalChannelBindingKey(ctx);
            const existing = this.bindings.get(key);
            const actualGeneration = existing?.generation ?? 0;
            if (actualGeneration !== input.expectedGeneration) {
                throw new LocalChannelRootlessError(409, 'CHANNEL_BINDING_GENERATION_CONFLICT', 'Channel binding generation changed.');
            }
            if (channelBindingProjectConflicts({
                bindings: this.bindings.values(),
                key,
                exactOwnerName: input.exactOwnerName,
                platform: ctx.platform,
                clientName: ctx.clientName,
                projectKey: input.projectKey,
            })) {
                throw multiProjectBindingError();
            }
            const binding = this.buildBinding(ctx, input, existing, actualGeneration + 1);
            this.bindings.set(key, binding);
            return { changed: true, value: { ...binding } };
        });
    }
    /**
     * Add v2 fences to the original binding file without creating a Session.
     * `resolve` may return undefined for a binding whose Agent no longer exists
     * (deterministic dead reference): that binding is kept byte-identical so
     * startup never bricks on it; inbound answers it with a receipt instead.
     */
    async migrateToV2(resolve, options = {}) {
        await this.mutate(async () => {
            for (const [key, binding] of this.bindings) {
                const target = await resolve(binding);
                if (!target)
                    continue;
                this.bindings.set(key, {
                    ...binding,
                    exactOwnerName: target.exactOwnerName,
                    ...(target.ownerKind === 'custom' && target.ownerInstanceId
                        ? { ownerInstanceId: target.ownerInstanceId }
                        : { ownerInstanceId: undefined }),
                    projectKey: target.projectKey,
                    routingMode: channelRoutingModeForStrategy(binding.strategy),
                    generation: Math.max(1, binding.generation),
                });
            }
            if (hasMultiProjectChannelBindingProfile([...this.bindings.values()].filter((binding) => !options.isSkipped?.(binding)))) {
                throw multiProjectBindingError();
            }
            return { changed: true, value: undefined };
        });
    }
    async pin(ctx, agentName, sessionId) {
        return this.upsert(ctx, {
            agentName,
            sessionId,
            strategy: 'root',
            pinned: true,
            routeRuleId: null,
        });
    }
    async pinAllForAgent(agentName, sessionId) {
        return this.mutate(() => {
            let count = 0;
            const now = this.nowMs();
            for (const [key, binding] of this.bindings) {
                if (binding.agentName !== agentName)
                    continue;
                this.bindings.set(key, {
                    ...binding,
                    sessionId,
                    strategy: 'root',
                    routingMode: 'project-main',
                    pinned: true,
                    generation: binding.generation + 1,
                    updatedAt: now,
                });
                count++;
            }
            return { changed: count > 0, value: count };
        });
    }
    /**
     * Legacy storage compatibility API. Root swaps and inbound routing never
     * call it; retained so old local integrations can still read/write files.
     */
    async migratePinnedSession(agentName, fromSessionId, toSessionId) {
        return this.migratePinnedSessionForAgents([agentName], fromSessionId, toSessionId);
    }
    /** Legacy family-wide storage compatibility variant; no runtime consumer. */
    async migratePinnedSessionForAgents(agentNames, fromSessionId, toSessionId) {
        if (fromSessionId === toSessionId)
            return 0;
        const names = new Set(agentNames.map((name) => name.trim()).filter(Boolean));
        if (names.size === 0)
            return 0;
        return this.mutate(() => {
            let count = 0;
            const now = this.nowMs();
            for (const [key, binding] of this.bindings) {
                if (!names.has(binding.agentName))
                    continue;
                if (binding.sessionId !== fromSessionId)
                    continue;
                if (!binding.pinned)
                    continue;
                this.bindings.set(key, {
                    ...binding,
                    sessionId: toSessionId,
                    generation: binding.generation + 1,
                    updatedAt: now,
                });
                count++;
            }
            return { changed: count > 0, value: count };
        });
    }
    /**
     * Move one primary-family client's bindings + message filter onto the
     * canonical client (plan §6.2). `mode: 'inspect'` reports what would happen
     * without writing, so the reconciler can refuse the whole convergence before
     * it touches any store.
     *
     * Per entry: target missing → move; target identical → dedupe the legacy
     * copy; same key with a different `sessionId` / `strategy` / `routeRuleId`
     * → conflict. Pin is opaque legacy data and does not participate in matching
     * or conflicts. Message filters key on `clientId` and follow the same rule;
     * a differing filter is a conflict rather than a silent pick of the wider one.
     */
    async rekeyPrimaryFamily(input) {
        return this.mutate(() => {
            const plan = this.planPrimaryFamilyRekey(input);
            const result = plan.result;
            if (input.mode === 'inspect' || result.conflicts.length > 0) {
                return { changed: false, value: result };
            }
            this.applyPrimaryFamilyRekey(input, plan);
            return { changed: result.moved > 0 || result.deduped > 0, value: result };
        });
    }
    /** Decision phase of {@link rekeyPrimaryFamily}; touches no store state. */
    planPrimaryFamilyRekey(input) {
        const conflicts = [];
        const moves = [];
        const drops = [];
        for (const [key, binding] of this.bindings) {
            if (binding.clientName !== input.from.clientName)
                continue;
            const decision = this.decideBindingRekey(binding, input.to);
            if (decision.kind === 'move')
                moves.push({ fromKey: key, binding: decision.binding });
            else if (decision.kind === 'drop')
                drops.push(key);
            else
                conflicts.push(`channel_binding:${decision.key}`);
        }
        const { filterAction, legacyFilter } = this.decideFilterRekey(input, conflicts);
        return {
            moves,
            drops,
            filterAction,
            ...(legacyFilter ? { legacyFilter } : {}),
            result: {
                conflicts,
                moved: moves.length + (filterAction === 'move' ? 1 : 0),
                deduped: drops.length + (filterAction === 'drop' ? 1 : 0),
            },
        };
    }
    /** Apply phase of {@link rekeyPrimaryFamily}. */
    applyPrimaryFamilyRekey(input, plan) {
        for (const move of plan.moves) {
            this.bindings.delete(move.fromKey);
            this.bindings.set(move.binding.key, move.binding);
        }
        for (const key of plan.drops)
            this.bindings.delete(key);
        if (plan.filterAction === 'move' && plan.legacyFilter) {
            this.messageFilters.set(input.to.clientName, plan.legacyFilter);
        }
        if (plan.filterAction !== 'none')
            this.messageFilters.delete(input.from.clientName);
    }
    /** Per-entry rekey rule: move to a free key, dedupe an identical copy, else conflict. */
    decideBindingRekey(binding, to) {
        const rekeyed = {
            ...binding,
            clientName: to.clientName,
            agentName: to.agentName,
            exactOwnerName: to.agentName,
            generation: binding.generation + 1,
            updatedAt: this.nowMs(),
            key: buildLocalChannelBindingKey({
                platform: binding.platform,
                chatType: '',
                chatId: binding.chatId,
                senderId: binding.senderId,
                clientName: to.clientName,
                ...(binding.threadId ? { threadId: binding.threadId } : {}),
                lane: binding.lane,
            }),
        };
        const existing = this.bindings.get(rekeyed.key);
        if (!existing)
            return { kind: 'move', binding: rekeyed };
        if (existing.sessionId === binding.sessionId &&
            existing.strategy === binding.strategy &&
            (existing.routeRuleId ?? null) === (binding.routeRuleId ?? null)) {
            return { kind: 'drop' };
        }
        return { kind: 'conflict', key: rekeyed.key };
    }
    /** Message filters follow the same move/dedupe/conflict rule, keyed on clientId. */
    decideFilterRekey(input, conflicts) {
        const legacyFilter = this.messageFilters.get(input.from.clientName);
        const canonicalFilter = this.messageFilters.get(input.to.clientName);
        if (legacyFilter && !canonicalFilter)
            return { filterAction: 'move', legacyFilter };
        if (legacyFilter && canonicalFilter) {
            const identical = legacyFilter.mode === canonicalFilter.mode &&
                legacyFilter.includeToolSummary === canonicalFilter.includeToolSummary;
            if (identical)
                return { filterAction: 'drop', legacyFilter };
            conflicts.push(`message_filter:${input.from.clientName}`);
        }
        return { filterAction: 'none', ...(legacyFilter ? { legacyFilter } : {}) };
    }
    async deleteByKey(key) {
        return this.mutate(() => {
            const deleted = this.bindings.delete(key);
            return { changed: deleted, value: deleted };
        });
    }
    async deleteByAgent(agentName) {
        return this.deleteWhere((binding) => binding.agentName === agentName);
    }
    /**
     * Platform-scoped variant of {@link deleteByAgent}.
     *
     * An unbind is always platform-scoped: unbinding one agent's Feishu app must
     * not drop the Telegram and WeChat bindings of the SAME agent, which the
     * agentName-only delete would do. Callers cleaning up after one platform's
     * unbind must use this.
     */
    async deleteByAgentPlatform(agentName, platform) {
        return this.deleteWhere((binding) => binding.agentName === agentName && binding.platform === platform);
    }
    async deleteBySession(sessionId) {
        return this.deleteWhere((binding) => binding.sessionId === sessionId);
    }
    async getMessageFilter(clientId) {
        await this.refresh();
        return this.messageFilters.get(clientId) ?? defaultChannelMessageFilter();
    }
    async setMessageFilter(clientId, filter) {
        const next = {
            mode: filter.mode === 'full' ? 'full' : 'result',
            includeToolSummary: filter.includeToolSummary === true,
        };
        return this.mutate(() => {
            this.messageFilters.set(clientId, next);
            return { changed: true, value: next };
        });
    }
    async refresh() {
        this.hydrate(await readYamlDocument(this.filePath));
    }
    hydrate(document) {
        this.bindings = new Map();
        this.messageFilters = new Map();
        const bindings = document.bindings;
        if (bindings && typeof bindings === 'object') {
            for (const [key, value] of Object.entries(bindings)) {
                const binding = normalizeChannelBinding(key, value, this.nowMs());
                if (binding)
                    this.bindings.set(binding.key, binding);
            }
        }
        const filters = document.messageFilters;
        if (filters && typeof filters === 'object') {
            for (const [clientId, value] of Object.entries(filters)) {
                const filter = normalizeChannelMessageFilter(value);
                if (filter)
                    this.messageFilters.set(clientId, filter);
            }
        }
    }
    async mutate(operation) {
        return mutateDurableYaml(this.filePath, async (document) => {
            const priorKeys = validChannelBindingRawKeys(document, this.nowMs());
            this.hydrate(document);
            const result = await operation();
            if (result.changed) {
                mergeChannelBindingsIntoDocument(document, this.bindings, this.messageFilters, priorKeys);
            }
            return result;
        });
    }
    deleteWhere(predicate) {
        return this.mutate(() => {
            let count = 0;
            for (const [key, binding] of this.bindings) {
                if (!predicate(binding))
                    continue;
                this.bindings.delete(key);
                count++;
            }
            return { changed: count > 0, value: count };
        });
    }
    buildBinding(ctx, input, existing, generation) {
        const now = this.nowMs();
        return {
            key: buildLocalChannelBindingKey(ctx),
            platform: ctx.platform,
            clientName: ctx.clientName,
            chatId: ctx.chatId,
            senderId: ctx.senderId,
            threadId: ctx.threadId ?? '',
            lane: ctx.lane ?? 'interactive',
            agentName: input.agentName,
            sessionId: input.sessionId,
            strategy: input.strategy,
            pinned: input.pinned ?? existing?.pinned ?? false,
            routeRuleId: input.routeRuleId ?? null,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            ...writeGovernanceFields(input, existing),
            generation,
        };
    }
    get filePath() {
        return join(this.dataDir(), 'channel-bindings.yaml');
    }
}
/** Owner/Project/routing governance columns with their write-time defaults. */
function writeGovernanceFields(input, existing) {
    return {
        exactOwnerName: input.exactOwnerName ?? input.agentName,
        ...(input.ownerInstanceId ? { ownerInstanceId: input.ownerInstanceId } : {}),
        projectKey: input.projectKey ?? existing?.projectKey ?? 'default',
        routingMode: input.routingMode ?? channelRoutingModeForStrategy(input.strategy),
    };
}
//# sourceMappingURL=legacy-binding-store.js.map