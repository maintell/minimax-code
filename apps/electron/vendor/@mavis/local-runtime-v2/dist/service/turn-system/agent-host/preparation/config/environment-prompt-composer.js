import { getRuntimeRegion } from '@mavis/config';
import { ENVIRONMENT_RULES } from '../prompt-blocks.js';
import { resolveRuntimeLocale } from '../static-prompt-reader.js';
export function environmentContextBlock(scope) {
    const { config, workspaceDir, environment, modelId, isGitRepository } = scope;
    return [
        '# Environment',
        'You have been invoked in the following environment:',
        `- Primary working directory: ${workspaceDir}`,
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
//# sourceMappingURL=environment-prompt-composer.js.map