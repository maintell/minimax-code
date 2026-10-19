import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDefaultAgentAvatarMarker } from '@mavis/shared/agent-avatar';
import yaml from 'yaml';
import { publishFileIfAbsent, replaceFileAtomically } from '../../../infra/file/jsonl.js';
import { PRIMARY_AGENT_NAME, validateLookupName } from '../domain/names.js';
import { isPrimaryFamilyName } from '../domain/primary-identity.js';
import { AgentConfigError, assertSafeAgentAvatarDirectory, decodeAgentAvatarDataUrl, parseBuiltinCanonicalAgentMarkdown, parseCanonicalAgentMarkdown, readBuiltinCanonicalAgentConfig, readCanonicalAgentConfig, readSafeAgentAvatar, readStableAgentMarkdown, serializeBuiltinCanonicalAgentConfig, serializeCanonicalAgentConfig, validateAgentAvatar, } from './canonical-agent-config.js';
import { assertBuiltinConfigModelOnlyUpdate, hasCanonicalPatch, isPerAgentReadAccessError, patchCanonicalMarkdown, rewriteMovedCanonicalCustomName, } from './canonical-agent-patch.js';
export { BuiltinAgentConfigModelOnlyError } from './canonical-agent-patch.js';
const CONFIG_FILE = 'config.yaml';
const PERSONA_FILE = 'PERSONA.md';
const SYSTEM_PROMPT_FILE = 'agent.md';
const AGENT_INSTANCE_FILE = '.agent-instance-id';
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---/;
const LEGACY_IDENTITY_DETACH_ARCHIVE_DIRECTORY = '.legacy-identity-detach';
export class AgentConfigRevisionConflictError extends Error {
    constructor() {
        super('Agent configuration has changed.');
        this.name = 'AgentConfigRevisionConflictError';
    }
}
/** A deleted/recreated Custom Agent must reject a stale editor's PUT. */
export class AgentConfigInstanceConflictError extends Error {
    constructor() {
        super('Agent instance has changed.');
        this.name = 'AgentConfigInstanceConflictError';
    }
}
export class AgentFiles {
    dataDir;
    locks = new Map();
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    agentDir(name) {
        return join(this.dataDir, 'agents', name);
    }
    builtinAgentDir(name) {
        return join(this.dataDir, 'agents', '.builtin', name);
    }
    async ensureLayout(name) {
        // New Custom Agents own only their canonical file (and optional avatar or
        // skills supplied by the user).  Historical workspace/memory/session
        // directories are never recreated by the V2 runtime.
        await this.ensureSafeAgentDirectory(this.agentDir(name));
    }
    /**
     * File truth for Custom Agents. Only direct child directories containing a
     * fully valid canonical file become part of the public roster.
     */
    async listCanonicalCustomAgents() {
        const names = await this.listDirectCustomAgentNames();
        const roster = [];
        for (const name of names) {
            const discovered = await this.inspectCanonicalCustomAgent(name);
            if (discovered)
                roster.push(discovered);
        }
        return roster;
    }
    /**
     * Startup candidates only: safe direct Custom-Agent directories, without
     * interpreting agent.md. Invalid files remain visible for per-Agent recovery.
     */
    async listDirectCustomAgentNames() {
        const agentsRoot = join(this.dataDir, 'agents');
        try {
            await lstat(agentsRoot);
        }
        catch (error) {
            if (isNotFound(error))
                return [];
            throw error;
        }
        await assertSafeAgentAvatarDirectory(agentsRoot, this.dataDir);
        const entries = await readdir(agentsRoot, { withFileTypes: true });
        const names = await Promise.all(entries.map(async (entry) => {
            if (isPrimaryFamilyName(entry.name, PRIMARY_AGENT_NAME))
                return undefined;
            return (await isDirectCustomAgentDirectory(this.dataDir, agentsRoot, entry))
                ? entry.name
                : undefined;
        }));
        return names.filter((name) => name !== undefined).sort();
    }
    async inspectCanonicalCustomAgent(name) {
        try {
            await this.getCanonicalConfig(name);
            const metadata = await lstat(join(this.agentDir(name), SYSTEM_PROMPT_FILE));
            if (!metadata.isFile() || metadata.isSymbolicLink())
                return undefined;
            return {
                name,
                createdAtMs: Math.floor(metadata.birthtimeMs),
                updatedAtMs: Math.floor(metadata.mtimeMs),
            };
        }
        catch (error) {
            // An invalid, inaccessible, or concurrently removed user file must not
            // make the whole roster unavailable. Exact reads still surface its field
            // diagnostic. Keep broader storage and programming failures fail-closed.
            if (error instanceof AgentConfigError ||
                isNotFound(error) ||
                isPerAgentReadAccessError(error)) {
                return undefined;
            }
            throw error;
        }
    }
    getCanonicalConfig(name) {
        return readCanonicalAgentConfig({
            agentDir: this.agentDir(name),
            routeName: name,
            trustedRoot: this.dataDir,
        });
    }
    async rewriteCanonicalCustomNameAfterMove(from, to) {
        return this.withLock(to, () => rewriteMovedCanonicalCustomName(this.dataDir, from, to));
    }
    /** Reads a complete user-editable document without normalizing its bytes. */
    async readCanonicalDocument(name, builtin = false) {
        const agentDir = builtin ? this.builtinAgentDir(name) : this.agentDir(name);
        const content = await readStableAgentMarkdown({
            agentDir,
            routeName: name,
            trustedRoot: this.dataDir,
        });
        const config = await this.parseAndValidateCanonicalDocument(agentDir, name, content);
        return { content, revision: documentRevision(content), config };
    }
    /** Pairs a Custom source revision with its incarnation in one Agent queue. */
    async readCustomCanonicalDocumentWithInstance(name) {
        return this.withLock(name, async () => ({
            document: await this.readCanonicalDocument(name),
            ownerInstanceId: await this.getOrCreateCustomAgentInstanceId(name, true),
        }));
    }
    /**
     * CAS-replaces one complete canonical document under the existing per-Agent
     * file queue.  `replaceFileAtomically` provides the same fsync/rename
     * boundary used by the existing create/materialization writers.
     */
    async replaceCanonicalDocument(input) {
        const builtin = input.builtin === true;
        const lockKey = builtin ? `.builtin:${input.name}` : input.name;
        return this.withLock(lockKey, () => this.replaceCanonicalDocumentLocked(input, builtin));
    }
    async replaceCanonicalDocumentLocked(input, builtin) {
        const agentDir = builtin ? this.builtinAgentDir(input.name) : this.agentDir(input.name);
        if (!builtin && input.expectedInstanceId !== undefined) {
            const instanceId = await this.getOrCreateCustomAgentInstanceId(input.name, true);
            if (instanceId !== input.expectedInstanceId) {
                throw new AgentConfigInstanceConflictError();
            }
        }
        const current = await this.readOrMaterializeCanonicalDocument(input, builtin, agentDir);
        if (current.revision !== input.expectedRevision)
            throw new AgentConfigRevisionConflictError();
        await this.ensureSafeAgentDirectory(agentDir);
        await this.parseAndValidateCanonicalDocument(agentDir, input.name, input.content);
        if (builtin)
            assertBuiltinConfigModelOnlyUpdate(current.content, input.content);
        if (builtin && input.archiveCurrentBuiltin === true) {
            await this.archiveLegacyBuiltinTemplate(agentDir, Buffer.from(current.content, 'utf8'), current.revision);
            if ((await this.readCanonicalDocument(input.name, true)).revision !== current.revision) {
                throw new AgentConfigRevisionConflictError();
            }
        }
        const filePath = join(agentDir, SYSTEM_PROMPT_FILE);
        await replaceFileAtomically(filePath, input.content, async (temporaryPath) => {
            await this.parseAndValidateCanonicalDocument(agentDir, input.name, await readFile(temporaryPath, 'utf8'));
        });
        return this.readCanonicalDocument(input.name, builtin);
    }
    async readOrMaterializeCanonicalDocument(input, builtin, agentDir) {
        try {
            return await this.readCanonicalDocument(input.name, builtin);
        }
        catch (error) {
            if (!builtin ||
                input.missingContent === undefined ||
                !(error instanceof AgentConfigError) ||
                error.code !== 'AGENT_CONFIG_NOT_FOUND') {
                throw error;
            }
            await this.ensureSafeAgentDirectory(agentDir);
            await this.parseAndValidateCanonicalDocument(agentDir, input.name, input.missingContent);
            await publishFileIfAbsent(join(agentDir, SYSTEM_PROMPT_FILE), input.missingContent, async (path) => {
                await this.parseAndValidateCanonicalDocument(agentDir, input.name, await readFile(path, 'utf8'));
            });
            return this.readCanonicalDocument(input.name, true);
        }
    }
    /**
     * A Custom Agent's durable incarnation fences a stale editor after delete
     * and same-name recreation.  Legacy canonical Agents receive one lazily on
     * their first Config read; the marker is local metadata, never executable
     * configuration.
     */
    async getOrCreateCustomAgentInstanceId(name, locked = false) {
        if (!locked) {
            return this.withLock(name, () => this.getOrCreateCustomAgentInstanceId(name, true));
        }
        const agentDir = this.agentDir(name);
        await this.ensureSafeAgentDirectory(agentDir);
        const filePath = join(agentDir, AGENT_INSTANCE_FILE);
        const existing = await this.readInstanceId(filePath);
        if (existing)
            return existing;
        const created = randomUUID();
        const outcome = await publishFileIfAbsent(filePath, `${created}\n`);
        if (outcome === 'published')
            return created;
        const raced = await this.readInstanceId(filePath);
        if (!raced) {
            throw new AgentConfigError('AGENT_CONFIG_INVALID', AGENT_INSTANCE_FILE, 'Agent instance id is invalid.');
        }
        return raced;
    }
    /** Removes only the exact incarnation marker created for an aborted create. */
    async removeCustomAgentInstanceIdIfUnchanged(name, expectedInstanceId, locked = false) {
        if (!locked) {
            return this.withLock(name, () => this.removeCustomAgentInstanceIdIfUnchanged(name, expectedInstanceId, true));
        }
        const filePath = join(this.agentDir(name), AGENT_INSTANCE_FILE);
        const current = await this.readInstanceId(filePath);
        if (current !== expectedInstanceId)
            return false;
        await rm(filePath);
        return true;
    }
    /** Removes a Custom Agent only while its durable incarnation marker still matches. */
    async removeIfInstanceId(name, expectedInstanceId, locked = false) {
        if (!locked) {
            return this.withLock(name, () => this.removeIfInstanceId(name, expectedInstanceId, true));
        }
        const current = await this.readInstanceId(join(this.agentDir(name), AGENT_INSTANCE_FILE));
        if (current !== expectedInstanceId)
            return false;
        await this.remove(name, true);
        return true;
    }
    /**
     * Serves only the canonical relative image after the same stable, no-link
     * read used by the configuration parser. The caller never receives a path
     * it could reinterpret outside this Desktop dataDir.
     */
    async readCanonicalAvatar(name) {
        const config = await this.getCanonicalConfig(name);
        const avatar = config.xMavis?.avatar;
        if (!avatar || isDefaultAgentAvatarMarker(avatar))
            return undefined;
        const { bytes, extension } = await readSafeAgentAvatar(this.agentDir(name), avatar, this.dataDir);
        return { bytes, contentType: contentTypeForAvatarExtension(extension) };
    }
    async writeCanonicalConfig(name, config, locked = false) {
        if (!locked)
            return this.withLock(name, () => this.writeCanonicalConfig(name, config, true));
        await this.ensureLayout(name);
        await this.validateCanonicalConfigForWrite(this.agentDir(name), name, config);
        const filePath = join(this.agentDir(name), SYSTEM_PROMPT_FILE);
        const serialized = serializeCanonicalAgentConfig({ config });
        await replaceFileAtomically(filePath, serialized, async (temporaryPath) => {
            parseCanonicalAgentMarkdown(await readFile(temporaryPath, 'utf8'), name);
        });
    }
    async parseAndValidateCanonicalDocument(agentDir, routeName, content) {
        const config = parseCanonicalAgentMarkdown(content, routeName);
        if (config.xMavis?.avatar) {
            await validateAgentAvatar(agentDir, config.xMavis.avatar, this.dataDir);
        }
        return config;
    }
    async readInstanceId(filePath) {
        try {
            const metadata = await lstat(filePath);
            if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128) {
                throw new AgentConfigError('AGENT_CONFIG_INVALID', AGENT_INSTANCE_FILE, 'Agent instance id is invalid.');
            }
            const value = (await readFile(filePath, 'utf8')).trim();
            if (!isAgentInstanceId(value)) {
                throw new AgentConfigError('AGENT_CONFIG_INVALID', AGENT_INSTANCE_FILE, 'Agent instance id is invalid.');
            }
            const after = await lstat(filePath);
            if (!after.isFile() || after.isSymbolicLink() || after.mtimeMs !== metadata.mtimeMs) {
                throw new AgentConfigError('AGENT_CONFIG_UNSTABLE', AGENT_INSTANCE_FILE, 'Agent instance id changed while it was being read.');
            }
            return value;
        }
        catch (error) {
            if (isNotFound(error))
                return undefined;
            throw error;
        }
    }
    async publishCanonicalConfigIfAbsent(name, config, locked = false) {
        if (!locked) {
            return this.withLock(name, () => this.publishCanonicalConfigIfAbsent(name, config, true));
        }
        await this.ensureLayout(name);
        await this.validateCanonicalConfigForWrite(this.agentDir(name), name, config);
        const serialized = serializeCanonicalAgentConfig({ config });
        return publishFileIfAbsent(join(this.agentDir(name), SYSTEM_PROMPT_FILE), serialized, async (temporaryPath) => {
            parseCanonicalAgentMarkdown(await readFile(temporaryPath, 'utf8'), name);
        });
    }
    /** Compensation only removes the exact file this process published. */
    async removeCanonicalConfigIfUnchanged(name, config, locked = false) {
        if (!locked) {
            return this.withLock(name, () => this.removeCanonicalConfigIfUnchanged(name, config, true));
        }
        if (!(await this.hasExistingDirectory(this.agentDir(name))))
            return false;
        const filePath = join(this.agentDir(name), SYSTEM_PROMPT_FILE);
        let current;
        try {
            current = await readStableAgentMarkdown({
                agentDir: this.agentDir(name),
                routeName: name,
                trustedRoot: this.dataDir,
            });
        }
        catch (error) {
            if (isConfigNotFound(error))
                return false;
            throw error;
        }
        if (current !== serializeCanonicalAgentConfig({ config })) {
            return false;
        }
        await rm(filePath);
        return true;
    }
    /**
     * Desktop create accepts a locally generated image data URL only long enough
     * to atomically publish a relative image beside canonical agent.md. URLs are
     * deliberately not fetchable here: Custom Agent assets never leave dataDir.
     */
    async prepareCustomCreateAvatar(name, avatar, locked = false) {
        if (!locked) {
            return this.withLock(name, () => this.prepareCustomCreateAvatar(name, avatar, true));
        }
        const value = avatar?.trim();
        if (!value)
            return undefined;
        if (!value.startsWith('data:')) {
            await validateAgentAvatar(this.agentDir(name), value, this.dataDir);
            return { reference: value };
        }
        const decoded = decodeAgentAvatarDataUrl(value);
        const reference = `./avatar${decoded.extension}`;
        const filePath = join(this.agentDir(name), `avatar${decoded.extension}`);
        await this.ensureLayout(name);
        await assertSafeAgentAvatarDirectory(this.agentDir(name), this.dataDir);
        const outcome = await publishFileIfAbsent(filePath, decoded.bytes);
        if (outcome !== 'published') {
            throw new AgentConfigError('AGENT_CONFIG_AVATAR_INVALID', 'x-mavis.avatar', 'Custom Agent avatar target already exists.');
        }
        const staged = { reference, bytes: decoded.bytes };
        try {
            await validateAgentAvatar(this.agentDir(name), reference, this.dataDir);
            return { reference, staged };
        }
        catch (error) {
            await this.removeStagedCustomAvatarIfUnchanged(name, staged, true);
            throw error;
        }
    }
    async removeStagedCustomAvatarIfUnchanged(name, avatar, locked = false) {
        if (!locked) {
            return this.withLock(name, () => this.removeStagedCustomAvatarIfUnchanged(name, avatar, true));
        }
        try {
            const current = await readSafeAgentAvatar(this.agentDir(name), avatar.reference, this.dataDir);
            if (!current.bytes.equals(avatar.bytes))
                return false;
            await rm(join(this.agentDir(name), avatar.reference));
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Atomically patches only Desktop profile fields.  The YAML Document keeps
     * unknown fields and comments while the suffix after the closing marker is
     * reused byte-for-byte, so editing identity never rewrites Agent behaviour.
     */
    async patchCanonicalCustomConfig(name, patch, locked = false) {
        if (!locked) {
            return this.withLock(name, () => this.patchCanonicalCustomConfig(name, patch, true));
        }
        if (!hasCanonicalPatch(patch))
            return false;
        const agentDir = this.agentDir(name);
        const current = await readStableAgentMarkdown({
            agentDir,
            routeName: name,
            trustedRoot: this.dataDir,
        });
        // Validate before staging an image so malformed user files are never
        // "repaired" by a field-only write.
        parseCanonicalAgentMarkdown(current, name);
        const preparedAvatar = await this.prepareCustomPatchAvatar(name, patch.avatar);
        const rendered = patchCanonicalMarkdown(current, name, patch, preparedAvatar?.reference);
        try {
            await replaceFileAtomically(join(agentDir, SYSTEM_PROMPT_FILE), rendered, async (temporaryPath) => {
                const parsed = parseCanonicalAgentMarkdown(await readFile(temporaryPath, 'utf8'), name);
                if (parsed.xMavis?.avatar) {
                    await validateAgentAvatar(agentDir, parsed.xMavis.avatar, this.dataDir);
                }
            });
            return true;
        }
        catch (error) {
            if (preparedAvatar?.staged) {
                await this.removeStagedCustomAvatarIfUnchanged(name, preparedAvatar.staged, true);
            }
            throw error;
        }
    }
    async hasSafeAvatar(name, avatar) {
        try {
            await validateAgentAvatar(this.agentDir(name), avatar, this.dataDir);
            return true;
        }
        catch {
            return false;
        }
    }
    async prepareCustomPatchAvatar(name, avatar) {
        if (avatar === undefined || avatar === null || avatar.trim().length === 0)
            return undefined;
        const value = avatar.trim();
        if (!value.startsWith('data:')) {
            await validateAgentAvatar(this.agentDir(name), value, this.dataDir);
            return { reference: value };
        }
        const decoded = decodeAgentAvatarDataUrl(value);
        const fileName = `avatar-${createHash('sha256').update(decoded.bytes).digest('hex').slice(0, 16)}${decoded.extension}`;
        const reference = `./${fileName}`;
        await this.ensureLayout(name);
        await assertSafeAgentAvatarDirectory(this.agentDir(name), this.dataDir);
        const outcome = await publishFileIfAbsent(join(this.agentDir(name), fileName), decoded.bytes);
        if (outcome === 'already-exists') {
            const existing = await readSafeAgentAvatar(this.agentDir(name), reference, this.dataDir);
            if (!existing.bytes.equals(decoded.bytes)) {
                throw new AgentConfigError('AGENT_CONFIG_AVATAR_INVALID', 'x-mavis.avatar', 'Custom Agent avatar target does not match the requested image.');
            }
            return { reference };
        }
        const staged = { reference, bytes: decoded.bytes };
        try {
            await validateAgentAvatar(this.agentDir(name), reference, this.dataDir);
            return { reference, staged };
        }
        catch (error) {
            await this.removeStagedCustomAvatarIfUnchanged(name, staged, true);
            throw error;
        }
    }
    /**
     * A legacy plain agent.md is only a migration input; frontmatter-shaped
     * content is always treated as a canonical file and must fail closed.
     */
    async readLegacyPlainSystemPrompt(name) {
        try {
            const contents = await readStableAgentMarkdown({
                agentDir: this.agentDir(name),
                routeName: name,
                trustedRoot: this.dataDir,
            });
            return contents.startsWith('---\n') || contents.startsWith('---\r\n') ? null : contents;
        }
        catch (error) {
            if (isConfigNotFound(error))
                return null;
            throw error;
        }
    }
    /** Safely rehome a legacy relative image before publishing canonical config. */
    async materializeLegacyAvatar(name, avatar) {
        try {
            const { bytes, extension } = await readSafeAgentAvatar(this.agentDir(name), avatar, this.dataDir);
            const canonicalAvatar = `./avatar${extension}`;
            if (avatar === canonicalAvatar)
                return canonicalAvatar;
            const targetPath = join(this.agentDir(name), `avatar${extension}`);
            const outcome = await publishFileIfAbsent(targetPath, bytes);
            if (outcome === 'published') {
                await validateAgentAvatar(this.agentDir(name), canonicalAvatar, this.dataDir);
                return canonicalAvatar;
            }
            const existing = await readSafeAgentAvatar(this.agentDir(name), canonicalAvatar, this.dataDir);
            return existing.bytes.equals(bytes) ? canonicalAvatar : undefined;
        }
        catch {
            // A historical display asset is non-executable. Omit rather than follow
            // a link, cross a directory boundary, or block profile materialization.
            return undefined;
        }
    }
    async getBuiltinCanonicalConfig(name) {
        const parsed = await readBuiltinCanonicalAgentConfig({
            agentDir: this.builtinAgentDir(name),
            routeName: name,
            trustedRoot: this.dataDir,
        });
        // The startup-rebuilt policy is an audit mirror only. Runtime capability
        // resolution always starts from the shipped definition, never this file.
        return parsed.config;
    }
    /** Seeds a Builtin source only when its canonical file is absent. */
    async writeBuiltinCanonicalConfig(name, config, locked = false) {
        if (!locked) {
            return this.withLock(`.builtin:${name}`, () => this.writeBuiltinCanonicalConfig(name, config, true));
        }
        await this.ensureSafeAgentDirectory(this.builtinAgentDir(name));
        await this.validateBuiltinCanonicalConfigForWrite(this.builtinAgentDir(name), name, config);
        const filePath = join(this.builtinAgentDir(name), SYSTEM_PROMPT_FILE);
        const serialized = serializeBuiltinCanonicalAgentConfig({ config });
        await publishFileIfAbsent(filePath, serialized, async (temporaryPath) => {
            parseBuiltinCanonicalAgentMarkdown(await readFile(temporaryPath, 'utf8'), name, {
                requireFeaturePolicy: true,
            });
        });
    }
    /** Removes only a stale primary canonical file; legacy primary assets remain untouched. */
    removeBuiltinCanonicalConfig(name) {
        return this.withLock(`.builtin:${name}`, async () => {
            const agentDir = this.builtinAgentDir(name);
            if (!(await this.hasExistingDirectory(agentDir)))
                return false;
            await assertSafeAgentAvatarDirectory(agentDir, this.dataDir);
            try {
                await rm(join(agentDir, SYSTEM_PROMPT_FILE));
                return true;
            }
            catch (error) {
                if (isNotFound(error))
                    return false;
                throw error;
            }
        });
    }
    async validateCanonicalConfigForWrite(agentDir, routeName, config) {
        parseCanonicalAgentMarkdown(serializeCanonicalAgentConfig({ config }), routeName);
        if (config.xMavis?.avatar) {
            await validateAgentAvatar(agentDir, config.xMavis.avatar, this.dataDir);
        }
    }
    async validateBuiltinCanonicalConfigForWrite(agentDir, routeName, config) {
        parseBuiltinCanonicalAgentMarkdown(serializeBuiltinCanonicalAgentConfig({ config }), routeName, { requireFeaturePolicy: true });
        if (config.xMavis?.avatar) {
            await validateAgentAvatar(agentDir, config.xMavis.avatar, this.dataDir);
        }
    }
    async ensureSafeAgentDirectory(agentDir) {
        await mkdir(this.dataDir, { recursive: true });
        const root = resolve(this.dataDir);
        const target = resolve(agentDir);
        const relativePath = relative(root, target);
        const segments = relativePath.split(sep).filter(Boolean);
        if (target === root ||
            !segments.length ||
            relativePath === '..' ||
            relativePath.startsWith(`..${sep}`) ||
            isAbsolute(relativePath)) {
            throw unsafeAgentDirectory();
        }
        await assertSafeAgentAvatarDirectory(root, root);
        let parent = root;
        for (const segment of segments) {
            await assertSafeAgentAvatarDirectory(parent, root);
            const child = join(parent, segment);
            await this.ensureSafeAgentDirectoryChild(child, root);
            parent = child;
        }
    }
    async ensureSafeAgentDirectoryChild(child, root) {
        try {
            await lstat(child);
        }
        catch (error) {
            if (!isNotFound(error))
                throw error;
            try {
                await mkdir(child);
            }
            catch (mkdirError) {
                if (mkdirError?.code !== 'EEXIST') {
                    throw mkdirError;
                }
            }
        }
        await assertSafeAgentAvatarDirectory(child, root);
    }
    async hasExistingDirectory(directory) {
        try {
            await lstat(directory);
            return true;
        }
        catch (error) {
            if (isNotFound(error))
                return false;
            throw error;
        }
    }
    async getConfig(name) {
        let content;
        try {
            content = await readFile(join(this.agentDir(name), CONFIG_FILE), 'utf8');
        }
        catch (error) {
            if (isNotFound(error))
                return null;
            if (isMalformedLegacyConfigPath(error)) {
                throw new AgentConfigError('AGENT_CONFIG_INVALID', CONFIG_FILE, 'Legacy config.yaml must be a readable file.');
            }
            throw error;
        }
        let parsed;
        try {
            parsed = yaml.parse(content);
        }
        catch {
            throw new AgentConfigError('AGENT_CONFIG_INVALID', CONFIG_FILE, 'Legacy config.yaml could not be parsed.');
        }
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? normalizeConfig(parsed)
            : {};
    }
    async updateConfig(name, fields, locked = false) {
        if (!locked)
            return this.withLock(name, () => this.updateConfig(name, fields, true));
        const current = (await this.getConfig(name)) ?? {};
        await this.writeConfig(name, { ...current, ...fields });
        return true;
    }
    async getPersona(name) {
        return this.readMarkdown(name, PERSONA_FILE);
    }
    updatePersona(name, text, locked = false) {
        return locked
            ? this.writeMarkdown(name, PERSONA_FILE, text)
            : this.withLock(name, () => this.updatePersona(name, text, true));
    }
    publishPersonaIfAbsent(name, text, locked = false) {
        return locked
            ? this.publishMarkdownIfAbsent(name, PERSONA_FILE, text)
            : this.withLock(name, () => this.publishPersonaIfAbsent(name, text, true));
    }
    /**
     * This migration-only entrypoint must be reached only after the caller has
     * proved trusted legacy-builtin provenance. Storage never infers trust from
     * a file name or from a semantic-blank body.
     */
    materializePersonaForTrustedBuiltin(name, text) {
        return this.withLock(name, () => this.materializeMarkdownForTrustedBuiltin(name, PERSONA_FILE, text));
    }
    deletePersona(name, locked = false) {
        return locked
            ? this.deleteMarkdown(name, PERSONA_FILE)
            : this.withLock(name, () => this.deletePersona(name, true));
    }
    getSystemPrompt(name) {
        return this.readMarkdown(name, SYSTEM_PROMPT_FILE);
    }
    updateSystemPrompt(name, text, locked = false) {
        return locked
            ? this.writeMarkdown(name, SYSTEM_PROMPT_FILE, text)
            : this.withLock(name, () => this.updateSystemPrompt(name, text, true));
    }
    publishSystemPromptIfAbsent(name, text, locked = false) {
        return locked
            ? this.publishMarkdownIfAbsent(name, SYSTEM_PROMPT_FILE, text)
            : this.withLock(name, () => this.publishSystemPromptIfAbsent(name, text, true));
    }
    /** See materializePersonaForTrustedBuiltin for the provenance boundary. */
    materializeSystemPromptForTrustedBuiltin(name, text) {
        return this.withLock(name, () => this.materializeMarkdownForTrustedBuiltin(name, SYSTEM_PROMPT_FILE, text));
    }
    deleteSystemPrompt(name, locked = false) {
        return locked
            ? this.deleteMarkdown(name, SYSTEM_PROMPT_FILE)
            : this.withLock(name, () => this.deleteSystemPrompt(name, true));
    }
    remove(name, locked = false) {
        return locked
            ? rm(this.agentDir(name), { recursive: true, force: true })
            : this.withLock(name, () => this.remove(name, true));
    }
    async withLock(name, operation) {
        const previous = this.locks.get(name) ?? Promise.resolve();
        let result;
        const current = (async () => {
            try {
                await previous;
            }
            catch {
                // Continue the per-Agent queue after a failed prior operation.
            }
            result = await operation();
        })();
        this.locks.set(name, current);
        try {
            await current;
            return result;
        }
        finally {
            if (this.locks.get(name) === current)
                this.locks.delete(name);
        }
    }
    async writeConfig(name, config) {
        await this.ensureLayout(name);
        await writeFile(join(this.agentDir(name), CONFIG_FILE), `${yaml.stringify(config, { indent: 2, lineWidth: -1 }).trimEnd()}\n`, 'utf8');
    }
    async readMarkdown(name, fileName) {
        try {
            const raw = await readFile(join(this.agentDir(name), fileName), 'utf8');
            return stripFrontmatter(raw);
        }
        catch (error) {
            if (isNotFound(error))
                return null;
            throw error;
        }
    }
    async writeMarkdown(name, fileName, text) {
        await this.ensureLayout(name);
        await writeFile(join(this.agentDir(name), fileName), text, 'utf8');
    }
    publishMarkdownIfAbsent(name, fileName, text) {
        return publishFileIfAbsent(join(this.agentDir(name), fileName), text);
    }
    /**
     * A frontmatter-only file reads as an empty body, so it is semantically
     * blank even though its raw bytes are not whitespace. Before repairing such
     * a trusted migration asset, archive those exact bytes under their stable
     * content digest, then re-read in the same Agent lock. Archive/hash/compare
     * stay Buffer-based; UTF-8 decoding is only for the semantic-body decision.
     * The invariant is: a failure leaves either the old target intact or a
     * complete replacement, and the row remains retryable until the caller flips
     * its DB identity last.
     */
    async materializeMarkdownForTrustedBuiltin(name, fileName, text) {
        const raw = await this.readRawMarkdown(name, fileName);
        if (raw === undefined) {
            const outcome = await this.publishMarkdownIfAbsent(name, fileName, text);
            return outcome === 'published' ? 'published_missing' : 'preserved';
        }
        if (hasSemanticMarkdownBody(raw))
            return 'preserved';
        await this.archiveLegacyIdentityDetachRaw(name, fileName, raw);
        const current = await this.readRawMarkdown(name, fileName);
        if (current === undefined) {
            const outcome = await this.publishMarkdownIfAbsent(name, fileName, text);
            return outcome === 'published' ? 'published_missing' : 'preserved';
        }
        if (hasSemanticMarkdownBody(current))
            return 'preserved';
        if (!current.equals(raw)) {
            // Preserve every distinct blank revision, but never replace a target
            // that changed after our first read. Fresh startup retries the newest
            // stable revision under the same crash-recovery invariant.
            await this.archiveLegacyIdentityDetachRaw(name, fileName, current);
            throw new Error('Legacy blank profile changed during atomic repair.');
        }
        await replaceFileAtomically(join(this.agentDir(name), fileName), text);
        return 'repaired_blank';
    }
    async readRawMarkdown(name, fileName) {
        try {
            return await readFile(join(this.agentDir(name), fileName));
        }
        catch (error) {
            if (isNotFound(error))
                return undefined;
            throw error;
        }
    }
    async archiveLegacyIdentityDetachRaw(name, fileName, raw) {
        const archivePath = join(this.agentDir(name), LEGACY_IDENTITY_DETACH_ARCHIVE_DIRECTORY, `${fileName}.${rawDigest(raw)}.raw`);
        const outcome = await publishFileIfAbsent(archivePath, raw);
        if (outcome === 'published')
            return;
        if (!(await readFile(archivePath)).equals(raw)) {
            throw new Error('Legacy blank profile archive does not match the current raw asset.');
        }
    }
    async archiveLegacyBuiltinTemplate(agentDir, raw, revision) {
        const archivePath = join(agentDir, `.${SYSTEM_PROMPT_FILE}.legacy-bundled.${revision}.raw`);
        const outcome = await publishFileIfAbsent(archivePath, raw);
        if (outcome === 'published')
            return;
        const metadata = await lstat(archivePath);
        if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== raw.length) {
            throw new Error('Legacy Builtin prompt archive is not the expected regular file.');
        }
        if (!(await readFile(archivePath)).equals(raw)) {
            throw new Error('Legacy Builtin prompt archive does not match the current source.');
        }
    }
    async deleteMarkdown(name, fileName) {
        try {
            await rm(join(this.agentDir(name), fileName));
            return true;
        }
        catch (error) {
            if (isNotFound(error))
                return false;
            throw error;
        }
    }
}
async function isDirectCustomAgentDirectory(dataDir, agentsRoot, entry) {
    if (entry.name === '.builtin' || (!entry.isDirectory() && !entry.isSymbolicLink())) {
        return false;
    }
    try {
        validateLookupName(entry.name);
    }
    catch {
        return false;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink())
        return true;
    const directory = join(agentsRoot, entry.name);
    try {
        await assertSafeAgentAvatarDirectory(directory, dataDir);
        return true;
    }
    catch (error) {
        if (error instanceof AgentConfigError || isNotFound(error))
            return false;
        throw error;
    }
}
function normalizeConfig(raw) {
    return typeof raw.defaultWorkspaceDir === 'string'
        ? { defaultWorkspaceDir: raw.defaultWorkspaceDir }
        : {};
}
function stripFrontmatter(raw) {
    const match = FRONTMATTER_RE.exec(raw);
    return match ? raw.slice(match[0].length).replace(/^\r?\n(\r?\n)?/, '') : raw;
}
function hasSemanticMarkdownBody(raw) {
    return stripFrontmatter(raw.toString('utf8')).trim().length > 0;
}
function rawDigest(raw) {
    return createHash('sha256').update(raw).digest('hex');
}
function documentRevision(content) {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}
function isAgentInstanceId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
function contentTypeForAvatarExtension(extension) {
    switch (extension) {
        case '.png':
            return 'image/png';
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.gif':
            return 'image/gif';
        case '.webp':
            return 'image/webp';
        default:
            // readSafeAgentAvatar has already validated this extension. Keeping the
            // impossible branch fail-closed protects the HTTP content type if that
            // validator changes later.
            throw new AgentConfigError('AGENT_CONFIG_AVATAR_INVALID', 'x-mavis.avatar', 'Avatar must be a supported image file.');
    }
}
const isNotFound = (error) => error?.code === 'ENOENT';
function isMalformedLegacyConfigPath(error) {
    const code = error?.code;
    return code === 'EISDIR' || code === 'ENOTDIR';
}
function isConfigNotFound(error) {
    return error instanceof Error && 'code' in error && error.code === 'AGENT_CONFIG_NOT_FOUND';
}
function unsafeAgentDirectory() {
    return new AgentConfigError('AGENT_CONFIG_INVALID', 'agent_dir', 'Agent directory path escapes the Desktop data directory.');
}
//# sourceMappingURL=agent-files.js.map