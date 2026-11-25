import { getRuntimeRegion } from '@mavis/config';
import { agentShellInstructions, } from '@mavis/harness';
import { ENVIRONMENT_RULES } from './desktop-prompt-rules.js';
import { resolveRuntimeLocale } from './static-prompt-reader.js';
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
const PENDING_AGENT_SHELL = 'pending background discovery. Continue conversation and use non-shell tools without waiting. Do not assume Bash or PowerShell syntax. The first bash call waits for discovery before permissions and returns shell instructions without executing a command. Rewrite the command for that resolved shell in a new tool-call batch before retrying. If discovery fails, non-shell tools remain available.';
/** Collects the desktop `# Environment` entries and rules; the harness adds the heading. */
export async function collectPromptEnvironment(sources) {
    const isGitRepository = await probeGitRepository(sources);
    const environment = withAgentShell(sources);
    const { workspaceDir } = sources;
    return {
        entries: [
            'Session environment details:',
            `- Primary working directory: ${workspaceDir}`,
            ...additionalWorkspaceLines(workspaceDir, sources.additionalWorkspaceRoots),
            `- Is a git repository: ${isGitRepository ?? 'unavailable'}`,
            ...hostEnvironmentLines(environment),
            `- Model: ${sources.modelId}`,
            `- appLocale: ${resolveRuntimeLocale()}`,
            `- region: ${getRuntimeRegion()}`,
            `- activeDataDir: ${sources.config.dataDir}`,
        ],
        rules: [ENVIRONMENT_RULES],
    };
}
/** A failed probe renders `unavailable`; the platform falls back to the Host process. */
function hostEnvironmentLines(environment) {
    return [
        `- Platform: ${environment?.platform ?? process.platform}`,
        `- Shell: ${environment?.shell ?? 'unavailable'}`,
        `- OS Version: ${environment?.osVersion ?? 'unavailable'}`,
    ];
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
async function probeGitRepository(sources) {
    try {
        return await sources.probes.isGitRepository?.(sources.workspaceDir);
    }
    catch {
        return undefined;
    }
}
/** A resolved Windows Agent shell replaces the Host shell; discovery in flight says so. */
function withAgentShell(sources) {
    const environment = sources.probes.environment?.();
    const shell = sources.agentShell;
    if (shell) {
        return {
            platform: 'win32',
            osVersion: environment?.osVersion ?? 'Windows',
            shell: `${shell.family} (${shell.executablePath})\n${agentShellInstructions(shell)}`,
        };
    }
    if (sources.agentShellDiscovery && environment?.platform === 'win32') {
        return { ...environment, shell: PENDING_AGENT_SHELL };
    }
    return environment;
}
//# sourceMappingURL=environment-prompt-facts.js.map