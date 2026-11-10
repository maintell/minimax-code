/**
 * website_deploy 的本地上传/发布实现：过滤并打包构建目录，再串行上传 site/source 双归档。
 * source.zip 只保存在私有存储；带 nodeId 时更新原站并保留 URL。
 * gateway 使用 managed access token 注入身份，本地仅传 sessionId 作审计锚点。
 */
import { lstat, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { logger } from '../../../infra/logging/logger.js';
import { LocalMatrixClient } from '../../matrix/index.js';
import { DEFAULT_IGNORE_PATTERNS, sanitizeStem, totalBytes, uploadArchive, walkDeployableFiles, } from './archive-upload.js';
import { materializeWebsiteCover } from './cover-materializer.js';
import { deployFailure, ensureNotAborted, runDeployStage } from './deploy-failure.js';
import { FreshAuthWebsiteDeployGateway } from './gateway-auth.js';
import { publishFailureLogFields, readPublishFailure, readPublishSuccess, } from './publish-response.js';
const PUBLISH_ARCHIVE_PATH = '/mavis/api/v1/drive/websites/publish_archive';
const UPDATE_ARCHIVE_PATH = '/mavis/api/v1/drive/websites/update_archive';
const DEFAULT_UPLOAD_TIMEOUT_MS = 1_500_000;
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export class LocalWebsiteDeployClient {
    gateway;
    maxTotalBytes;
    ignorePatterns;
    uploadTimeoutMs;
    dataDir;
    fetchImpl;
    constructor(options = {}) {
        this.gateway = buildDeployGateway(options);
        this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
        this.ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;
        this.uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
        this.dataDir = options.dataDir;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    }
    async deploy(input, signal) {
        ensureNotAborted(signal, 'before upload', 'validate_site');
        if (input.nodeId !== undefined && input.sourceDir === undefined) {
            throw deployFailure('website_deploy update requires a source directory.', 'validation_failed', 'validate_site');
        }
        const site = await this.prepareSite(input, signal);
        // source.zip 始终在 site.zip 上传完成后处理。
        const source = input.sourceDir === undefined
            ? undefined
            : await this.prepareSource({
                sourceDir: input.sourceDir,
                siteDir: input.dir,
                siteFiles: site.entries,
                siteOssKey: site.upload.ossKey,
            }, signal);
        const archiveOperation = input.nodeId !== undefined ? 'update_archive' : 'publish_archive';
        const archivePath = input.nodeId !== undefined ? UPDATE_ARCHIVE_PATH : PUBLISH_ARCHIVE_PATH;
        const stats = {
            source_present: input.sourceDir !== undefined,
            bytes: site.bytes + (source?.bytes ?? 0),
            files: site.files + (source?.files ?? 0),
        };
        ensureNotAborted(signal, `before ${archiveOperation}`, archiveOperation);
        logStage(archiveOperation, 'started', stats);
        const published = await runDeployStage(archiveOperation, signal, () => this.gateway.postGatewayJson(archivePath, buildPublishRequest(input, site.upload, source?.upload), signal, this.uploadTimeoutMs));
        const failure = readPublishFailure(published);
        if (failure) {
            logStage(archiveOperation, 'failed', {
                ...stats,
                ...publishFailureLogFields(published, failure),
            });
            return failure;
        }
        const success = readPublishSuccess(published, input.nodeId);
        logStage('complete', 'ok', stats);
        return this.materializeSuccess(input, success, signal);
    }
    async prepareSite(input, signal) {
        const entries = await runDeployStage('validate_site', signal, () => walkDeployableFiles(input.dir, this.ignorePatterns));
        if (entries.length === 0) {
            throw deployFailure(`Nothing to deploy: '${input.dir}' has no files after filtering.`, 'validation_failed', 'validate_site');
        }
        const bytes = totalBytes(entries);
        if (bytes > this.maxTotalBytes) {
            throw deployFailure(`Directory total size ${bytes} bytes exceeds the ${this.maxTotalBytes}-byte deploy ` +
                `limit. Trim build output or move large assets out before deploying.`, 'validation_failed', 'validate_site');
        }
        const stats = { source_present: input.sourceDir !== undefined, bytes, files: entries.length };
        logStage('validate_site', 'ok', stats);
        const upload = await uploadArchive({
            files: entries,
            archiveName: `${sanitizeStem(basename(input.dir)) || 'website'}.zip`,
            gateway: this.gateway,
            signal,
            timeoutMs: this.uploadTimeoutMs,
            source: false,
        });
        logStage('upload_site', 'ok', stats);
        return { entries, upload, bytes, files: entries.length };
    }
    async prepareSource(input, signal) {
        const sourceRootStat = await runDeployStage('validate_source', signal, () => lstat(input.sourceDir));
        if (!sourceRootStat.isDirectory()) {
            throw deployFailure('website_deploy source directory must be a regular directory.', 'validation_failed', 'validate_source');
        }
        ensureNotAborted(signal, 'before source validation', 'validate_source');
        const [siteRoot, sourceRoot] = await runDeployStage('validate_source', signal, () => Promise.all([realpath(input.siteDir), realpath(input.sourceDir)]));
        const entries = siteRoot === sourceRoot
            ? input.siteFiles
            : await runDeployStage('validate_source', signal, () => walkDeployableFiles(input.sourceDir, this.ignorePatterns, input.siteDir));
        if (entries.length === 0) {
            throw deployFailure('Nothing to archive: source directory has no files after filtering.', 'validation_failed', 'validate_source');
        }
        const bytes = totalBytes(entries);
        if (bytes > this.maxTotalBytes) {
            throw deployFailure(`Source directory total size ${bytes} bytes exceeds the ${this.maxTotalBytes}-byte ` +
                `source archive limit. Trim source files before deploying.`, 'validation_failed', 'validate_source');
        }
        const stats = { source_present: true, bytes, files: entries.length };
        logStage('validate_source', 'ok', stats);
        const upload = await uploadArchive({
            files: entries,
            archiveName: `${sanitizeStem(basename(input.sourceDir)) || 'website'}-source.zip`,
            gateway: this.gateway,
            signal,
            timeoutMs: this.uploadTimeoutMs,
            source: true,
            differentFromOssKey: input.siteOssKey,
        });
        logStage('upload_source', 'ok', stats);
        return { upload, bytes, files: entries.length };
    }
    async materializeSuccess(input, success, signal) {
        const { cdnUrl, nodeId, screenshotUrl } = success;
        // 封面获取仅为发布成功后的 best-effort，不将成功改写成可重试失败。
        const coverPath = await materializeWebsiteCover({
            screenshotUrl,
            nodeId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            dataDir: this.dataDir,
            fetchImpl: this.fetchImpl,
            signal,
        });
        return {
            ...(cdnUrl ? { cdn_url: cdnUrl } : {}),
            ...(nodeId ? { node_id: nodeId } : {}),
            ...(coverPath ? { cover_path: coverPath } : {}),
        };
    }
}
/**
 * 客户端在 Turn 开始时创建，部署可能晚于 token 刷新；有宿主实时身份时每次请求现取，
 * 并处理登录变化与一次性 401 恢复（原因见 gateway-auth.ts）。
 */
function buildDeployGateway(options) {
    const gateway = options.gateway ??
        new LocalMatrixClient({
            ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
            ...(options.authContext ? { authContext: options.authContext } : {}),
            ...(options.authContextGetter ? { authContextGetter: options.authContextGetter } : {}),
            routingContextGetter: options.routingContextGetter,
        });
    if (!options.authContextGetter)
        return gateway;
    return new FreshAuthWebsiteDeployGateway(gateway, {
        authContextGetter: options.authContextGetter,
        ...(options.authContextInvalidator
            ? { authContextInvalidator: options.authContextInvalidator }
            : {}),
    });
}
function buildPublishRequest(input, site, source) {
    return {
        ...(input.nodeId !== undefined ? { node_id: input.nodeId } : {}),
        oss_key: site.ossKey,
        ...(source ? { source_oss_key: source.ossKey } : {}),
        project_name: input.projectName,
        session_id: input.sessionId,
        ...(input.nodeId === undefined && input.watermark_enabled !== undefined
            ? { watermark_enabled: input.watermark_enabled }
            : {}),
    };
}
function logStage(stage, result, fields) {
    logger.info({ stage, result, ...fields }, 'website deploy stage');
}
//# sourceMappingURL=local-website-deploy-client.js.map