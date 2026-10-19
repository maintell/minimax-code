import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_SKILLS_CONFIG, } from '@mavis/config';
import { getBuiltinAgentsDirCandidates, getBuiltinSkillsDirCandidates } from '../assets/builtin.js';
const DEFAULT_LOCAL_AGENT_NAME = 'mavis';
const BUILTIN_SKILLS_DIR_NAME = '.builtin-skills';
export function resolveBuiltinSkillsDir(config) {
    return config.builtinSkillsDir ?? join(config.dataDir, BUILTIN_SKILLS_DIR_NAME);
}
export function readConfiguredSkillRoots(config, agentName = DEFAULT_LOCAL_AGENT_NAME, workspaceDir, compatibleAgentNames) {
    const primaryAgent = agentName.trim() || DEFAULT_LOCAL_AGENT_NAME;
    const agentNames = [primaryAgent, ...(compatibleAgentNames ?? [])]
        .map((name) => name.trim())
        .filter((name, index, names) => name.length > 0 && names.indexOf(name) === index);
    const workspaceRoot = workspaceDir?.trim();
    return dedupeSkillRoots([
        ...readExternalWorkspaceSkillRoots(config, workspaceRoot),
        ...readExternalUserSkillRoots(config),
        ...agentNames.map((sourceAgent, index) => ({
            id: `agent-user:${sourceAgent}`,
            kind: 'agent',
            scope: sourceAgent,
            rootPath: join(config.dataDir, 'agents', sourceAgent, 'skills'),
            // Canonical agent-user roots win over compatible legacy roots. Legacy
            // roots deliberately share one priority so the generic registry cannot
            // silently make one legacy path authoritative.
            priority: index === 0 ? 100 : 90,
        })),
        { id: 'user-global', kind: 'global', rootPath: join(config.dataDir, 'skills') },
        {
            // Startup seeds bundled builtin skills here; keeping the asset-pointing
            // roots below as a fallback for dev/monorepo layouts that skip seeding.
            id: `builtin-seeded:${resolveBuiltinSkillsDir(config)}`,
            kind: 'builtin',
            rootPath: resolveBuiltinSkillsDir(config),
            priority: 20,
        },
        ...getBuiltinAgentsDirCandidates().map((agentsDir) => ({
            id: `builtin-agent:${primaryAgent}:${agentsDir}`,
            kind: 'builtin',
            scope: primaryAgent,
            rootPath: join(agentsDir, primaryAgent, 'skills'),
            priority: 10,
        })),
        ...getBuiltinSkillsDirCandidates().map((rootPath) => ({
            id: `builtin-global:${rootPath}`,
            kind: 'builtin',
            rootPath,
        })),
    ]);
}
function readExternalWorkspaceSkillRoots(config, workspaceRoot) {
    if (!workspaceRoot)
        return [];
    const skillsConfig = config.skills ?? DEFAULT_SKILLS_CONFIG;
    const external = skillsConfig.external;
    if (!external.enabled)
        return [];
    const roots = workspaceRootsToScan(workspaceRoot, external.walkUp);
    const rootCount = roots.length;
    return roots.flatMap((rootPath, index) => {
        const nearestPriorityBonus = (rootCount - index) / 1000;
        return [
            externalSkillRoot('workspace-minimax', join(rootPath, '.minimax', 'skills'), 'workspace', {
                skillsConfig,
                priorityBonus: nearestPriorityBonus,
            }),
            externalSkillRoot('workspace-cc', join(rootPath, '.claude', 'skills'), 'workspace', {
                skillsConfig,
                priorityBonus: nearestPriorityBonus,
            }),
            externalSkillRoot('workspace-agents', join(rootPath, '.agents', 'skills'), 'workspace', {
                skillsConfig,
                priorityBonus: nearestPriorityBonus,
            }),
        ].filter((root) => root !== undefined);
    });
}
function readExternalUserSkillRoots(config) {
    const skillsConfig = config.skills ?? DEFAULT_SKILLS_CONFIG;
    const external = skillsConfig.external;
    if (!external.enabled)
        return [];
    return [
        externalSkillRoot('user-cc', join(homedir(), '.claude', 'skills'), 'user', { skillsConfig }),
        externalSkillRoot('user-codex', join(homedir(), '.codex', 'skills'), 'user', { skillsConfig }),
        externalSkillRoot('user-agents', join(homedir(), '.agents', 'skills'), 'user', {
            skillsConfig,
        }),
    ].filter((root) => root !== undefined);
}
function externalSkillRoot(source, rootPath, kind, options) {
    const { skillsConfig, priorityBonus = 0 } = options;
    const sourceConfig = skillsConfig.external.sources[source];
    if (!sourceConfig.enabled)
        return undefined;
    return {
        id: `external:${source}:${rootPath}`,
        kind,
        rootPath,
        priority: sourceConfig.priority + priorityBonus,
        external: true,
        allowDirectorySymlinksOutsideRoot: true,
    };
}
function workspaceRootsToScan(workspaceRoot, walkUp) {
    const start = resolve(workspaceRoot);
    if (!walkUp)
        return [start];
    const roots = [];
    let current = start;
    while (current) {
        roots.push(current);
        if (existsSync(join(current, '.git'))) {
            return roots;
        }
        const parent = dirname(current);
        current = parent === current ? undefined : parent;
    }
    return [start];
}
function dedupeSkillRoots(roots) {
    const seen = new Set();
    return roots.filter((root) => {
        const key = `${root.kind}\0${resolve(root.rootPath)}\0${root.scope ?? ''}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
//# sourceMappingURL=roots.js.map