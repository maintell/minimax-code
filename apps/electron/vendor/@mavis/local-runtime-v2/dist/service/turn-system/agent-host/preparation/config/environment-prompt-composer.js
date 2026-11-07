import { getRuntimeRegion } from '@mavis/config';
import { ENVIRONMENT_RULES } from '../prompt-blocks.js';
import { resolveRuntimeLocale } from '../static-prompt-reader.js';
/** Project folders are read per Turn, so folder edits apply from the next Turn. */
export class AdditionalWorkspaceRootsBinding {
    read;
    bind = (read) => {
        this.read = read;
    };
    async scope(input) {
        const additionalWorkspaceRoots = await this.read?.(input.session.sessionId);
        return additionalWorkspaceRoots?.length ? { ...input, additionalWorkspaceRoots } : input;
    }
}
export function environmentContextBlock(scope) {
    const { config, workspaceDir, environment, modelId, isGitRepository } = scope;
    return [
        '# Environment',
        'You have been invoked in the following environment:',
        `- Primary working directory: ${workspaceDir}`,
        ...additionalWorkspaceLines(workspaceDir, scope.additionalWorkspaceRoots),
        `- Is a git repository: ${isGitRepository ?? 'unavailable'}`,
        `- Platform: ${environment?.platform ?? process.platform}`,
        `- Shell: ${environment?.shell ?? 'unavailable'}`,
        `- OS Version: ${environment?.osVersion ?? 'unavailable'}`,
        `- Model: ${modelId}`,
        `- appLocale: ${resolveRuntimeLocale()}`,
        `- region: ${getRuntimeRegion()}`,
        `- activeDataDir: ${config.dataDir}`,
        '',
        ENVIRONMENT_RULES,
    ].join('\n');
}
function additionalWorkspaceLines(workspaceDir, roots) {
    const additional = (roots ?? []).filter((root) => root !== workspaceDir);
    if (additional.length === 0)
        return [];
    return [
        '- Additional project folders:',
        ...additional.map((root) => `  - ${root}`),
        '- Relative paths and default commands use the primary working directory. Use absolute paths for additional project folders, and search the folders relevant to the task before asking to look elsewhere.',
        '- Additional project folders do not provide global instructions, Hooks or Skills. Read directory-local instructions when working in one and apply them only to that folder.',
    ];
}
//# sourceMappingURL=environment-prompt-composer.js.map