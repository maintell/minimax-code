import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createExtensionDiagnostic } from '../sdk/diagnostics.js';
import { EXTENSION_DEV_SESSION_SEGMENT } from '@mavis/permission';
import { isMiniMaxPluginName } from '../../plugin-system/index.js';
import { ExtensionAuthoringError } from '../errors.js';
import { fixFor } from './fixes.js';
import { scaffoldExtensionPackage } from './scaffold.js';
import { runExtensionTests } from './testing/runner.js';
const MAX_TRACES = 20;
const MAX_DIAGNOSTICS = 50;
const CONSOLE_PREFIX = 'console.';
/** The `extension` agent tool: `init / preview / inspect / test / withdraw` (one.md §9, R10 #3). */
export class ExtensionAuthoringService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async init(request) {
        const packagePath = this.devDirectory(request.sessionId, request.pluginId);
        const result = await scaffoldExtensionPackage({
            directory: packagePath,
            pluginId: request.pluginId,
            title: request.title?.trim() || request.pluginId,
        });
        return { pluginId: request.pluginId, packagePath, ...result };
    }
    preview(request) {
        try {
            assertPluginId(request.pluginId);
        }
        catch (error) {
            return Promise.reject(error);
        }
        return this.deps.preview.requestPreview(request);
    }
    async withdraw(request) {
        assertPluginId(request.pluginId);
        if (await this.deps.preview.withdraw(request.sessionId, request.pluginId)) {
            return { withdrawn: true };
        }
        return {
            status: 'refused',
            diagnostic: createExtensionDiagnostic('EXTENSION_PREVIEW_NOT_ACTIVE', {
                detail: request.pluginId,
            }),
        };
    }
    async inspect(request) {
        const packagePath = this.devDirectory(request.sessionId, request.pluginId);
        const source = (await isDirectory(packagePath))
            ? await this.summarize(request.pluginId, packagePath)
            : undefined;
        const live = this.deps.preview.activation(request.sessionId, request.pluginId);
        const host = this.deps.host.inspect({
            sessionId: request.sessionId,
            pluginId: request.pluginId,
        });
        const consoleLines = host.diagnostics.filter((entry) => entry.code.startsWith(CONSOLE_PREFIX));
        const findings = host.diagnostics.filter((entry) => !entry.code.startsWith(CONSOLE_PREFIX));
        return {
            pluginId: request.pluginId,
            packagePath,
            ...(source ? { source } : {}),
            ...(live
                ? {
                    preview: {
                        artifactDigest: live.artifactDigest,
                        stale: source?.digest !== undefined && source.digest !== live.artifactDigest,
                        entries: live.scan.entries.map((entry) => entry.label),
                        bindings: live.scan.bindings.map(bindingLabel),
                        ...(live.overlayFindings ? { overlayFindings: live.overlayFindings } : {}),
                        ...(live.keptReload ? { keptReload: live.keptReload } : {}),
                        ...(live.editorTypesFinding ? { editorTypesFinding: live.editorTypesFinding } : {}),
                    },
                }
                : {}),
            runtime: {
                traces: host.traces.slice(-MAX_TRACES).map(({ sessionId: _session, ...trace }) => trace),
                diagnostics: findings.slice(-MAX_DIAGNOSTICS).map(runtimeDiagnostic),
                console: consoleLines.slice(-MAX_DIAGNOSTICS).map((entry) => ({
                    at: entry.at,
                    level: entry.code.slice(CONSOLE_PREFIX.length),
                    text: entry.message,
                })),
                disabledHooks: host.disabledHooks.map((hook) => hook.key),
                disabled: host.disabledPlugins.length > 0,
                isolation: host.isolation,
            },
        };
    }
    async test(request) {
        const sourceDir = await this.sourceDirectory(request);
        const validation = await this.deps.validate({ pluginId: request.pluginId, sourceDir });
        if (!validation.artifact) {
            return {
                status: 'invalid',
                errors: validation.errors,
                warnings: validation.warnings,
            };
        }
        const report = await runExtensionTests({
            artifact: validation.artifact,
            sites: this.deps.sites,
            workerFactory: this.deps.testWorker.factory,
            ...(this.deps.testWorker.limits ? { limits: this.deps.testWorker.limits } : {}),
            ...(request.signal ? { signal: request.signal } : {}),
        });
        return { status: 'ran', report, warnings: validation.warnings };
    }
    /** `<devRoot>/<sessionId>/<pluginId>/`, the same directory `preview` reads by default. */
    devDirectory(sessionId, pluginId) {
        if (!EXTENSION_DEV_SESSION_SEGMENT.test(sessionId)) {
            throw new ExtensionAuthoringError('SOURCE_PATH_INVALID', 'session id cannot name a directory');
        }
        assertPluginId(pluginId);
        return path.join(this.deps.devRoot, sessionId, pluginId);
    }
    async sourceDirectory(request) {
        assertPluginId(request.pluginId);
        if (request.sourcePath !== undefined && !path.isAbsolute(request.sourcePath)) {
            throw new ExtensionAuthoringError('SOURCE_PATH_INVALID', 'sourcePath must be absolute');
        }
        const directory = request.sourcePath ?? this.devDirectory(request.sessionId, request.pluginId);
        if (!(await isDirectory(directory))) {
            throw new ExtensionAuthoringError('PACKAGE_NOT_FOUND', `${directory} does not exist; run the init action first`);
        }
        return directory;
    }
    async summarize(pluginId, sourceDir) {
        const validation = await this.deps.validate({ pluginId, sourceDir });
        const diagnostics = [...validation.errors, ...validation.warnings];
        const scan = validation.artifact?.scan;
        if (!scan) {
            return { entries: [], bindings: [], hooks: [], calls: [], state: [], diagnostics };
        }
        return {
            digest: validation.artifact?.digest ?? (await this.deps.sourceDigest(sourceDir)),
            entries: scan.entries.map((entry) => entry.label),
            bindings: scan.bindings.map(bindingLabel),
            hooks: scan.hooks.map((hook) => hook.label),
            calls: scan.calls.map((call) => call.label),
            state: scan.state.map((field) => field.label),
            diagnostics,
        };
    }
}
/** The manifest name rule; an id that passes it names the package directory as it is. */
function assertPluginId(pluginId) {
    if (!isMiniMaxPluginName(pluginId)) {
        throw new ExtensionAuthoringError('SOURCE_PATH_INVALID', 'pluginId must be a plugin name like sprint-board');
    }
}
function bindingLabel(binding) {
    const fields = Object.entries(binding.matcher).map(([name, value]) => `${name}=${value}`);
    return `${binding.slot}{${fields.join(', ')}}`;
}
function runtimeDiagnostic(entry) {
    const fix = fixFor(entry.code);
    return {
        at: entry.at,
        code: entry.code,
        message: entry.message,
        ...(fix ? { fix } : {}),
        ...(entry.slot ? { slot: entry.slot } : {}),
        ...(entry.key ? { key: entry.key } : {}),
    };
}
async function isDirectory(directory) {
    try {
        return (await stat(directory)).isDirectory();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=authoring.service.js.map