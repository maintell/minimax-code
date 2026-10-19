/**
 * Migration copy (MR1) of v1 `channels/rootless-route-resolver.ts`.
 */
import { KeyedOperationLane } from '@mavis/shared';
import { buildLocalChannelBindingKey } from '../ingress/channel-inbound-utils.js';
import { buildScopeKey, buildSessionPurpose, buildSessionTitle, contextForBinding, strategyForRoutingMode, } from './rootless-route-context.js';
import { isCompatibleChannelAgentOwner, } from '../binding/agent-owner-compatibility.js';
import { LocalChannelRootlessError, multiProjectBindingError } from '../errors.js';
// LocalChannelRootlessError / multiProjectBindingError moved to
// `../errors.ts` (shared with the binding stores without a cycle); re-exported
// here so existing import sites keep working.
export { LocalChannelRootlessError } from '../errors.js';
/** Stateful only for the semantic-scope queue; persistence stays in the v1 YAML store. */
export class RootlessChannelRouteCoordinator {
    bindingStore;
    options;
    scopeLane = new KeyedOperationLane();
    constructor(bindingStore, options) {
        this.bindingStore = bindingStore;
        this.options = options;
    }
    async resolveExisting(ctx) {
        const current = await this.bindingStore.get(ctx);
        if (!current)
            return undefined;
        const owner = await readOwnerIdentityOrUndefined(this.options, current.agentName);
        if (!owner ||
            !(await isCompatibleChannelAgentOwner({
                persisted: current,
                current: owner,
                ...(this.options.resolveAgentReadScope
                    ? { resolveAgentReadScope: this.options.resolveAgentReadScope }
                    : {}),
            }))) {
            return undefined;
        }
        if (current.routingMode === 'project-main') {
            await this.projectMainProfile(ctx, owner, current.projectKey);
        }
        return (await this.validateBinding(current)) ? this.resolvedFromBinding(current) : undefined;
    }
    resolve(ctx, preview, strategy) {
        return this.scopeLane.run(buildScopeKey(preview, ctx), async () => {
            const current = await this.bindingStore.get(ctx);
            if (current && (await this.validateBinding(current))) {
                return this.resolvedFromBinding(current);
            }
            return this.publish({ ctx, preview, strategy, current, forceAdvance: false });
        });
    }
    advance(ctx, preview, strategy) {
        return this.advanceInternal(ctx, preview, strategy, false);
    }
    /** Advance an already-persisted compatibility route without ever creating one. */
    advanceExisting(ctx, preview, strategy) {
        return this.advanceInternal(ctx, preview, strategy, true);
    }
    advanceInternal(ctx, preview, strategy, requireExisting) {
        return this.scopeLane.run(buildScopeKey(preview, ctx), async () => {
            const current = await this.bindingStore.get(ctx);
            if (!current && requireExisting)
                return undefined;
            if (current && !(await this.validateBinding(current))) {
                throw new LocalChannelRootlessError(409, 'CHANNEL_BINDING_STALE', 'The existing Channel binding is stale.');
            }
            return this.publish({ ctx, preview, strategy, current, forceAdvance: true });
        });
    }
    async bindExplicit(input) {
        const candidates = (await this.bindingStore.list()).filter((binding) => binding.key === input.bindingId || binding.clientName === input.bindingId);
        if (candidates.length !== 1) {
            throw new LocalChannelRootlessError(candidates.length === 0 ? 404 : 409, candidates.length === 0 ? 'CHANNEL_BINDING_NOT_FOUND' : 'CHANNEL_BINDING_AMBIGUOUS', 'The Channel binding target cannot be resolved uniquely.');
        }
        const initial = candidates[0];
        const ctx = contextForBinding(initial);
        const strategy = strategyForRoutingMode(input.routingMode);
        const owner = await this.options.rootlessV2.getAgentOwnerIdentity(input.agentName);
        const preview = {
            ruleId: initial.routeRuleId ?? null,
            agentId: owner.exactOwnerName,
            sessionStrategy: strategy,
            sessionTitle: '',
            blocked: false,
            exactOwnerName: owner.exactOwnerName,
            ...(owner.ownerInstanceId ? { ownerInstanceId: owner.ownerInstanceId } : {}),
            projectKey: input.projectKey,
            routingMode: input.routingMode,
            generation: input.expectedGeneration,
        };
        return this.scopeLane.run(buildScopeKey(preview, ctx), async () => {
            const existing = await this.assertRebindTarget({ initial, input, owner, ctx });
            if (!input.sessionId) {
                const resolved = await this.publish({
                    ctx,
                    preview,
                    strategy,
                    current: existing,
                    forceAdvance: true,
                    ...(input.routingMode === 'project-main' && existing.routingMode === 'project-main'
                        ? { profileSeedOverride: existing }
                        : {}),
                });
                return resolved.binding;
            }
            const session = await this.options.getSessionById(input.sessionId);
            if (!session || !(await this.validateSession(session, owner, input.projectKey))) {
                throw new LocalChannelRootlessError(409, 'CHANNEL_SESSION_VALIDATION_FAILED', 'The explicit Session does not match the Agent owner and Project.');
            }
            const write = {
                agentName: owner.exactOwnerName,
                sessionId: session.sessionId,
                strategy,
                pinned: false,
                routeRuleId: existing.routeRuleId,
                exactOwnerName: owner.exactOwnerName,
                ...(owner.ownerInstanceId ? { ownerInstanceId: owner.ownerInstanceId } : {}),
                projectKey: input.projectKey,
                routingMode: input.routingMode,
                expectedGeneration: input.expectedGeneration,
            };
            return input.routingMode === 'project-main' && existing.routingMode === 'project-main'
                ? this.bindingStore.advanceProjectMain(ctx, existing, write)
                : this.bindingStore.compareAndSet(ctx, write);
        });
    }
    async publish(publishInput) {
        const { ctx, preview, strategy, current, forceAdvance } = publishInput;
        const rootless = this.options.rootlessV2;
        const owner = await rootless.getAgentOwnerIdentity(preview.agentId);
        await assertCurrentOwner(preview, owner, this.options.resolveAgentReadScope);
        const profileSeed = await this.resolveProfileSeed(publishInput, owner);
        if (!forceAdvance && profileSeed && (await this.validateBinding(profileSeed))) {
            const binding = current?.key === profileSeed.key
                ? profileSeed
                : await this.bindingStore.attachProjectMain(ctx, profileSeed, preview.ruleId);
            return this.resolvedFromBinding(binding);
        }
        const expectedGeneration = profileSeed?.generation ?? current?.generation ?? 0;
        await this.bindingStore.assertProjectProfile(ctx, owner.exactOwnerName, preview.projectKey, current?.key ?? buildLocalChannelBindingKey(ctx));
        const generation = expectedGeneration + 1;
        const session = await this.resolvePublishSession({
            ctx,
            preview,
            strategy,
            owner,
            forceAdvance,
            generation,
        });
        const committed = await this.requireValidatedSession(session.sessionId, owner, preview);
        const write = {
            agentName: owner.exactOwnerName,
            sessionId: committed.sessionId,
            strategy,
            pinned: false,
            routeRuleId: preview.ruleId,
            exactOwnerName: owner.exactOwnerName,
            ...(owner.ownerInstanceId ? { ownerInstanceId: owner.ownerInstanceId } : {}),
            projectKey: preview.projectKey,
            routingMode: preview.routingMode,
            expectedGeneration,
        };
        const binding = profileSeed
            ? await this.bindingStore.advanceProjectMain(ctx, profileSeed, write)
            : await this.bindingStore.compareAndSet(ctx, write);
        return this.resolvedFromBinding(binding);
    }
    /** Explicit override wins; otherwise project-main mode reuses the profile's live seed. */
    async resolveProfileSeed(publishInput, owner) {
        if (publishInput.profileSeedOverride)
            return publishInput.profileSeedOverride;
        if (publishInput.preview.routingMode !== 'project-main')
            return undefined;
        const profile = await this.projectMainProfile(publishInput.ctx, owner, publishInput.preview.projectKey);
        return profile[0];
    }
    /** Re-read + validate the Session actually committed before persisting a route to it. */
    async requireValidatedSession(sessionId, owner, preview) {
        const committed = await this.options.getSessionById(sessionId);
        if (!committed || !(await this.validateSession(committed, owner, preview.projectKey))) {
            throw new LocalChannelRootlessError(409, 'CHANNEL_SESSION_VALIDATION_FAILED', 'The committed Channel Session failed owner or Project validation.');
        }
        return committed;
    }
    /**
     * Lane-held validation of an explicit rebind target: generation CAS,
     * immutable owner boundary, requested owner instance and single-Project
     * profile. Returns the current persisted binding row.
     */
    async assertRebindTarget(check) {
        const { initial, input, owner, ctx } = check;
        const existing = await this.bindingStore.getByKey(initial.key);
        if (!existing || existing.generation !== input.expectedGeneration) {
            throw new LocalChannelRootlessError(409, 'CHANNEL_BINDING_GENERATION_CONFLICT', 'Channel binding generation changed.');
        }
        if (!(await isCompatibleChannelAgentOwner({
            persisted: existing,
            current: owner,
            ...(this.options.resolveAgentReadScope
                ? { resolveAgentReadScope: this.options.resolveAgentReadScope }
                : {}),
        }))) {
            throw new LocalChannelRootlessError(409, 'CHANNEL_BINDING_OWNER_CHANGE_REQUIRES_REBIND', 'Changing a physical Channel binding owner requires rebinding the client.');
        }
        assertRequestedOwner(input.ownerInstanceId, owner);
        await this.bindingStore.assertProjectProfile(ctx, owner.exactOwnerName, input.projectKey, existing.key);
        return existing;
    }
    /**
     * Session selection for publish, in v1 priority order: the preview's
     * explicit Session (unless forced to advance), then an existing
     * purpose-matched hidden Session (idempotent re-publish), then a freshly
     * created channel-branch Session in the Project workspace.
     */
    async resolvePublishSession(resolve) {
        const { ctx, preview, strategy, owner, forceAdvance, generation } = resolve;
        if (!forceAdvance && preview.sessionId) {
            const explicit = await this.options.getSessionById(preview.sessionId);
            if (explicit)
                return explicit;
        }
        const purpose = buildSessionPurpose({
            ctx,
            exactOwnerName: owner.exactOwnerName,
            ownerInstanceId: owner.ownerInstanceId,
            projectKey: preview.projectKey,
            routingMode: preview.routingMode,
            generation,
            sessionTitle: preview.sessionTitle,
        });
        const existing = (await this.options.listSessions(owner.exactOwnerName, {
            includeHidden: true,
            includePurposePrefix: purpose,
        })).find((candidate) => candidate.purpose === purpose);
        if (existing)
            return existing;
        const workspace = this.options.rootlessV2.resolveProjectWorkspace(preview.projectKey);
        return this.options.createSession({
            agentName: owner.exactOwnerName,
            workspaceDir: workspace.workspaceDir,
            isDefaultWorkspace: workspace.isDefaultWorkspace,
            sessionType: 'branch',
            sessionKind: 'channel',
            title: preview.sessionTitle || buildSessionTitle(ctx, strategy),
            parentSessionId: null,
            visibility: 'visible',
            purpose,
        });
    }
    async projectMainProfile(ctx, owner, projectKey) {
        const profile = (await this.bindingStore.list()).filter((binding) => binding.exactOwnerName === owner.exactOwnerName &&
            binding.ownerInstanceId === owner.ownerInstanceId &&
            binding.platform === ctx.platform &&
            binding.clientName === ctx.clientName &&
            binding.routingMode === 'project-main');
        if (profile.some((binding) => binding.projectKey !== projectKey)) {
            throw multiProjectBindingError();
        }
        const bindings = profile.filter((binding) => binding.projectKey === projectKey);
        const first = bindings[0];
        if (first &&
            bindings.some((binding) => binding.sessionId !== first.sessionId || binding.generation !== first.generation)) {
            throw new LocalChannelRootlessError(409, 'CHANNEL_BINDING_PROFILE_DIVERGED', 'The project-main Channel binding profile has diverged.');
        }
        return bindings;
    }
    async validateBinding(binding) {
        const owner = await readOwnerIdentityOrUndefined(this.options, binding.agentName);
        if (!owner ||
            !(await isCompatibleChannelAgentOwner({
                persisted: binding,
                current: owner,
                ...(this.options.resolveAgentReadScope
                    ? { resolveAgentReadScope: this.options.resolveAgentReadScope }
                    : {}),
            }))) {
            return false;
        }
        const session = await this.options.getSessionById(binding.sessionId);
        return Boolean(session && (await this.validateSession(session, owner, binding.projectKey)));
    }
    async validateSession(session, owner, projectKey) {
        if (session.runtime !== 'pi-agent' ||
            session.sessionType !== 'branch' ||
            session.sessionKind !== 'channel' ||
            session.parentSessionId ||
            session.archived) {
            return false;
        }
        const rootless = this.options.rootlessV2;
        const project = await rootless.getSessionProjectIdentity(session.sessionId);
        if (!project || project.projectKey !== projectKey)
            return false;
        const snapshot = await rootless.getSessionAgentRoutingSnapshot(session.sessionId);
        return Boolean(snapshot &&
            (await isCompatibleChannelAgentOwner({
                persisted: snapshot,
                current: owner,
                ...(this.options.resolveAgentReadScope
                    ? { resolveAgentReadScope: this.options.resolveAgentReadScope }
                    : {}),
            })));
    }
    resolvedFromBinding(binding) {
        const route = {
            blocked: false,
            agentName: binding.agentName,
            sessionId: binding.sessionId,
            strategy: binding.strategy,
            ruleId: binding.routeRuleId ?? null,
            sessionTitle: '',
            binding,
        };
        // `validateBinding` has just fenced the persisted binding against the
        // current Custom Agent incarnation and its Session snapshot. Carry that
        // admission-time identity into the queued conversation message so the
        // V2 consumer can revalidate it before model resolution and execution.
        // Keep it off adapter HTTP responses with the same internal-only rule as
        // the physical Connection/Binding route metadata.
        if (binding.ownerInstanceId) {
            Object.defineProperty(route, 'targetAgentId', {
                value: binding.ownerInstanceId,
                enumerable: false,
                configurable: true,
            });
        }
        return route;
    }
}
async function assertCurrentOwner(preview, owner, resolveAgentReadScope) {
    if (preview.ownerDefaultApplied)
        return;
    if (!(await isCompatibleChannelAgentOwner({
        persisted: preview,
        current: owner,
        ...(resolveAgentReadScope ? { resolveAgentReadScope } : {}),
    }))) {
        throw new LocalChannelRootlessError(409, 'CHANNEL_ROUTE_OWNER_STALE', 'The Channel route targets a stale Agent owner.');
    }
}
function assertRequestedOwner(requestedInstanceId, owner) {
    if ((owner.ownerKind === 'custom' && owner.ownerInstanceId !== requestedInstanceId) ||
        (owner.ownerKind === 'builtin' && requestedInstanceId !== undefined)) {
        throw new LocalChannelRootlessError(409, 'CHANNEL_ROUTE_OWNER_STALE', 'The requested Agent owner incarnation is stale.');
    }
}
/**
 * Owner identity read that degrades to undefined: a missing/failed owner
 * lookup must invalidate the candidate route, never crash resolution.
 */
async function readOwnerIdentityOrUndefined(options, agentName) {
    try {
        return await options.rootlessV2.getAgentOwnerIdentity(agentName);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=rootless-route-resolver.js.map