import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAgentCapabilities } from '@mavis/config';
import { isTrustedBuiltinCreationSource } from '@mavis/agent-tools/desktop/subagent-roles';
import { createBuiltinPromptContext, parseFrontmatter, renderBuiltinTemplate, } from '../builtin/prompt-renderer.js';
import { LEGACY_PRIMARY_AGENT_NAME } from '../domain/names.js';
import { assertTrustedPrimaryFamily, planLegacyProfileOverlay, toPrimaryFamilyMembers, } from '../domain/primary-identity.js';
/**
 * Historic built-in Agents that become ordinary manual Agents on upgrade. They
 * are matched by exact stable name only; a same-named manual or unknown row is
 * left untouched.
 */
const DETACHABLE_LEGACY_BUILTIN_NAMES = ['general', 'coder'];
/** Frozen, roster-excluded asset root. See assets/agents/_migration/README.md. */
const MIGRATION_ASSET_DIR = '_migration';
const SYSTEM_PROMPT_TEMPLATE = 'system-prompt.md.hbs';
const UNRENDERED_TEMPLATE_RE = /\{\{/u;
const FROZEN_PERSONA_FILE_RE = /^PERSONA(?:-[a-z0-9][a-z0-9_-]*)?\.md$/iu;
/**
 * Detaches the historic General/Coder built-in identities in place.
 *
 * Their Persona and system prompt used to be read from the install package, so
 * flipping `creation_source` alone would leave an ordinary Agent with no stable
 * definition. This is deliberately limited to proven builtin provenance: a
 * same-named manual/custom row must retain every profile byte as authoritative.
 * Missing assets publish through durable no-replace staging; semantic blanks
 * are archived and atomically repaired; both are read back through the
 * ordinary Agent path before `creation_source` changes. The persisted avatar
 * is cleared only when it exactly matches one of this Agent's frozen historic
 * Persona defaults. Every published frozen locale is considered because an
 * upgrade can run under a locale different from the one that wrote the avatar;
 * a custom or missing user avatar remains untouched. Either failure leaves a
 * retryable builtin; if clearing succeeds but the source flip fails, that
 * builtin state uses its catalog avatar fallback instead of exposing it as
 * Custom. No other row field is written.
 */
export async function detachLegacyBuiltinIdentities(input) {
    // Canonical Custom reads intentionally fail closed, but older releases may
    // already have detached General/Coder rows whose profile is still plain
    // Markdown.  Consult the startup-only runtime index first so eligibility can
    // skip those non-builtins without parsing them before the later legacy
    // Custom materialization barrier has converted their files.
    const legacyCustomNames = new Set((await input.repository.listLegacyCustomAgents?.())?.map((meta) => meta.name) ?? []);
    for (const agentName of DETACHABLE_LEGACY_BUILTIN_NAMES) {
        if (legacyCustomNames.has(agentName)) {
            report(input, agentName, { phase: 'eligibility', outcome: 'skipped' });
            continue;
        }
        await detachOne(input, agentName);
    }
}
/**
 * Single idempotent overlay pass after the canonical seed and before the
 * primary Agent becomes an execution owner. Prompt body and ownership remain
 * outside this legacy profile migration.
 */
export async function convergeLegacyPrimaryProfile(input) {
    const displayNameLocked = input.primaryDisplayName !== undefined;
    if (input.primaryAgentName === LEGACY_PRIMARY_AGENT_NAME) {
        reportPrimaryProfileOverlay(input, 'skipped_no_canonical_primary', [], displayNameLocked);
        return;
    }
    const members = toPrimaryFamilyMembers(await input.repository.list(), input.primaryAgentName, (meta) => isTrustedBuiltinCreationSource(meta.creationSource));
    assertTrustedPrimaryFamily(members);
    const present = new Set(members.map((member) => member.name));
    if (!present.has(input.primaryAgentName) || !present.has(LEGACY_PRIMARY_AGENT_NAME)) {
        reportPrimaryProfileOverlay(input, 'skipped_family_incomplete', [], displayNameLocked);
        return;
    }
    const [canonicalIdentity, canonicalConfig, legacyIdentity, legacyConfig] = await Promise.all([
        input.repository.getIdentity(input.primaryAgentName),
        input.repository.getConfig(input.primaryAgentName),
        input.repository.getIdentity(LEGACY_PRIMARY_AGENT_NAME),
        input.repository.getConfig(LEGACY_PRIMARY_AGENT_NAME),
    ]);
    const plan = planLegacyProfileOverlay({
        canonicalIdentity,
        canonicalConfig,
        legacyIdentity,
        legacyConfig,
        seedIdentity: input.definitions.find((definition) => definition.name === input.primaryAgentName)
            ?.identity ?? {},
        primaryDisplayNameLocked: displayNameLocked,
    });
    if (!plan) {
        reportPrimaryProfileOverlay(input, 'no_op', [], displayNameLocked);
        return;
    }
    await input.repository.updateAssets({
        name: input.primaryAgentName,
        ...plan,
        updatedAtMs: input.nowMs,
    });
    reportPrimaryProfileOverlay(input, 'applied', Object.keys(plan), displayNameLocked);
}
function reportPrimaryProfileOverlay(input, outcome, adoptedFields, displayNameLocked) {
    input.report?.({ outcome, adoptedFields, displayNameLocked });
}
async function detachOne(input, agentName) {
    let phase = 'eligibility';
    let activeAsset;
    let materialized = [];
    let avatarDecision;
    try {
        const meta = await input.repository.get(agentName);
        if (!meta || !isTrustedBuiltinCreationSource(meta.creationSource)) {
            report(input, agentName, { phase, outcome: 'skipped' });
            return;
        }
        report(input, agentName, { phase, outcome: 'completed' });
        phase = 'materialization';
        materialized = await materializeFrozenProfile(input, meta, {
            onStart: (context) => {
                activeAsset = context;
            },
            onCompleted: (context) => {
                report(input, agentName, { phase, outcome: 'completed', context });
                activeAsset = undefined;
            },
        });
        phase = 'validation';
        await assertManualProfileIsReadable(input, meta, materialized);
        report(input, agentName, { phase, outcome: 'completed' });
        phase = 'identity_update';
        avatarDecision = await resolveAvatarDecision(input, meta.name);
        if (avatarDecision === 'clear_builtin_default') {
            await input.repository.updateIdentity(meta.name, { avatar: undefined });
        }
        // This must remain last: all required files are durably published/repaired
        // and read back first. A crash before this source flip leaves a retryable
        // builtin; a crash after it cannot expose a Custom Agent with a missing
        // profile. A cleared historic default falls back through the builtin catalog
        // only until this source flip completes; custom and missing avatars persist.
        await input.repository.update(meta.name, { creationSource: 'manual' });
        report(input, agentName, { phase, outcome: 'completed', avatarDecision });
    }
    catch (error) {
        report(input, agentName, {
            phase,
            outcome: 'failed',
            context: error instanceof LegacyProfileValidationError ? error.context : activeAsset,
            ...(avatarDecision ? { avatarDecision } : {}),
        });
        throw error;
    }
}
async function resolveAvatarDecision(input, agentName) {
    const avatar = (await input.repository.getIdentity(agentName))?.avatar;
    if (avatar === undefined)
        return 'preserve_missing';
    return (await readFrozenDefaultAvatars(input.catalog, agentName)).has(avatar)
        ? 'clear_builtin_default'
        : 'preserve_custom';
}
/**
 * Frozen Persona frontmatter is the source of truth for the only legacy
 * defaults we may clear. Read every published locale rather than the current
 * runtime locale: locale drift must not turn a historic default into a custom
 * avatar or erase a user replacement.
 */
async function readFrozenDefaultAvatars(catalog, agentName) {
    const assetDir = join(await catalog.resolveAssetsDir(), MIGRATION_ASSET_DIR, agentName);
    const personaFiles = (await readdir(assetDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && FROZEN_PERSONA_FILE_RE.test(entry.name))
        .map((entry) => entry.name);
    const avatars = new Set((await Promise.all(personaFiles.map(async (file) => {
        const raw = await readFile(join(assetDir, file), 'utf8');
        return parseFrontmatter(raw).frontmatter.avatar;
    }))).filter((avatar) => typeof avatar === 'string'));
    if (avatars.size === 0) {
        throw new Error(`Frozen migration Persona avatar is missing for Agent "${agentName}".`);
    }
    return avatars;
}
/**
 * Each asset is decided separately: one damaged half can self-heal while an
 * existing body on the other half remains user-owned and untouched.
 */
async function materializeFrozenProfile(input, meta, callbacks) {
    const persona = await materializeFrozenAsset(input, meta, 'persona', callbacks);
    const systemPrompt = await materializeFrozenAsset(input, meta, 'system_prompt', callbacks);
    return [persona, systemPrompt];
}
async function materializeFrozenAsset(input, meta, asset, callbacks) {
    // The first read can fail before we know whether the asset is missing,
    // preserved, or blank. Keep its exact bounded asset for failure reporting
    // but do not invent an action until the read completes.
    callbacks.onStart({ asset });
    const existing = await readProfileAsset(input.repository, meta.name, asset);
    const planned = {
        asset,
        action: materializationAction(existing),
    };
    callbacks.onStart(planned);
    if (planned.action === 'preserved') {
        callbacks.onCompleted(planned);
        return planned;
    }
    const assetDir = join(await input.catalog.resolveAssetsDir(), MIGRATION_ASSET_DIR, meta.name);
    const frozen = asset === 'persona'
        ? await readFrozenPersona(assetDir, meta.name, input.locale)
        : await renderFrozenSystemPrompt(assetDir, meta.name, input.locale);
    const action = asset === 'persona'
        ? await input.repository.materializePersonaForTrustedBuiltin(meta.name, frozen)
        : await input.repository.materializeSystemPromptForTrustedBuiltin(meta.name, frozen);
    const materialized = { asset, action };
    callbacks.onCompleted(materialized);
    return materialized;
}
function materializationAction(value) {
    if (value === null)
        return 'published_missing';
    return value.trim().length === 0 ? 'repaired_blank' : 'preserved';
}
function readProfileAsset(repository, name, asset) {
    return asset === 'persona' ? repository.getPersona(name) : repository.getSystemPrompt(name);
}
async function readFrozenPersona(assetDir, agentName, locale) {
    const language = locale.trim().toLowerCase().split(/[-_]/u)[0] || 'en';
    const candidates = [
        language.startsWith('zh') ? 'PERSONA-zh.md' : `PERSONA-${language}.md`,
        'PERSONA.md',
    ];
    for (const candidate of candidates) {
        const raw = await readOptionalFile(join(assetDir, candidate));
        if (raw !== undefined)
            return raw;
    }
    throw new Error(`Frozen migration Persona is missing for Agent "${agentName}".`);
}
async function renderFrozenSystemPrompt(assetDir, agentName, locale) {
    const template = await readOptionalFile(join(assetDir, SYSTEM_PROMPT_TEMPLATE));
    if (template === undefined) {
        throw new Error(`Frozen migration system prompt is missing for Agent "${agentName}".`);
    }
    const rendered = renderBuiltinTemplate(template, createBuiltinPromptContext(frozenRenderInput(agentName, locale), {}), `${MIGRATION_ASSET_DIR}/${agentName}/${SYSTEM_PROMPT_TEMPLATE}`);
    // An ordinary Agent prompt is used verbatim, so a surviving placeholder would
    // become permanent user-visible template text.
    if (UNRENDERED_TEMPLATE_RE.test(rendered)) {
        throw new Error(`Frozen migration system prompt for Agent "${agentName}" still contains unrendered template syntax.`);
    }
    return rendered;
}
/**
 * Reads back exactly what the ordinary Agent profile path reads, so a broken
 * materialization fails while the row is still a recoverable built-in.
 */
async function assertManualProfileIsReadable(input, meta, materialized) {
    const [persona, systemPrompt] = await Promise.all([
        input.repository.getPersona(meta.name),
        input.repository.getSystemPrompt(meta.name),
    ]);
    if (!persona?.trim()) {
        throw new LegacyProfileValidationError('persona', materializedAction(materialized, 'persona'));
    }
    if (!systemPrompt?.trim()) {
        throw new LegacyProfileValidationError('system_prompt', materializedAction(materialized, 'system_prompt'));
    }
    await input.catalog.renderSharedBasePrompt(frozenRenderInput(meta.name, input.locale), meta.agentRole);
}
function materializedAction(materialized, asset) {
    return materialized.find((entry) => entry.asset === asset)?.action ?? 'preserved';
}
class LegacyProfileValidationError extends Error {
    context;
    constructor(asset, action) {
        super('Legacy Agent profile is not readable after identity detach preparation.');
        this.context = { asset, action };
    }
}
/**
 * Stable render context for the one-shot migration. The frozen prompts are
 * gated only on capability features, so default capabilities keep the result
 * deterministic across installations.
 */
function frozenRenderInput(agentName, locale) {
    return {
        agentName,
        surface: 'interactive',
        appMode: 'coding',
        locale,
        promptChannel: 'online',
        capabilities: resolveAgentCapabilities(undefined),
    };
}
async function readOptionalFile(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
function report(input, agentName, event) {
    try {
        input.report?.({
            agentName,
            phase: event.phase,
            outcome: event.outcome,
            ...(event.context ? { asset: event.context.asset } : {}),
            ...(event.context?.action ? { action: event.context.action } : {}),
            ...(event.avatarDecision ? { avatarDecision: event.avatarDecision } : {}),
        });
    }
    catch {
        // Observability must never change the identity detach outcome.
    }
}
//# sourceMappingURL=_migration-legacy-identity-detach.js.map