function loadRuntimeFetchDevToolsLoader() {
    const { RuntimeFetchDevToolsExtension } = require('@mavis/electron-runtime-fetch-devtools/main');
    return RuntimeFetchDevToolsExtension;
}
async function initializeRuntimeFetchDevTools(electronSession, logger, loader) {
    try {
        const runtimeFetchDevToolsLoader = loader ?? loadRuntimeFetchDevToolsLoader();
        await runtimeFetchDevToolsLoader.load(electronSession.defaultSession, {
            warn: (message) => logger.warn(message),
        });
    }
    catch (error) {
        logger.warn('[RuntimeFetchDevTools] Failed to initialize extension', error);
    }
}
export function createRuntimeFetchDevToolsInitializer(electronSession, logger, loader) {
    let initialization;
    return () => {
        initialization ?? (initialization = initializeRuntimeFetchDevTools(electronSession, logger, loader));
        return initialization;
    };
}
