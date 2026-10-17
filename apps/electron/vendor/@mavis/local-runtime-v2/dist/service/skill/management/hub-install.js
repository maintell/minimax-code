import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const USER_GLOBAL_SCOPE = 2;
const USER_AGENT_SCOPE = 1;
const HUB_GLOBAL_SOURCE_KIND = 'skill-hub-local';
const USER_AGENT_SOURCE_KIND = 'agent-user';
export async function writeInstalledSkill(input) {
    const dir = input.agentName
        ? join(input.dataDir, 'agents', input.agentName, 'skills', input.item.name)
        : join(input.dataDir, 'skills', input.item.name);
    const location = join(dir, 'SKILL.md');
    if (input.files?.length) {
        await rm(dir, { recursive: true, force: true });
        await Promise.all(input.files.map(async (file) => {
            const safePath = normalizeInstallFilePath(file.path);
            if (!safePath)
                return;
            const target = join(dir, safePath);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, file.content);
        }));
    }
    await mkdir(dir, { recursive: true });
    await writeFile(location, input.item.content, 'utf8');
    return {
        name: input.item.name,
        description: input.item.description,
        display_name: input.item.display_name,
        scope: input.agentName ? USER_AGENT_SCOPE : USER_GLOBAL_SCOPE,
        location,
        source_type: input.sourceType,
        source_kind: input.agentName ? USER_AGENT_SOURCE_KIND : HUB_GLOBAL_SOURCE_KIND,
        ...(input.agentName ? { agent_name: input.agentName } : {}),
    };
}
function normalizeInstallFilePath(value) {
    const parts = value.split(/[\\/]+/u).filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..'))
        return undefined;
    return parts.join('/');
}
//# sourceMappingURL=hub-install.js.map