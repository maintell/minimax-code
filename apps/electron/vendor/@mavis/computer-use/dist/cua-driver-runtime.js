import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CUA_VERSION } from './component.js';
import { ComputerUseError, record } from './contracts.js';
/** Preserve native ESM import in Electron CommonJS bundles without eager SDK loading. */
function importEsm(specifier) {
    // eslint-disable-next-line no-new-func -- ESM-only optional native SDK.
    return new Function('specifier', 'return import(specifier)')(specifier);
}
/** Retained export for Desktop's ASAR resolver and its focused regression tests. */
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
export async function createCuaDriverRuntime(input) {
    if (!['darwin', 'win32'].includes(process.platform))
        throw new ComputerUseError('computer_platform_unsupported', 'Computer Use is unavailable on this OS.');
    if (!input.endpoint)
        throw new ComputerUseError('computer_endpoint_required', 'An owned explicit endpoint is required.');
    const specifier = input.sdkRuntimeDirectory
        ? cuaDriverModuleSpecifier(input.sdkRuntimeDirectory)
        : '@trycua/cua-driver';
    const { CuaDriver } = await importEsm(specifier);
    const driver = CuaDriver.connect(input.endpoint);
    let supportsSessionTitle = false;
    try {
        const metadata = await driver.metadata();
        if (metadata.driverVersion !== CUA_VERSION ||
            metadata.contractVersion !== '0.8.0' ||
            metadata.pid !== input.pid) {
            throw new ComputerUseError('computer_component_version_mismatch', 'SDK connection metadata does not match the owned 0.34.1 daemon.');
        }
        supportsSessionTitle = await discoverSessionTitleSupport(driver);
    }
    catch (error) {
        driver.uniffiDestroy?.();
        throw error;
    }
    let closed = false;
    return {
        generation: input.generation,
        driverVersion: CUA_VERSION,
        async callTool(name, args, signal, sessionTitle) {
            if (closed)
                throw new ComputerUseError('computer_closed', 'Driver connection is closed.');
            return callCuaToolInSession(driver, name, args, signal, {
                supportsSessionTitle,
                sessionTitle,
            });
        },
        async shutdown() {
            if (closed)
                return;
            closed = true;
            try {
                await driver.shutdown();
            }
            finally {
                driver.uniffiDestroy?.();
            }
        },
    };
}
/**
 * Optional presentation capability; older official/branded components remain usable.
 * The daemon inventory rebuilds entries without `_meta`, so the advertised
 * `session_title` property (rejected by strict schemas of older components) also counts.
 */
export async function discoverSessionTitleSupport(driver) {
    try {
        const listed = JSON.parse(await driver.listToolsJson());
        const tools = Array.isArray(listed) ? listed : record(listed)?.tools;
        return (Array.isArray(tools) &&
            tools.some((entry) => {
                const tool = record(entry);
                if (tool?.name !== 'start_session')
                    return false;
                if (record(tool._meta)?.['com.minimax/session-title'] === 1)
                    return true;
                const schema = record(tool.input_schema) ?? record(tool.inputSchema);
                return record(record(schema?.properties)?.session_title)?.type === 'string';
            }));
    }
    catch {
        return false;
    }
}
/** Local cancellation after all preceding native calls settled; the requested tool was not sent. */
export class CuaLocalAbortError extends ComputerUseError {
    constructor() {
        super('computer_aborted', 'Tool was cancelled locally before dispatch.', 'not_started');
    }
}
/** Start is idempotent. Input is sent exactly once; no SDK cancellation/reconnect/replay. */
export async function callCuaToolInSession(driver, name, args, signal, display) {
    if (typeof args.session !== 'string' || !args.session.trim()) {
        throw new Error('computer_session_required: a conversation session is required');
    }
    if (signal?.aborted)
        throw new CuaLocalAbortError();
    // Never accept display metadata from model-owned tool arguments.
    const nativeArgs = { ...args };
    delete nativeArgs.session_title;
    const title = typeof display?.sessionTitle === 'string'
        ? Array.from(display.sessionTitle
            .replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
            .replace(/\s+/gu, ' ')
            .trim())
            .slice(0, 256)
            .join('')
        : '';
    const label = display?.supportsSessionTitle ? { session_title: title || args.session } : {};
    if (name !== 'end_session' && name !== 'check_permissions') {
        Object.assign(nativeArgs, label);
        const started = await driver.callTool('start_session', JSON.stringify({ session: args.session, ...label }));
        if (record(started)?.isError)
            return started;
        if (signal?.aborted)
            throw new CuaLocalAbortError();
    }
    // AbortSignal is intentionally not passed into UniFFI: its rejected wait is not proof of native drain.
    return driver.callTool(name, JSON.stringify(name === 'check_permissions' ? { prompt: false, probe_direct_capture: false } : nativeArgs));
}
//# sourceMappingURL=cua-driver-runtime.js.map