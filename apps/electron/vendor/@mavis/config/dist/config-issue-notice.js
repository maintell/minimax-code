import { getConfig, getConfigPath, resetConfig } from './config.js';
import { acknowledgeConfigResetAt } from './config-file-state.js';
import { configIssuesLostKinds } from './config-issue-copy.js';
/**
 * Called by a host after it told the user that config.yaml's settings were
 * lost. Until then every reader keeps reporting it. Afterwards the current
 * file, generated defaults, empty or none, counts as a fresh start.
 */
export function acknowledgeConfigReset(configPath = getConfigPath(), shown = { missing: true }) {
    acknowledgeConfigResetAt(configPath, shown);
    // The cached Config still carries the notice; the next read must not repeat it.
    resetConfig();
}
/**
 * The profile config.yaml's problems for an interactive host (Desktop window,
 * TUI transcript). Call `acknowledge` after showing them: it marks lost settings
 * as told, and does nothing for problems that remain until the file is fixed.
 */
export function readProfileConfigNotice() {
    const configPath = getConfigPath();
    const issues = getConfig().configIssues;
    return {
        issues,
        configPath,
        acknowledge: () => {
            const shown = configIssuesLostKinds(issues);
            if (shown.missing || shown.empty)
                acknowledgeConfigReset(configPath, shown);
        },
    };
}
//# sourceMappingURL=config-issue-notice.js.map