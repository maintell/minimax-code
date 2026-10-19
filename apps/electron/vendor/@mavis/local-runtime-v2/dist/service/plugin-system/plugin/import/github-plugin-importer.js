import { readImportedPluginPackage } from '../package/package-readers.js';
import { PluginPackageContractError } from '../package/package-contract.js';
import { PluginReaderError } from '../package/reader-errors.js';
import { PluginSystemError } from '../../errors.js';
import { downloadGithubPlugin, cloneGitRepositoryPlugin, } from './github-archive.js';
import { resolveGitRepositorySource, validateGithubPluginSource, validateGitRepositorySource, isGithubRepositoryUrl, } from './github-source.js';
export class GithubPluginImporter {
    options;
    constructor(options) {
        this.options = options;
    }
    async preview(url, signal) {
        try {
            const source = await resolveGitRepositorySource(url, {
                fetchImpl: this.options.fetchImpl,
                signal,
            });
            const extracted = await this.download(source, signal);
            try {
                return await this.readPreview(source, extracted);
            }
            finally {
                await extracted.discard();
            }
        }
        catch (error) {
            throw normalizeImportError(error);
        }
    }
    async prepare(sourceInput) {
        let extracted;
        try {
            const source = isGithubRepositoryUrl(sourceInput.repositoryUrl)
                ? validateGithubPluginSource(sourceInput)
                : validateGitRepositorySource(sourceInput);
            extracted = await this.download(source);
            const preview = await this.readPreview(source, extracted);
            return { ...preview, stagingRoot: extracted.rootPath, discard: extracted.discard };
        }
        catch (error) {
            await extracted?.discard();
            throw normalizeImportError(error);
        }
    }
    download(source, signal) {
        return isGithubRepositoryUrl(source.repositoryUrl)
            ? downloadGithubPlugin(this.options.dataDir, source, this.options.fetchImpl, signal)
            : cloneGitRepositoryPlugin(this.options.dataDir, source, signal);
    }
    async readPreview(source, extracted) {
        const plugin = await readImportedPluginPackage(extracted.rootPath, {
            dataDir: this.options.dataDir,
            createPluginData: false,
        });
        return {
            source,
            plugin,
            packageSizeBytes: extracted.packageSizeBytes,
            canImport: plugin.skills.length + plugin.mcpServers.length + (plugin.hooks?.length ?? 0) > 0,
        };
    }
}
function normalizeImportError(error) {
    if (error instanceof PluginSystemError)
        return error;
    if (error instanceof PluginReaderError || error instanceof PluginPackageContractError) {
        return new PluginSystemError(error.code, error.message);
    }
    return error;
}
//# sourceMappingURL=github-plugin-importer.js.map