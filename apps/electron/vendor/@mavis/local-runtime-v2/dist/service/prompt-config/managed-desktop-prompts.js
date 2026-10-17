import { access, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPromptRelativePath } from './storage/prompt-path.js';
const MANAGED_DESKTOP_PROMPT_GROUP_NAMES = ['desktop_agent'];
/** Resolves the same packaged asset directory used by BuiltinAgentCatalog. */
export async function resolveBuiltinPromptAssetsDir() {
    const configured = process.env.MAVIS_BUILTIN_AGENTS_V2_DIR?.trim();
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = configured
        ? [configured]
        : [
            resolve(here, '../../../assets/agents'),
            resolve(here, '../../assets/agents'),
            resolve(process.cwd(), 'packages/local-runtime-v2/assets/agents'),
            resolve(process.cwd(), 'assets/agents'),
            resolve(process.cwd(), 'assets/local-runtime-v2/agents'),
        ];
    for (const candidate of candidates) {
        if (await hasRoster(candidate))
            return candidate;
    }
    throw new Error('Local Runtime V2 built-in Agent assets are missing.');
}
/** Loads the package-owned registry shared by Runtime and the Electron package gate. */
export async function loadManagedDesktopPromptRegistry(builtinAssetsDir) {
    const value = await readRegistryFile(builtinAssetsDir);
    if (!isRecord(value))
        throw new Error('Managed Desktop Prompt registry is invalid.');
    assertRegistryGroupSet(value);
    const paths = new Set();
    const groups = {};
    for (const group of MANAGED_DESKTOP_PROMPT_GROUP_NAMES) {
        groups[group] = await parseGroupEntries(value[group], group, paths, builtinAssetsDir);
    }
    if (paths.size === 0)
        throw new Error('Managed Desktop Prompt registry is empty.');
    return { groups: Object.freeze(groups), paths };
}
async function readRegistryFile(builtinAssetsDir) {
    try {
        return JSON.parse(await readFile(join(builtinAssetsDir, 'managed-prompts.json'), 'utf8'));
    }
    catch {
        throw new Error('Managed Desktop Prompt registry is unavailable.');
    }
}
function assertRegistryGroupSet(value) {
    const expectedGroups = new Set(MANAGED_DESKTOP_PROMPT_GROUP_NAMES);
    const actualGroups = Object.keys(value);
    if (actualGroups.length !== expectedGroups.size ||
        actualGroups.some((group) => !expectedGroups.has(group))) {
        throw new Error('Managed Desktop Prompt registry group set is invalid.');
    }
}
async function parseGroupEntries(value, group, paths, builtinAssetsDir) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new Error(`Managed Desktop Prompt group is invalid: ${group}`);
    }
    for (const entry of value) {
        assertPromptRelativePath(entry);
        if (entry === 'managed-prompts.json' || paths.has(entry)) {
            throw new Error(`Managed Desktop Prompt path is invalid: ${entry}`);
        }
        await assertManagedPromptFile(builtinAssetsDir, entry);
        paths.add(entry);
    }
    return Object.freeze([...value]);
}
async function assertManagedPromptFile(builtinAssetsDir, relativePath) {
    try {
        const entry = await stat(join(builtinAssetsDir, ...relativePath.split('/')));
        if (!entry.isFile())
            throw new Error('not a file');
    }
    catch {
        throw new Error(`Managed Desktop Prompt file is unavailable: ${relativePath}`);
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function hasRoster(directory) {
    try {
        await access(join(directory, 'builtin-agents.json'));
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=managed-desktop-prompts.js.map