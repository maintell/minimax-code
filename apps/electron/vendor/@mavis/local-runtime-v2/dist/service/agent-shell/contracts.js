export function parseAgentShellPreference(value) {
    if (value === 'auto' || value === 'powershell' || value === 'git-bash')
        return value;
    throw new Error('AGENT_SHELL_CONFIG_INVALID: unknown shell preference');
}
export function selectAgentShell(preference, candidates) {
    const orders = {
        auto: ['pwsh', 'windows-powershell', 'git-bash'],
        powershell: ['pwsh', 'windows-powershell'],
        'git-bash': ['git-bash'],
    };
    const order = orders[preference];
    return order
        .flatMap((family) => candidates.filter((item) => item.family === family))
        .find((item) => item.available && item.executablePath && item.version);
}
//# sourceMappingURL=contracts.js.map