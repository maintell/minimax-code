const TEST_UTILITY_BOOTSTRAP_TIMEOUT_MS = 30 * 60000;
/** Resolve the complete cold-start plan before the utility runtime host is created. */
export function resolveLocalRuntimeLaunchPlan(buildEnv, isolationBuildFlag) {
    if (buildEnv !== 'test' || isolationBuildFlag !== 'true') {
        return {
            dataDirMode: 'source',
            startupExecutionPolicy: 'enabled',
        };
    }
    return {
        dataDirMode: 'isolated-clone',
        startupExecutionPolicy: 'quarantined',
        utilityBootstrapTimeoutMs: TEST_UTILITY_BOOTSTRAP_TIMEOUT_MS,
    };
}
