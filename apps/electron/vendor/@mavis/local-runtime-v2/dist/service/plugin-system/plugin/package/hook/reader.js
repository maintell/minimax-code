import { parsePluginHookDocuments, } from '@mavis/plugin-hooks';
import { projectPluginHookDiagnostics } from './diagnostics.js';
import { loadPluginHookDocuments } from './documents.js';
export async function readPluginHooks(root, input) {
    const documents = await loadPluginHookDocuments(root, input.declared, {
        ...(input.defaultPath ? { defaultPath: input.defaultPath } : {}),
        ...(input.manifestPath ? { manifestPath: input.manifestPath } : {}),
    });
    const parsed = parsePluginHookDocuments({
        pluginName: input.pluginName,
        pluginRoot: root.path,
        sourceFormat: input.sourceFormat,
        documents,
    });
    return {
        hooks: parsed.handlers,
        diagnostics: projectPluginHookDiagnostics(parsed.diagnostics),
    };
}
//# sourceMappingURL=reader.js.map