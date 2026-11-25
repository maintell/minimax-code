import { createLocalBashToolDefinition, resolveLocalBashShell } from '@mavis/agent-tools/desktop';
/**
 * Desktop Bash guidance for a new Turn (`HostToolProvider.prepareBashTools`):
 * rewrites the native `bash` definition for the Session shell (pending on
 * Windows until a Shell binding exists), background output and deletion
 * guidance. Configured or MCP namesakes and other tools are returned unchanged.
 */
export function prepareDesktopBashTools(admittedTools, background, nativeDelete = false, agentShell) {
    const hasNativeBash = admittedTools.some((tool) => tool.def.name === 'bash' && (tool.source === undefined || tool.source === 'builtin'));
    const unboundShell = process.platform === 'win32' ? 'pending' : undefined;
    const sessionShell = agentShell
        ? { 'git-bash': 'bash', 'windows-powershell': 'powershell', pwsh: 'pwsh' }[agentShell.family]
        : unboundShell;
    const bashCapabilities = {
        background,
        shell: hasNativeBash ? (sessionShell ?? resolveLocalBashShell()) : 'unavailable',
        nativeDelete,
    };
    return admittedTools.map((tool) => {
        if (tool.def.name !== 'bash' || (tool.source !== undefined && tool.source !== 'builtin'))
            return tool;
        const definition = createLocalBashToolDefinition(bashCapabilities);
        return {
            ...tool,
            def: { ...tool.def, schema: definition.schema, description: definition.description },
        };
    });
}
//# sourceMappingURL=desktop-bash-tools.js.map