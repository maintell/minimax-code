import { normalizeWindowsShellBase } from '../../agent-shell/index.js';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAgentBuiltinToolEnabled, parseAgentCapabilityConfig, } from '@mavis/config';
import { PromptSnapshotInvalidError, } from '@mavis/agent-runtime';
import { BUILTIN_ROSTER_FILE, FEATURE_FILES, PRIMARY_AGENT_NAME, canonicalBuiltinName, defaultLocale, legacyNamesFor, surfacePromptFiles, toSurfaceRenderInput, } from './definitions.js';
import { createBuiltinPromptContext, parseFrontmatter, renderBuiltinTemplate, stripFrontmatter, } from './prompt-renderer.js';
import { captureLocalPromptAssets } from './prompt-assets.js';
export { canonicalBuiltinName, legacyNamesFor, resolveCanonicalCapabilities, } from './definitions.js';
export class BuiltinAgentCatalog {
    assetsDirOverride;
    promptFileReader;
    freezeLocalPrompts;
    localPromptAssets;
    constructor(options = {}) {
        this.assetsDirOverride = options.assetsDir?.trim() || undefined;
        this.promptFileReader = options.promptFileReader;
        this.freezeLocalPrompts = options.freezeLocalPrompts === true;
    }
    async frozenPromptSource() {
        if (!this.freezeLocalPrompts)
            return undefined;
        const contents = await this.frozenAssets();
        const registry = JSON.parse(contents.get('managed-prompts.json') ?? '{"desktop_agent":[]}');
        const managedKeys = new Set(registry.desktop_agent);
        const snapshot = Object.freeze({});
        return {
            capture: async () => snapshot,
            captureBuiltin: async () => snapshot,
            read: async (selected, key) => {
                if (selected !== snapshot)
                    throw new TypeError('Prompt snapshot was not captured by this source.');
                const content = contents.get(key);
                if (content !== undefined)
                    return { kind: 'found', content };
                return managedKeys.has(key) ? { kind: 'invalid' } : { kind: 'missing' };
            },
        };
    }
    async listDefinitions() {
        const names = await this.readRoster();
        return Promise.all(names.map((name) => this.readDefinition(name)));
    }
    async hasBuiltin(name) {
        const canonical = canonicalBuiltinName(name);
        return (await this.readRoster()).includes(canonical);
    }
    async readDefinition(name) {
        const canonical = canonicalBuiltinName(name);
        if (!(await this.readRoster()).includes(canonical)) {
            throw new Error(`Built-in Agent definition is not in the roster: ${name}`);
        }
        const agentDir = join(await this.assetsDir(), canonical);
        const persona = await this.readLocalizedPersona(agentDir, 'en');
        const frontmatter = parseFrontmatter(persona ?? '').frontmatter;
        const capabilityOverride = await this.readCapabilityOverride(agentDir);
        const identity = {
            ...(typeof frontmatter.display_name === 'string'
                ? { displayName: frontmatter.display_name }
                : {}),
            ...(typeof frontmatter.description === 'string'
                ? { description: frontmatter.description }
                : {}),
            ...(typeof frontmatter.avatar === 'string' ? { avatar: frontmatter.avatar } : {}),
        };
        return {
            name: canonical,
            role: canonical === PRIMARY_AGENT_NAME ? 'orchestrator' : canonical,
            legacyNames: legacyNamesFor(canonical),
            identity,
            ...(capabilityOverride ? { capabilityOverride } : {}),
        };
    }
    async render(input, agentSystemTemplate) {
        const canonical = canonicalBuiltinName(input.agentName);
        const definition = await this.readDefinition(canonical);
        const parts = await this.renderAgentParts(canonical, input, agentSystemTemplate);
        const surface = canonical === PRIMARY_AGENT_NAME && usesV2Prompts(input) && input.surface !== 'task-child'
            ? { core: '' }
            : await this.readSurfaceParts(canonical, input);
        const sharedBase = await this.renderSharedBaseParts(input, definition.role, {
            includeAllLayer: canonical !== PRIMARY_AGENT_NAME || parts.coreTemplate === undefined,
        });
        return {
            ...(parts.persona ? { persona: parts.persona } : {}),
            corePrompt: [parts.agentPrompt.trim(), sharedBase.core.trim()].filter(Boolean).join('\n\n'),
            agentSystemPrompt: parts.agentPrompt,
            ...(parts.promptSnapshot ? { promptSnapshot: parts.promptSnapshot } : {}),
            surfacePrompt: surface.core,
            identity: definition.identity,
            assetAgentName: canonical,
        };
    }
    async renderAgentParts(canonical, input, agentSystemTemplate) {
        const [personaTemplate, coreTemplate, featurePrompts] = await Promise.all([
            agentSystemTemplate === undefined
                ? this.readPromptAsset(canonical, input, 'persona')
                : Promise.resolve(undefined),
            agentSystemTemplate === undefined
                ? this.readPromptAsset(canonical, input, 'system')
                : Promise.resolve(agentSystemTemplate),
            this.renderFeaturePrompts(canonical, input),
        ]);
        const context = this.context(input, featurePrompts);
        const persona = personaTemplate
            ? stripFrontmatter(this.renderTemplate(personaTemplate, context, `${canonical}/persona`))
            : undefined;
        const agentPrompt = coreTemplate
            ? this.renderTemplate(coreTemplate, context, agentSystemTemplate === undefined ? `${canonical}/system` : `${canonical}/agent.md`)
            : '';
        const promptSnapshot = usesV2Prompts(input)
            ? {
                mode: resolvePromptMode(input),
                ...(input.promptVersion ? { version: input.promptVersion } : {}),
                template: coreTemplate ?? '',
                systemPrompt: agentPrompt,
            }
            : undefined;
        return { persona, coreTemplate, agentPrompt, promptSnapshot };
    }
    renderPromptSnapshot(input, snapshot) {
        return {
            ...snapshot,
            systemPrompt: this.renderTemplate(snapshot.template, this.context(input, {}), 'saved V2 system'),
        };
    }
    /** Reads only the built-in Agent's own prompt assets; shared base layers are excluded. */
    async readCanonicalContent(input) {
        const rendered = await this.renderAgentParts(canonicalBuiltinName(input.agentName), input);
        return {
            ...(rendered.persona === undefined ? {} : { persona: rendered.persona }),
            ...(rendered.coreTemplate === undefined ? {} : { systemPrompt: rendered.agentPrompt }),
        };
    }
    /**
     * Reads the bundled seed without rendering it, so a canonical `agent.md`
     * can keep the mode and capability placeholders needed by later turns.
     */
    async readCanonicalTemplate(input) {
        const canonical = canonicalBuiltinName(input.agentName);
        if (canonical === PRIMARY_AGENT_NAME && usesV2Prompts(input)) {
            const templates = await Promise.all(['coding', 'work', 'tui'].map(async (mode) => {
                const path = posix.join('_v2', mode, 'SYSTEM.md.hbs');
                const template = await this.readPromptAssetFile(v2PromptReadContext(input), path);
                if (template === undefined)
                    throw new Error(`Mandatory V2 Agent prompt is missing: ${path}.`);
                return `{{#if mode.${mode}}}\n${template}\n{{/if}}`;
            }));
            return { systemPrompt: templates.join('\n\n') };
        }
        const [personaTemplate, systemPrompt] = await Promise.all([
            this.readPromptAsset(canonical, input, 'persona'),
            this.readPromptAsset(canonical, input, 'system'),
        ]);
        return {
            ...(personaTemplate === undefined ? {} : { persona: stripFrontmatter(personaTemplate) }),
            ...(systemPrompt === undefined ? {} : { systemPrompt }),
        };
    }
    async renderSurfacePrompt(input) {
        const files = surfacePromptFiles(input.surface);
        const custom = await this.readSurfaceOverride(input.agentConfigDir, files.fallback);
        const renderInput = toSurfaceRenderInput(input);
        const defaults = await this.readSurfaceParts('_default', renderInput);
        const rendered = custom ?? defaults.core;
        return this.ensureDelegatedTaskContract(rendered, renderInput, defaults.core);
    }
    async renderSharedBasePrompt(input, agentRole, options = {}) {
        const parts = await this.renderSharedBaseParts(input, agentRole, options);
        return parts.core;
    }
    async renderSharedBaseParts(input, agentRole, options = {}) {
        const root = usesV2Prompts(input) ? '_v2' : '_default';
        const files = [
            ...(options.includeAllLayer === false ? [] : ['prompt-base-all']),
            ...(!usesV2Prompts(input) &&
                process.platform === 'win32' &&
                isAgentBuiltinToolEnabled(input.capabilities, 'bash')
                ? ['prompt-base-windows']
                : []),
            ...(agentRole === 'orchestrator' ? [] : ['prompt-base-worker']),
        ];
        const core = [];
        for (const file of files) {
            const templates = await this.readLayerTemplates(input, root, `${file}.md.hbs`);
            if (templates.core === undefined)
                throw new Error(`Mandatory local-runtime-v2 base prompt is missing: ${file}.md.hbs.`);
            const parts = this.renderLayerParts(input, `${root}/${file}`, templates);
            core.push(file === 'prompt-base-windows' ? normalizeWindowsShellBase(parts.core) : parts.core);
        }
        return {
            core: core
                .map((part) => part.trim())
                .filter(Boolean)
                .join('\n\n'),
        };
    }
    renderLayerParts(input, source, templates) {
        const context = {
            ...this.context(input, {}),
            layer: {
                base: source.endsWith('/prompt-base-all'),
                worker: source.endsWith('/prompt-base-worker'),
                root: source.endsWith('/prompt-session-root.md.hbs'),
                branch: source.endsWith('/prompt-session-branch.md.hbs'),
            },
        };
        return {
            core: this.renderTemplate(templates.core ?? '', context, `${source}/core`).trim(),
        };
    }
    async readLayerTemplates(input, root, file) {
        const v2 = usesV2Prompts(input);
        if (v2) {
            return {
                core: await this.readPromptAssetFile(v2PromptReadContext(input), '_v2/AGENT_CONTEXT.md.hbs'),
            };
        }
        const context = input.promptReadContext;
        const directory = root;
        const fallback = file.replace(/\.hbs$/u, '');
        const core = await this.readFirstPromptAsset(context, [
            posix.join(directory, file),
            posix.join(directory, fallback),
        ]);
        return { core };
    }
    async readSurfaceOverride(agentConfigDir, fallback) {
        return agentConfigDir ? this.readOptionalFile(join(agentConfigDir, fallback)) : undefined;
    }
    ensureDelegatedTaskContract(rendered, input, contract) {
        if (input.surface !== 'task-child' || rendered.includes('## Delegated Task Contract')) {
            return rendered;
        }
        return [rendered.trim(), contract].filter(Boolean).join('\n\n');
    }
    async readSurfaceParts(canonical, input) {
        const files = surfacePromptFiles(input.surface);
        const roots = usesV2Prompts(input) ? ['_v2'] : [canonical, '_default'];
        for (const root of new Set(roots)) {
            const templates = await this.readLayerTemplates(input, root, files.template);
            if (templates.core !== undefined) {
                return this.renderLayerParts(input, `${root}/${files.template}`, templates);
            }
        }
        if (input.promptProfile === 'tui')
            throw new Error(`Mandatory TUI surface prompt is missing: ${files.template}.`);
        return { core: '' };
    }
    async readPromptAsset(canonical, input, kind) {
        const v2 = usesV2Prompts(input);
        if (v2) {
            if (kind === 'persona')
                return undefined;
            const path = canonical === PRIMARY_AGENT_NAME
                ? posix.join('_v2', resolvePromptMode(input), 'SYSTEM.md.hbs')
                : posix.join('_v2', `${canonical}.md.hbs`);
            const template = await this.readPromptAssetFile(v2PromptReadContext(input), path);
            if (template === undefined)
                throw new Error(`Mandatory V2 Agent prompt is missing: ${path}.`);
            return template;
        }
        const promptReadContext = input.promptReadContext;
        if (canonical === PRIMARY_AGENT_NAME) {
            const mode = input.appMode;
            const template = await this.readModeAsset({
                agentName: canonical,
                appMode: mode,
                locale: 'en',
                channel: input.promptChannel,
                kind,
                promptReadContext,
            });
            if (template === undefined)
                throw new Error(`Mandatory ${mode} Mavis ${kind} prompt is missing.`);
            return template;
        }
        const directory = canonical;
        return kind === 'persona'
            ? this.readLocalizedPromptAsset(promptReadContext, directory, 'en')
            : this.readFirstPromptAsset(promptReadContext, [
                posix.join(directory, 'system-prompt.md.hbs'),
                posix.join(directory, 'system-prompt.md'),
            ]);
    }
    async resolveAssetsDir() {
        return this.assetsDir();
    }
    async readGreetingTemplate(locale = defaultLocale(), promptReadContext) {
        const localized = locale.toLowerCase().startsWith('zh') ? 'greeting-zh.md' : 'greeting.md';
        return ((await this.readPromptAssetFile(promptReadContext, localized)) ??
            (await this.readPromptAssetFile(promptReadContext, 'greeting.md')) ??
            '');
    }
    async readRoster() {
        const raw = await readFile(join(await this.assetsDir(), BUILTIN_ROSTER_FILE), 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            throw new Error('Built-in Agent roster must be an array.');
        const names = parsed.filter((value) => typeof value === 'string');
        return names.map((name) => canonicalBuiltinName(name));
    }
    async readCapabilityOverride(agentDir) {
        const raw = await this.readOptionalFile(join(agentDir, 'agent.md'));
        if (raw === undefined)
            return undefined;
        const frontmatter = parseFrontmatter(raw).frontmatter;
        const capabilityFields = Object.fromEntries(['persona', 'tools', 'builtinTools', 'skills', 'features']
            .filter((key) => Object.hasOwn(frontmatter, key))
            .map((key) => [key, frontmatter[key]]));
        return Object.keys(capabilityFields).length > 0
            ? parseAgentCapabilityConfig(capabilityFields, `${agentDir}/agent.md`)
            : undefined;
    }
    async renderFeaturePrompts(canonical, input) {
        const result = {};
        const v2 = usesV2Prompts(input);
        if (v2)
            return result;
        const featureDir = posix.join(canonical, 'features');
        for (const [key, fileName] of Object.entries(FEATURE_FILES)) {
            if (key === 'cron' && input.cronEnabled === false) {
                result[key] = '';
                continue;
            }
            const template = await this.readPromptAssetFile(input.promptReadContext, posix.join(featureDir, fileName));
            if (template === undefined) {
                result[key] = '';
                continue;
            }
            const rendered = this.renderTemplate(template, this.context(input, result), `features/${fileName}`);
            result[key] = rendered;
        }
        return result;
    }
    context(input, featurePrompts) {
        return createBuiltinPromptContext(input, featurePrompts);
    }
    renderTemplate(template, context, source) {
        return renderBuiltinTemplate(template, context, source);
    }
    async readModeAsset(input) {
        const base = posix.join(input.agentName, 'modes', input.appMode);
        const channels = input.channel === 'internal' ? ['internal', 'online'] : ['online'];
        for (const candidate of channels) {
            const dir = posix.join(base, candidate);
            const template = input.kind === 'system'
                ? await this.readPromptAssetFile(input.promptReadContext, posix.join(dir, 'SYSTEM.md.hbs'))
                : await this.readLocalizedPromptAsset(input.promptReadContext, dir, input.locale, '.md.hbs');
            if (template !== undefined)
                return template;
        }
        return undefined;
    }
    async readLocalizedPersona(dir, locale, suffix = '.md') {
        const lang = locale.trim().toLowerCase().split(/[-_]/u)[0] || 'en';
        const candidates = [
            lang.startsWith('zh') ? `PERSONA-zh${suffix}` : `PERSONA-${lang}${suffix}`,
            `PERSONA${suffix}`,
            'PERSONA.md',
        ];
        return this.readFirst(dir, candidates);
    }
    async readLocalizedPromptAsset(promptReadContext, relativeDir, locale, suffix = '.md') {
        const lang = locale.trim().toLowerCase().split(/[-_]/u)[0] || 'en';
        const candidates = [
            lang.startsWith('zh') ? `PERSONA-zh${suffix}` : `PERSONA-${lang}${suffix}`,
            `PERSONA${suffix}`,
            'PERSONA.md',
        ].map((name) => posix.join(relativeDir, name));
        return this.readFirstPromptAsset(promptReadContext, candidates);
    }
    async readFirstPromptAsset(promptReadContext, relativePaths) {
        for (const relativePath of relativePaths) {
            const content = await this.readPromptAssetFile(promptReadContext, relativePath);
            if (content !== undefined)
                return content;
        }
        return undefined;
    }
    async readPromptAssetFile(promptReadContext, relativePath) {
        if (isPromptReadScope(promptReadContext)) {
            const result = await promptReadContext.source.read(promptReadContext.snapshot, relativePath);
            if (result.kind === 'found')
                return result.content;
            if (result.kind === 'invalid') {
                throw new PromptSnapshotInvalidError(`Built-in Agent prompt cannot be read: ${relativePath}`);
            }
            return undefined;
        }
        if (promptReadContext) {
            if (!this.promptFileReader) {
                throw new Error('Built-in Prompt context was supplied without a PromptFileReader.');
            }
            return this.promptFileReader.read(promptReadContext, relativePath);
        }
        if (this.freezeLocalPrompts) {
            return (await this.frozenAssets()).get(relativePath);
        }
        return this.readOptionalFile(join(await this.assetsDir(), relativePath));
    }
    frozenAssets() {
        this.localPromptAssets ??= this.captureLocalAssets();
        return this.localPromptAssets;
    }
    async captureLocalAssets() {
        return captureLocalPromptAssets(await this.assetsDir());
    }
    async readFirst(dir, fileNames) {
        for (const fileName of fileNames) {
            const content = await this.readOptionalFile(join(dir, fileName));
            if (content !== undefined)
                return content;
        }
        return undefined;
    }
    async readOptionalFile(path) {
        try {
            return await readFile(path, 'utf8');
        }
        catch {
            return undefined;
        }
    }
    async assetsDir() {
        const configured = process.env.MAVIS_BUILTIN_AGENTS_V2_DIR?.trim() || this.assetsDirOverride;
        const here = dirname(fileURLToPath(import.meta.url));
        const candidates = configured
            ? [configured]
            : [
                resolve(here, '../../../../assets/agents'),
                resolve(here, 'assets/agents'),
                resolve(process.cwd(), 'packages/local-runtime-v2/assets/agents'),
                resolve(process.cwd(), 'assets/agents'),
                resolve(process.cwd(), 'assets/local-runtime-v2/agents'),
            ];
        for (const candidate of candidates) {
            const roster = await this.readOptionalFile(join(candidate, BUILTIN_ROSTER_FILE));
            if (roster !== undefined)
                return candidate;
        }
        throw new Error('Local Runtime V2 built-in Agent assets are missing.');
    }
}
function resolvePromptMode(input) {
    return input.promptMode ?? (input.promptProfile === 'tui' ? 'tui' : input.appMode);
}
function usesV2Prompts(input) {
    return (input.promptProfile === 'desktop' ||
        input.promptProfile === 'tui' ||
        input.promptMode !== undefined);
}
function v2PromptReadContext(input) {
    return input.promptProfile === 'desktop' ? input.promptReadContext : undefined;
}
function isPromptReadScope(value) {
    return Boolean(value && 'source' in value && 'snapshot' in value);
}
//# sourceMappingURL=catalog.js.map