import { access, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function resolveBuiltinSkillsDir() {
    for (const candidate of getBuiltinSkillsDirCandidates()) {
        if (await isDirectory(candidate))
            return candidate;
    }
    return undefined;
}
export async function resolveBuiltinAgentsDir() {
    for (const candidate of getBuiltinAgentsDirCandidates()) {
        if (await isDirectory(candidate))
            return candidate;
    }
    return undefined;
}
export function getBuiltinSkillsDirCandidates() {
    const here = dirname(fileURLToPath(import.meta.url));
    return dedupePaths([
        process.env.MAVIS_BUILTIN_SKILLS_DIR,
        resolve(here, '../../../../assets/skills'),
        resolve(here, 'assets/skills'),
        resolve(process.cwd(), 'packages/local-runtime-v2/assets/skills'),
        resolve(process.cwd(), 'node_modules/@mavis/local-runtime-v2/assets/skills'),
    ]);
}
export function getBuiltinAgentsDirCandidates() {
    const here = dirname(fileURLToPath(import.meta.url));
    return dedupePaths([
        process.env.MAVIS_BUILTIN_AGENTS_DIR,
        resolve(here, '../../../../assets/agents'),
        resolve(here, 'assets/agents'),
        resolve(process.cwd(), 'packages/local-runtime-v2/assets/agents'),
        resolve(process.cwd(), 'assets/agents'),
    ]);
}
function dedupePaths(paths) {
    return [...new Set(paths.filter((path) => Boolean(path)))];
}
export async function isDirectory(path) {
    try {
        await access(path);
        const entries = await readdir(path, { withFileTypes: true });
        return entries.some((entry) => entry.isDirectory());
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=locations.js.map