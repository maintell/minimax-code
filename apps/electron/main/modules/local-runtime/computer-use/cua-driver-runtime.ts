import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCuaStructuredLogger } from "./cua-logging";
/**
 * Electron main/utility bundles are emitted as CommonJS. TypeScript lowers a
 * normal `import()` expression to `require()` in that mode, but the CUA SDK is
 * ESM-only (`exports.import` without a CommonJS condition). Keep the native
 * dynamic import intact at runtime so Node resolves the package through its
 * ESM exports map.
 */
function importEsm(specifier) {
    // eslint-disable-next-line no-new-func -- Preserve native import in CJS output.
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    return dynamicImport(specifier);
}
/** Native SDK dlopen bypasses Electron's ASAR filesystem redirection. */
export function cuaDriverModuleSpecifier(runtimeDirectory) {
    let directory = runtimeDirectory;
    while (path.dirname(directory) !== directory) {
        if (path.basename(directory) === 'app.asar') {
            return pathToFileURL(path.join(`${directory}.unpacked`, 'node_modules', '@trycua', 'cua-driver', 'dist', 'index.js')).href;
        }
        directory = path.dirname(directory);
    }
    return '@trycua/cua-driver';
}
/** Owns exactly one direct SDK runtime inside the sibling CUA utility. */
export async function createCuaDriverRuntime(input) {
    const logger = input.logger ?? createCuaStructuredLogger();
    logger.info('utility_spawn', { generation: input.generation, phase: 'sdk_create_start' });
    const { CuaDriver } = await importEsm(cuaDriverModuleSpecifier(__dirname));
    const driver = CuaDriver.create(undefined);
    const metadata = await driver.metadata();
    logger.info('utility_ready', {
        generation: input.generation,
        phase: 'sdk_create_done',
        driverVersion: metadata.driverVersion,
        sdkSource: 'upstream-package',
    });
    return {
        generation: input.generation,
        driverVersion: metadata.driverVersion,
        async callTool(name, args, signal) {
            const started = Date.now();
            logger.info('request_start', { generation: input.generation, tool: name });
            try {
                const result = await callCuaToolInSession(driver, name, args, signal);
                logger.info('request_end', {
                    generation: input.generation,
                    tool: name,
                    outcome: 'returned',
                    durationMs: Date.now() - started,
                });
                return result;
            }
            catch (error) {
                logger.error('request_end', {
                    generation: input.generation,
                    tool: name,
                    outcome: 'failed',
                    durationMs: Date.now() - started,
                    errorCode: error instanceof Error ? error.name : 'unknown',
                    errorMessage: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
                });
                throw error;
            }
        },
        async shutdown() {
            logger.info('utility_exit', { generation: input.generation, phase: 'shutdown_start' });
            try {
                await driver.shutdown();
            }
            finally {
                driver.uniffiDestroy?.();
                logger.info('utility_exit', { generation: input.generation, phase: 'shutdown_done' });
            }
        },
    };
}
/** Refresh or revive the named conversation before dispatch; never replay input actions. */
export async function callCuaToolInSession(driver, name, args, signal) {
    if (typeof args.session !== 'string' || !args.session.trim()) {
        throw new Error('computer_session_required: a conversation session is required');
    }
    signal?.throwIfAborted();
    const options = signal ? { signal } : undefined;
    // Native start_session is idempotent, including for an idle-expired named session.
    // This runs only after product authorization has admitted the tool request.
    const started = await driver.callTool('start_session', JSON.stringify({ session: args.session }), options);
    if (started.isError)
        return started;
    signal?.throwIfAborted();
    return driver.callTool(name, JSON.stringify(args), options);
}
