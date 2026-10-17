import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { isAbsolute } from 'node:path';
import { agents } from '../../../infra/db/schema/agents.js';
import { createLegacyAgentSource, } from '../../../infra/legacy-db/agent-source.js';
import { decryptIdentityField, encryptIdentityField } from './identity-codec.js';
import { AgentFiles } from './agent-files.js';
import { canonicalConfigForInsert, discardInitialCustomConfig, isConfigNotFound, mergeLegacyPrompt, runtimeStateUnavailable, unsupportedCustomLegacyAsset, } from './agent-create-publication.js';
import { LegacyCustomAgentIdentityReceipt } from './legacy-custom-identity-receipt.js';
import { canonicalCustomRuntimeFields, canonicalCustomTimestamps, runtimeIndexForUpdate, runtimeUpdateValues, } from './runtime-index.js';
import { resolveFrozenLegacyHistoryNotice } from './_migration-legacy-agents.js';
import { AgentServiceError } from '../errors.js';
import { AgentConfigError, } from './canonical-agent-config.js';
import { LEGACY_PRIMARY_AGENT_NAME, PRIMARY_AGENT_NAME, isReservedName } from '../domain/names.js';
import { isPrimaryFamilyName } from '../domain/primary-identity.js';
import { encodeAgentRoleForStorage, normalizeStoredAgentRole, roleObservationStatus, } from '../domain/roles.js';
// Agent names cannot contain a dot, so this cannot collide with a Custom
// Agent's existing per-directory lock key.
const DISPLAY_NAME_LOCK_KEY = '.display-name-roster';
function primaryFamilyNormalizationValues(row) {
    const values = {};
    if (!isTrustedBuiltin(normalizeCreationSource(row.creationSource))) {
        values.creationSource = 'builtin';
    }
    if (normalizeStoredAgentRole(row.agentRole) !== 'orchestrator') {
        values.agentRole = encodeAgentRoleForStorage('orchestrator');
    }
    return Object.keys(values).length > 0 ? values : undefined;
}
/** Agent owner persistence: shared AppDb plus the existing on-disk Agent layout. */
export class DrizzleAgentRepository {
    options;
    files;
    identityReceipt;
    observedRoles = new Set();
    legacySourceDisplayNames;
    constructor(options) {
        this.options = options;
        this.files = new AgentFiles(options.dataDir);
        this.identityReceipt = new LegacyCustomAgentIdentityReceipt(options.dataDir);
    }
    withDisplayNameLock(operation) {
        return this.files.withLock(DISPLAY_NAME_LOCK_KEY, operation);
    }
    normalizePrimaryFamilyRows() {
        const rows = this.options.db
            .select({
            agentName: agents.agentName,
            agentRole: agents.agentRole,
            creationSource: agents.creationSource,
        })
            .from(agents)
            .where(inArray(agents.agentName, [PRIMARY_AGENT_NAME, LEGACY_PRIMARY_AGENT_NAME]))
            .all();
        if (!rows.some((row) => primaryFamilyNormalizationValues(row) !== undefined)) {
            return Promise.resolve(0);
        }
        return Promise.resolve(this.options.db.transaction((tx) => {
            const currentRows = tx
                .select({
                agentName: agents.agentName,
                agentRole: agents.agentRole,
                creationSource: agents.creationSource,
            })
                .from(agents)
                .where(inArray(agents.agentName, [PRIMARY_AGENT_NAME, LEGACY_PRIMARY_AGENT_NAME]))
                .all();
            let normalized = 0;
            for (const row of currentRows) {
                const values = primaryFamilyNormalizationValues(row);
                if (!values)
                    continue;
                normalized += this.changes(tx.update(agents).set(values).where(eq(agents.agentName, row.agentName)).run());
            }
            return normalized;
        }, { behavior: 'immediate' }));
    }
    async insert(input) {
        // A Custom Agent's configuration is published before the SQLite index is
        // visible.  SQLite remains a runtime index; it must not become a second
        // editable source for profile, prompt, workspace, or capability settings.
        if (isTrustedBuiltin(input.creationSource)) {
            this.insertIndexRow(input);
            return;
        }
        const publication = await this.publishCustomConfig(input);
        try {
            this.insertIndexRow(input);
        }
        catch {
            if (this.hasExistingCustomRuntimeState(input.name))
                return;
            if (input.initialDefinition !== undefined) {
                await discardInitialCustomConfig({
                    files: this.files,
                    db: this.options.db,
                    name: input.name,
                    publication,
                });
            }
            // Legacy primitive creates retain their retryable canonical file. An
            // initial complete definition instead compensates all newly published
            // user-visible state before reporting failure.
            throw runtimeStateUnavailable();
        }
    }
    async get(name) {
        const row = this.options.db.select().from(agents).where(eq(agents.agentName, name)).get();
        const builtin = Boolean(row && isTrustedBuiltin(normalizeCreationSource(row.creationSource)));
        if (builtin && row)
            return this.toMeta(row);
        const canonical = await this.readCanonicalCustomConfigIfPresent(name);
        if (canonical) {
            return this.toCanonicalCustomMeta(name, row ? this.toMeta(row) : undefined);
        }
        return undefined;
    }
    async list(options = {}) {
        const rows = this.options.db
            .select()
            .from(agents)
            .orderBy(desc(agents.createdAt), asc(agents.agentName))
            .all();
        const builtinRows = rows.filter((row) => isTrustedBuiltin(normalizeCreationSource(row.creationSource)));
        const builtinNames = new Set(builtinRows.map((row) => row.agentName));
        const customFiles = (await this.files.listCanonicalCustomAgents()).filter((entry) => !builtinNames.has(entry.name));
        const customNames = new Set(customFiles.map((entry) => entry.name));
        const rowsByName = new Map(rows.map((row) => [row.agentName, row]));
        const metas = [
            ...builtinRows
                .filter((row) => !customNames.has(row.agentName))
                .map((row) => this.toMeta(row)),
            ...customFiles.map((entry) => {
                const row = rowsByName.get(entry.name);
                return this.toCanonicalCustomMeta(entry.name, row && !isTrustedBuiltin(normalizeCreationSource(row.creationSource))
                    ? this.toMeta(row)
                    : undefined, entry);
            }),
        ];
        const pattern = options.search?.trim().toLowerCase();
        const filtered = pattern
            ? metas.filter((meta) => meta.name.toLowerCase().includes(pattern))
            : metas;
        filtered.sort((left, right) => right.createdAtMs - left.createdAtMs || left.name.localeCompare(right.name));
        const start = options.offset === undefined ? 0 : Math.max(0, options.offset);
        const end = options.limit === undefined ? undefined : start + Math.max(0, options.limit);
        return filtered.slice(start, end);
    }
    async update(name, fields) {
        const values = runtimeUpdateValues(fields);
        if (Object.keys(values).length === 0)
            return false;
        const changes = this.changes(this.options.db
            .update(agents)
            .set(values)
            .where(and(eq(agents.agentName, name), fields.expectedMainSessionId === undefined
            ? undefined
            : eq(agents.mainSessionId, fields.expectedMainSessionId)))
            .run());
        if (changes > 0)
            return true;
        if (fields.expectedMainSessionId !== undefined)
            return false;
        return this.reconcileCanonicalCustomRuntimeState(runtimeIndexForUpdate(name, fields));
    }
    async delete(name) {
        return this.files.withLock(name, async () => {
            await this.files.remove(name, true);
            return (this.changes(this.options.db.delete(agents).where(eq(agents.agentName, name)).run()) > 0);
        });
    }
    async getLegacyHistoryNotice(name) {
        const candidate = this.options.db
            .select({
            sessionId: agents.legacyHistorySessionId,
            createdAtMs: agents.createdAt,
        })
            .from(agents)
            .where(eq(agents.agentName, name))
            .get();
        const candidateSessionId = candidate?.sessionId;
        if (!candidate || !candidateSessionId)
            return undefined;
        const resolution = await resolveFrozenLegacyHistoryNotice({
            db: this.options.db,
            sourceDataDir: this.options.dataDir,
            candidate: {
                agentName: name,
                candidateSessionId,
                createdAtMs: candidate.createdAtMs,
            },
        });
        if (resolution.status === 'eligible') {
            const current = this.options.db
                .select({
                sessionId: agents.legacyHistorySessionId,
                createdAtMs: agents.createdAt,
            })
                .from(agents)
                .where(eq(agents.agentName, name))
                .get();
            if (!current ||
                current.sessionId !== candidateSessionId ||
                current.createdAtMs !== candidate.createdAtMs) {
                return undefined;
            }
            return resolution.sessionId;
        }
        if (resolution.status === 'pending') {
            throw new AgentServiceError('LEGACY_HISTORY_UNAVAILABLE', 'Legacy history source is temporarily unavailable.');
        }
        return undefined;
    }
    async deleteIfOwnerInstanceId(name, expectedOwnerInstanceId) {
        return this.files.withLock(name, async () => {
            if (!(await this.files.removeIfInstanceId(name, expectedOwnerInstanceId, true)))
                return false;
            this.options.db.delete(agents).where(eq(agents.agentName, name)).run();
            return true;
        });
    }
    async getConfig(name) {
        const builtin = await this.getTrustedBuiltinMeta(name);
        if (builtin)
            return this.files.getConfig(name);
        const config = await this.readCanonicalCustomConfigIfPresent(name);
        if (config) {
            return config.xMavis?.defaultWorkspaceDir
                ? { defaultWorkspaceDir: config.xMavis.defaultWorkspaceDir }
                : {};
        }
        return null;
    }
    async updateConfig(name, fields) {
        const builtin = await this.getTrustedBuiltinMeta(name);
        if (builtin)
            return this.files.updateConfig(name, fields);
        if (await this.readCanonicalCustomConfigIfPresent(name)) {
            throw unsupportedCustomLegacyAsset('defaultWorkspaceDir');
        }
        if (!builtin && !(await this.hasLegacyCustomRow(name))) {
            return false;
        }
        return this.files.updateConfig(name, fields);
    }
    async getIdentity(name) {
        const builtin = await this.getTrustedBuiltinMeta(name);
        if (builtin)
            return this.readStoredIdentity(name);
        const config = await this.readCanonicalCustomConfigIfPresent(name);
        if (config) {
            return {
                ...(config.xMavis?.displayName ? { displayName: config.xMavis.displayName } : {}),
                description: config.description,
                ...(config.xMavis?.avatar ? { avatar: config.xMavis.avatar } : {}),
            };
        }
        return null;
    }
    async readCustomAvatar(name) {
        const builtin = await this.getTrustedBuiltinMeta(name);
        if (builtin || !(await this.readCanonicalCustomConfigIfPresent(name)))
            return undefined;
        return this.files.readCanonicalAvatar(name);
    }
    /** Startup-only legacy candidates: non-Builtin rows plus safe file-only Custom directories. */
    async listLegacyCustomAgents() {
        const rows = this.options.db
            .select()
            .from(agents)
            .orderBy(desc(agents.createdAt), asc(agents.agentName))
            .all();
        const rowNames = new Set(rows.map((row) => row.agentName));
        const fileOnlyCandidates = (await this.files.listDirectCustomAgentNames())
            .filter((name) => !rowNames.has(name) && !isReservedName(name))
            .map((name) => ({
            name,
            agentRole: 'worker',
            creationSource: 'manual',
            greetingSent: false,
            createdAtMs: 0,
            updatedAtMs: 0,
        }));
        return [
            ...rows
                .map((row) => this.toMeta(row))
                .filter((meta) => !isTrustedBuiltin(meta.creationSource) &&
                !isPrimaryFamilyName(meta.name, PRIMARY_AGENT_NAME)),
            ...fileOnlyCandidates,
        ];
    }
    /** Repairs only a missing runtime row; canonical config remains untouched. */
    reconcileCanonicalCustomAgent(input) {
        return this.reconcileCanonicalCustomRuntimeState(input);
    }
    /** Startup repair for file-only Custom Agents. */
    async reconcileCanonicalCustomAgents() {
        const entries = await this.files.listCanonicalCustomAgents();
        let reconciled = 0;
        for (const entry of entries) {
            const didReconcile = await this.reconcileCanonicalCustomRuntimeState({
                name: entry.name,
                agentRole: 'worker',
                creationSource: 'manual',
                createdAtMs: entry.createdAtMs,
                updatedAtMs: entry.updatedAtMs,
            });
            if (didReconcile)
                reconciled += 1;
        }
        return reconciled;
    }
    async materializeLegacyCustomAgent(name) {
        const result = await this.materializeLegacyCustomAgentForStartup(name);
        return legacyMaterializationOutcome(result.outcome);
    }
    async materializeLegacyCustomAgentForStartup(name) {
        if (isPrimaryFamilyName(name, PRIMARY_AGENT_NAME)) {
            return legacyMaterializationResult('not_legacy');
        }
        const row = this.options.db.select().from(agents).where(eq(agents.agentName, name)).get();
        if ((row && isTrustedBuiltin(normalizeCreationSource(row.creationSource))) ||
            (!row && isReservedName(name))) {
            return legacyMaterializationResult('not_legacy');
        }
        return this.files.withLock(name, async () => this.materializeLegacyCustomAgentLocked(name, Boolean(row), !(await this.identityReceipt.isCompleted())));
    }
    completeLegacyCustomIdentityReconciliation() {
        return this.identityReceipt.complete();
    }
    async publishCustomConfig(input) {
        return this.files.withLock(input.name, async () => {
            const avatar = await this.files.prepareCustomCreateAvatar(input.name, input.avatar, true);
            let config;
            let published = false;
            try {
                config = canonicalConfigForInsert(input, avatar?.reference);
                const outcome = await this.files.publishCanonicalConfigIfAbsent(input.name, config, true);
                if (outcome === 'published') {
                    // Publish the incarnation in the same create queue as agent.md. A
                    // stale Config editor cannot then survive delete + same-name create.
                    published = true;
                    const instanceId = await this.files.getOrCreateCustomAgentInstanceId(input.name, true);
                    return { config, avatar, instanceId };
                }
                throw new AgentConfigError('AGENT_CONFIG_INVALID', 'agent.md', 'Agent configuration exists without a matching runtime index.');
            }
            catch (error) {
                if (input.initialDefinition !== undefined && published && config !== undefined) {
                    await this.files.removeCanonicalConfigIfUnchanged(input.name, config, true);
                }
                if (avatar?.staged) {
                    await this.files.removeStagedCustomAvatarIfUnchanged(input.name, avatar.staged, true);
                }
                throw error;
            }
        });
    }
    insertIndexRow(input) {
        const builtin = isTrustedBuiltin(input.creationSource);
        this.options.db
            .insert(agents)
            .values({
            agentName: input.name,
            agentRole: encodeAgentRoleForStorage(input.agentRole),
            frameworkType: 'pi-agent',
            processAlive: 0,
            harnessSourceType: '',
            creationSource: input.creationSource,
            mainSessionId: input.rootSessionId ?? null,
            encDisplayName: builtin ? encryptIdentityField(input.displayName) : null,
            encDescription: builtin ? encryptIdentityField(input.description) : null,
            encAvatar: builtin ? encryptIdentityField(input.avatar) : null,
            greetingSent: 0,
            createdAt: input.createdAtMs,
            updatedAt: input.updatedAtMs,
        })
            .run();
    }
    async readCanonicalCustomConfigIfPresent(name) {
        if (isPrimaryFamilyName(name, PRIMARY_AGENT_NAME))
            return undefined;
        if (isReservedName(name) && !(await this.hasLegacyCustomRow(name)))
            return undefined;
        try {
            return await this.getCanonicalConfig(name);
        }
        catch (error) {
            if (isConfigNotFound(error))
                return undefined;
            throw error;
        }
    }
    async getTrustedBuiltinMeta(name) {
        const row = this.options.db.select().from(agents).where(eq(agents.agentName, name)).get();
        return row && isTrustedBuiltin(normalizeCreationSource(row.creationSource))
            ? this.toMeta(row)
            : undefined;
    }
    async hasLegacyCustomRow(name) {
        const row = this.options.db
            .select({ creationSource: agents.creationSource })
            .from(agents)
            .where(eq(agents.agentName, name))
            .get();
        return Boolean(row && !isTrustedBuiltin(normalizeCreationSource(row.creationSource)));
    }
    hasExistingCustomRuntimeState(name) {
        try {
            const row = this.options.db
                .select({ creationSource: agents.creationSource })
                .from(agents)
                .where(eq(agents.agentName, name))
                .get();
            return Boolean(row && !isTrustedBuiltin(normalizeCreationSource(row.creationSource)));
        }
        catch {
            return false;
        }
    }
    toCanonicalCustomMeta(name, runtimeMeta, file = undefined) {
        return {
            name,
            ...canonicalCustomRuntimeFields(runtimeMeta),
            ...canonicalCustomTimestamps(runtimeMeta, file),
        };
    }
    async reconcileCanonicalCustomRuntimeState(input) {
        if (isTrustedBuiltin(input.creationSource))
            return false;
        if (!(await this.readCanonicalCustomConfigIfPresent(input.name)))
            return false;
        const existing = this.options.db
            .select()
            .from(agents)
            .where(eq(agents.agentName, input.name))
            .get();
        if (existing)
            return false;
        let result;
        try {
            result = this.options.db
                .insert(agents)
                .values(this.customRuntimeIndexValues(input))
                .onConflictDoNothing()
                .run();
        }
        catch {
            throw runtimeStateUnavailable();
        }
        if (this.changes(result) > 0)
            return true;
        return false;
    }
    customRuntimeIndexValues(input) {
        return {
            agentName: input.name,
            agentRole: encodeAgentRoleForStorage(input.agentRole),
            frameworkType: 'pi-agent',
            processAlive: 0,
            harnessSourceType: '',
            creationSource: input.creationSource,
            mainSessionId: input.rootSessionId ?? null,
            encDisplayName: null,
            encDescription: null,
            encAvatar: null,
            greetingSent: input.greetingSent ? 1 : 0,
            createdAt: input.createdAtMs,
            updatedAt: input.updatedAtMs,
        };
    }
    async materializeLegacyCustomAgentLocked(name, rowBacked, allowLegacyIdentityRecovery) {
        const inspection = await this.inspectCustomConfigForMaterialization(name);
        if (inspection.alreadyCanonical) {
            return this.reconcileCanonicalCustomIdentity(name, inspection.canonical, allowLegacyIdentityRecovery);
        }
        const legacy = await this.readLegacyMaterializationInput(name, inspection.plainSystemPrompt, allowLegacyIdentityRecovery);
        if (!hasLegacyMaterializationEvidence(legacy, rowBacked)) {
            if (inspection.canonicalError)
                throw inspection.canonicalError;
            return legacyMaterializationResult('not_legacy');
        }
        await this.writeMaterializedCustomConfig(name, legacy);
        return legacyMaterializationResult('materialized', legacy.identitySource, legacy.displayName ? ['display_name'] : []);
    }
    async reconcileCanonicalCustomIdentity(name, canonical, allowLegacyIdentityRecovery) {
        const systemPrompt = canonical?.systemPrompt.trim()
            ? undefined
            : trimmedValue(canonical?.description);
        const recovery = await this.readCanonicalIdentityRecovery(name, canonical, allowLegacyIdentityRecovery);
        if (!systemPrompt && !recovery.displayName)
            return legacyMaterializationResult('already_canonical');
        const patched = await this.files.patchCanonicalCustomConfig(name, {
            ...(systemPrompt ? { systemPrompt } : {}),
            ...(recovery.displayName ? { displayName: recovery.displayName } : {}),
        }, true);
        return patched
            ? legacyMaterializationResult(systemPrompt ? 'materialized' : 'canonical_identity_reconciled', recovery.identitySource, [
                ...(systemPrompt ? ['system_prompt'] : []),
                ...(recovery.displayName ? ['display_name'] : []),
            ])
            : legacyMaterializationResult('already_canonical');
    }
    async readCanonicalIdentityRecovery(name, canonical, allowLegacyIdentityRecovery) {
        if (trimmedValue(canonical?.xMavis?.displayName)) {
            return { identitySource: 'none', displayName: undefined };
        }
        return this.readDisplayNameRecovery(name, allowLegacyIdentityRecovery);
    }
    async inspectCustomConfigForMaterialization(name) {
        try {
            const canonical = await this.files.getCanonicalConfig(name);
            return { alreadyCanonical: true, canonical };
        }
        catch (error) {
            if (!(error instanceof AgentConfigError))
                throw error;
            if (error.code === 'AGENT_CONFIG_NOT_FOUND')
                return { alreadyCanonical: false };
            if (error.code !== 'AGENT_CONFIG_INVALID')
                throw error;
            // Plain Markdown is an explicit pre-canonical shape. Frontmatter-shaped
            // content is a user-owned invalid canonical file and stays untouched.
            const plainSystemPrompt = await this.files.readLegacyPlainSystemPrompt(name);
            if (plainSystemPrompt === null)
                throw error;
            return { alreadyCanonical: false, plainSystemPrompt, canonicalError: error };
        }
    }
    async readLegacyMaterializationInput(name, knownPlainSystemPrompt, allowLegacyIdentityRecovery) {
        const [config, persona, systemPrompt, identity, rowProvenance] = await Promise.all([
            this.files.getConfig(name),
            this.files.getPersona(name),
            knownPlainSystemPrompt === undefined
                ? this.files.readLegacyPlainSystemPrompt(name)
                : knownPlainSystemPrompt,
            this.readStoredIdentity(name),
            this.hasLegacyRowProvenance(name),
        ]);
        const recovery = await this.readDisplayNameRecovery(name, allowLegacyIdentityRecovery, identity, true);
        return {
            config,
            persona,
            systemPrompt,
            identity,
            ...(recovery.displayName ? { displayName: recovery.displayName } : {}),
            identitySource: recovery.identitySource,
            rowProvenance,
        };
    }
    async readDisplayNameRecovery(name, allowLegacySourceRecovery, knownTargetIdentity, allowTargetIdentityRecovery = allowLegacySourceRecovery) {
        if (!allowTargetIdentityRecovery)
            return { identitySource: 'none' };
        const targetIdentity = knownTargetIdentity === undefined ? await this.readStoredIdentity(name) : knownTargetIdentity;
        const targetDisplayName = trimmedValue(targetIdentity?.displayName);
        if (targetDisplayName) {
            return { displayName: targetDisplayName, identitySource: 'v2_target' };
        }
        if (!allowLegacySourceRecovery)
            return { identitySource: 'none' };
        const displayName = (await this.readLegacySourceDisplayNames()).get(name);
        return displayName
            ? { displayName, identitySource: 'legacy_source' }
            : { identitySource: 'none' };
    }
    async readLegacySourceDisplayNames() {
        this.legacySourceDisplayNames ??= this.loadLegacySourceDisplayNames();
        return this.legacySourceDisplayNames;
    }
    async loadLegacySourceDisplayNames() {
        const source = createLegacyAgentSource(this.options.dataDir).readAgents();
        if (source.status !== 'ready')
            return new Map();
        const displayNames = new Map();
        for (const row of source.rows) {
            if (typeof row.agent_name !== 'string')
                continue;
            const displayName = legacyDisplayName(row);
            if (displayName)
                displayNames.set(row.agent_name, displayName);
        }
        return displayNames;
    }
    async writeMaterializedCustomConfig(name, legacy) {
        const xMavis = await this.materializedMavisConfig(name, legacy);
        const description = legacy.identity?.description?.trim() || legacy.displayName || name;
        // Initial conversion keeps the legacy prompt when present; otherwise it
        // recovers the description. Startup also fills an empty canonical body.
        const mergedPrompt = mergeLegacyPrompt(legacy.persona ?? undefined, legacy.systemPrompt ?? undefined);
        const descriptionFallback = legacy.identity?.description?.trim() ?? '';
        await this.files.writeCanonicalConfig(name, {
            name,
            description,
            ...(xMavis ? { xMavis } : {}),
            systemPrompt: mergedPrompt || descriptionFallback,
        }, true);
    }
    async materializedMavisConfig(name, legacy) {
        const workspace = legacy.config?.defaultWorkspaceDir?.trim();
        const avatar = legacy.identity?.avatar?.trim();
        const canonicalAvatar = avatar
            ? await this.files.materializeLegacyAvatar(name, avatar)
            : undefined;
        const xMavis = {
            ...(legacy.displayName ? { displayName: legacy.displayName } : {}),
            ...(canonicalAvatar ? { avatar: canonicalAvatar } : {}),
            ...(workspace && isAbsolute(workspace) ? { defaultWorkspaceDir: workspace } : {}),
        };
        return Object.keys(xMavis).length > 0 ? xMavis : undefined;
    }
    hasLegacyRowProvenance(name) {
        const row = this.options.db
            .select({
            frameworkType: agents.frameworkType,
            configSyncedHash: agents.configSyncedHash,
            opencodeConfigHash: agents.opencodeConfigHash,
        })
            .from(agents)
            .where(eq(agents.agentName, name))
            .get();
        return Boolean(row &&
            (row.frameworkType !== 'pi-agent' ||
                row.configSyncedHash !== null ||
                row.opencodeConfigHash !== null));
    }
    async readStoredIdentity(name) {
        const row = this.options.db
            .select({
            displayName: agents.encDisplayName,
            description: agents.encDescription,
            avatar: agents.encAvatar,
        })
            .from(agents)
            .where(eq(agents.agentName, name))
            .get();
        if (!row)
            return null;
        const displayName = decryptIdentityField(row.displayName);
        const description = decryptIdentityField(row.description);
        const avatar = decryptIdentityField(row.avatar);
        const identity = {
            ...(displayName === null ? {} : { displayName }),
            ...(description === null ? {} : { description }),
            ...(avatar === null ? {} : { avatar }),
        };
        return Object.keys(identity).length > 0 ? identity : null;
    }
    async updateIdentity(name, fields) {
        const values = {};
        if (Object.hasOwn(fields, 'displayName'))
            values.encDisplayName = encryptIdentityField(fields.displayName);
        if (Object.hasOwn(fields, 'description'))
            values.encDescription = encryptIdentityField(fields.description);
        if (Object.hasOwn(fields, 'avatar'))
            values.encAvatar = encryptIdentityField(fields.avatar);
        if (Object.keys(values).length === 0)
            return false;
        return (this.changes(this.options.db.update(agents).set(values).where(eq(agents.agentName, name)).run()) > 0);
    }
    async deleteIdentity(name) {
        return (this.changes(this.options.db
            .update(agents)
            .set({ encDisplayName: null, encDescription: null, encAvatar: null })
            .where(eq(agents.agentName, name))
            .run()) > 0);
    }
    async getPersona(name) {
        const meta = await this.get(name);
        return meta && isTrustedBuiltin(meta.creationSource) ? this.files.getPersona(name) : null;
    }
    updatePersona(name, text) {
        return this.files.updatePersona(name, text);
    }
    publishPersonaIfAbsent(name, text) {
        return this.files.publishPersonaIfAbsent(name, text);
    }
    materializePersonaForTrustedBuiltin(name, text) {
        return this.files.materializePersonaForTrustedBuiltin(name, text);
    }
    deletePersona(name) {
        return this.files.deletePersona(name);
    }
    async getSystemPrompt(name) {
        const meta = await this.get(name);
        if (!meta)
            return null;
        if (isTrustedBuiltin(meta.creationSource))
            return this.files.getSystemPrompt(name);
        return (await this.files.getCanonicalConfig(name)).systemPrompt;
    }
    updateSystemPrompt(name, text) {
        return this.files.updateSystemPrompt(name, text);
    }
    publishSystemPromptIfAbsent(name, text) {
        return this.files.publishSystemPromptIfAbsent(name, text);
    }
    materializeSystemPromptForTrustedBuiltin(name, text) {
        return this.files.materializeSystemPromptForTrustedBuiltin(name, text);
    }
    deleteSystemPrompt(name) {
        return this.files.deleteSystemPrompt(name);
    }
    async updateAssets(input) {
        const builtin = await this.getTrustedBuiltinMeta(input.name);
        if (builtin)
            return this.updateBuiltinAssets(input);
        if (await this.readCanonicalCustomConfigIfPresent(input.name)) {
            rejectUnsupportedCustomAssetPatch(input);
            return this.files.patchCanonicalCustomConfig(input.name, {
                ...(Object.hasOwn(input, 'description') ? { description: input.description } : {}),
                ...(Object.hasOwn(input, 'displayName') ? { displayName: input.displayName } : {}),
                ...(Object.hasOwn(input, 'avatar') ? { avatar: input.avatar } : {}),
            });
        }
        return false;
    }
    async updateBuiltinAssets(input) {
        return this.files.withLock(input.name, async () => {
            let changed = await this.updateIdentityAssets(input);
            changed = (await this.updatePromptAsset(input, 'persona')) || changed;
            changed = (await this.updatePromptAsset(input, 'systemPrompt')) || changed;
            changed = (await this.updateWorkspaceAsset(input)) || changed;
            if (changed)
                await this.update(input.name, { updatedAtMs: input.updatedAtMs });
            return changed;
        });
    }
    async updateIdentityAssets(input) {
        if (!Object.hasOwn(input, 'displayName') &&
            !Object.hasOwn(input, 'description') &&
            !Object.hasOwn(input, 'avatar')) {
            return false;
        }
        return this.updateIdentity(input.name, {
            ...(Object.hasOwn(input, 'displayName')
                ? { displayName: input.displayName ?? undefined }
                : {}),
            ...(Object.hasOwn(input, 'description')
                ? { description: input.description ?? undefined }
                : {}),
            ...(Object.hasOwn(input, 'avatar') ? { avatar: input.avatar ?? undefined } : {}),
        });
    }
    async updatePromptAsset(input, asset) {
        if (asset === 'persona') {
            if (!Object.hasOwn(input, 'persona'))
                return false;
            if (input.persona === null)
                return this.files.deletePersona(input.name, true);
            if (typeof input.persona !== 'string')
                return false;
            await this.files.updatePersona(input.name, input.persona, true);
            return true;
        }
        if (!Object.hasOwn(input, 'systemPrompt'))
            return false;
        if (input.systemPrompt === null)
            return this.files.deleteSystemPrompt(input.name, true);
        if (typeof input.systemPrompt !== 'string')
            return false;
        await this.files.updateSystemPrompt(input.name, input.systemPrompt, true);
        return true;
    }
    async updateWorkspaceAsset(input) {
        if (!Object.hasOwn(input, 'defaultWorkspaceDir'))
            return false;
        await this.files.updateConfig(input.name, { defaultWorkspaceDir: input.defaultWorkspaceDir ?? undefined }, true);
        return true;
    }
    getAgentDir(name) {
        return this.files.agentDir(name);
    }
    async getCanonicalConfig(name) {
        if (isPrimaryFamilyName(name, PRIMARY_AGENT_NAME)) {
            throw new AgentConfigError('AGENT_CONFIG_NOT_FOUND', 'agent.md', 'Agent configuration is missing.');
        }
        try {
            return await this.files.getCanonicalConfig(name);
        }
        catch (error) {
            if (!(error instanceof AgentConfigError) ||
                error.code !== 'AGENT_CONFIG_INVALID' ||
                error.field !== 'frontmatter') {
                throw error;
            }
            // Startup normally migrates this historical shape. Keep the shared read
            // boundary resilient when an old raw agent.md reaches it first.
            if ((await this.materializeLegacyCustomAgent(name)) === 'not-legacy')
                throw error;
            return this.files.getCanonicalConfig(name);
        }
    }
    readCanonicalDocument(name, builtin = false) {
        return this.files.readCanonicalDocument(name, builtin);
    }
    readCustomCanonicalDocumentWithInstance(name) {
        return this.files.readCustomCanonicalDocumentWithInstance(name);
    }
    replaceCanonicalDocument(input) {
        return this.files.replaceCanonicalDocument(input);
    }
    getOrCreateCustomAgentInstanceId(name) {
        return this.files.getOrCreateCustomAgentInstanceId(name);
    }
    writeCanonicalConfig(name, config) {
        return this.files.writeCanonicalConfig(name, config);
    }
    getBuiltinCanonicalConfig(name) {
        return this.files.getBuiltinCanonicalConfig(name);
    }
    writeBuiltinCanonicalConfig(name, config) {
        return this.files.writeBuiltinCanonicalConfig(name, config);
    }
    removeBuiltinCanonicalConfig(name) {
        return this.files.removeBuiltinCanonicalConfig(name);
    }
    toMeta(row) {
        const status = roleObservationStatus(row.agentRole);
        if (status) {
            const key = `${row.agentName}:${status}:${String(row.agentRole)}`;
            if (!this.observedRoles.has(key)) {
                this.observedRoles.add(key);
                try {
                    this.options.facts?.onAgentRoleObservation?.({
                        status,
                        source: 'sqlite_decode',
                        role: undefined,
                    });
                }
                catch {
                    // Observability cannot alter a read result.
                }
            }
        }
        return {
            name: row.agentName,
            agentRole: normalizeStoredAgentRole(row.agentRole),
            ...(row.mainSessionId ? { rootSessionId: row.mainSessionId } : {}),
            ...(row.sourceProject ? { sourceProject: row.sourceProject } : {}),
            ...(row.harnessSourceType ? { harnessSourceType: row.harnessSourceType } : {}),
            creationSource: normalizeCreationSource(row.creationSource),
            greetingSent: row.greetingSent === 1,
            pinned: row.pinned === 1,
            pinnedAtMs: row.pinnedAt,
            createdAtMs: row.createdAt,
            updatedAtMs: row.updatedAt,
        };
    }
    changes(value) {
        return typeof value === 'object' &&
            value !== null &&
            'changes' in value &&
            typeof value.changes === 'number'
            ? value.changes
            : 0;
    }
}
function rejectUnsupportedCustomAssetPatch(input) {
    for (const field of ['persona', 'systemPrompt', 'defaultWorkspaceDir']) {
        if (Object.hasOwn(input, field))
            throw unsupportedCustomLegacyAsset(field);
    }
}
function hasLegacyMaterializationEvidence(input, rowBacked) {
    if (!rowBacked)
        return input.systemPrompt !== null;
    // A markerless plain agent.md is itself a known historical format. A
    // frontmatter-shaped file is excluded before this point, so it cannot be
    // silently reclassified as legacy just because SQLite happens to have a row.
    return (input.systemPrompt !== null ||
        input.config !== null ||
        input.persona !== null ||
        input.identity !== null ||
        input.displayName !== undefined ||
        input.rowProvenance);
}
function legacyMaterializationResult(outcome, identitySource = 'none', recoveredFields = []) {
    return { outcome, identitySource, recoveredFields };
}
function legacyMaterializationOutcome(outcome) {
    switch (outcome) {
        case 'materialized':
            return 'materialized';
        case 'not_legacy':
            return 'not-legacy';
        case 'canonical_identity_reconciled':
        case 'already_canonical':
            return 'already-canonical';
    }
}
function legacyDisplayName(row) {
    return typeof row.enc_display_name === 'string'
        ? trimmedValue(decryptIdentityField(row.enc_display_name))
        : undefined;
}
function trimmedValue(value) {
    const trimmed = value?.trim();
    return trimmed || undefined;
}
function isTrustedBuiltin(source) {
    return source === 'builtin';
}
function normalizeCreationSource(value) {
    return value === 'auto' || value === 'builtin' ? value : 'manual';
}
//# sourceMappingURL=agent.repository.js.map