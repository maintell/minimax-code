import { installMcodeToolsLauncher, removeMcodeToolsLaunchers, validateMcodeToolsResource, } from './resource.js';
import { startMcodeToolsAuthLeaseBroker } from './lease-broker.js';
const DEFAULT_DEPENDENCIES = {
    validateResource: validateMcodeToolsResource,
    startBroker: startMcodeToolsAuthLeaseBroker,
    installLauncher: installMcodeToolsLauncher,
    removeLaunchers: removeMcodeToolsLaunchers,
};
export async function startMcodeToolsHostIntegration(options, dependencies = DEFAULT_DEPENDENCIES) {
    const resource = dependencies.validateResource({
        resourceDir: options.resourceDir,
        expectedBuildEnv: options.expectedBuildEnv,
    });
    const broker = await dependencies.startBroker({
        dataDir: options.dataDir,
        session: options.session,
        ...(options.logger ? { logger: options.logger } : {}),
    });
    try {
        const installed = await dependencies.installLauncher({
            resourceDir: options.resourceDir,
            expectedBuildEnv: options.expectedBuildEnv,
            dataDir: options.dataDir,
            executable: options.executable,
            platform: options.platform,
            region: options.region,
            ...(options.bedrockLane ? { bedrockLane: options.bedrockLane } : {}),
            brokerEndpoint: broker.endpoint,
            brokerCapabilityFile: broker.capabilityFile,
        });
        return activeIntegration(options, dependencies, broker, installed.launcherPath, resource);
    }
    catch (error) {
        let cleanupError;
        try {
            dependencies.removeLaunchers(options.dataDir, options.region);
        }
        catch (cause) {
            cleanupError = cause;
        }
        try {
            await broker.dispose();
        }
        catch (cause) {
            cleanupError = cleanupError
                ? new AggregateError([cleanupError, cause], 'mcode-tools startup cleanup failed')
                : cause;
        }
        if (cleanupError) {
            throw new AggregateError([error, cleanupError], 'mcode-tools host integration failed');
        }
        throw error;
    }
}
function activeIntegration(options, dependencies, broker, launcherPath, resource) {
    let disposed = false;
    return {
        launcherPath,
        brokerEndpoint: broker.endpoint,
        packageName: resource.manifest.packageName,
        version: resource.manifest.version,
        async dispose() {
            if (disposed)
                return;
            disposed = true;
            let launcherError;
            try {
                dependencies.removeLaunchers(options.dataDir, options.region);
            }
            catch (error) {
                launcherError = error;
            }
            try {
                await broker.dispose();
            }
            catch (error) {
                if (launcherError) {
                    throw new AggregateError([launcherError, error], 'mcode-tools cleanup failed');
                }
                throw error;
            }
            if (launcherError)
                throw launcherError;
        },
    };
}
//# sourceMappingURL=integration.js.map