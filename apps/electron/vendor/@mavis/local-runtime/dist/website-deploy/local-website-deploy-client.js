/**
 * LocalWebsiteDeployClient —— `website_deploy` 的 local 上传/发布委托实现
 * (实现 desktop `LocalWebsiteDeployAdapter`)。
 *
 * 方案 B: 1. walk + 过滤本机构建产物目录(排除 .env/.git/node_modules、symlink 不跟随、总大小硬上限);
 *   2. 打包 site.zip 与可选 source.zip 双归档(用已有依赖 `jszip`,不新增 tar 依赖);
 *   3. 复用 matrix gateway `get_upload_url` 为每份归档申请临时上传对象的
 *      presigned PUT,按 site → source 串行直传 —— 本地进程不持有 OSS AK/SK;
 *   4. 调后端实际端点:首次发布走 `publish_archive`;带 nodeId 的原站编辑走
 *      `update_archive`。两者复用 site.zip/source.zip,source.zip 只校验并以原始 ZIP
 *      私有保存,永不进入 stage/CDN。
 *
 * 路径选择:上传仍复用 managed matrix gateway 的 `/mavis/api/v1/mcp/get_upload_url` 申请临时上传对象;
 * 发布走 Drive website 业务入口 `/mavis/api/v1/drive/websites/publish_archive`。gateway 完成 Bearer access token 鉴权和
 * BaseReq 注入,再转发给 archon-server 的 `PublishWebsiteArchive`。
 *
 * 身份:userId/BizLine 由 gateway 从 managed access token 注入;local 只传 sessionId 作审计/归属锚点。
 *
 * 前置条件: archon-server `publish_archive` 端点已上线（独立 archon_server MR）。
 * 在端点可用前工具仍会在工具列表中显示，但调用会走后端报错；必要时可在运行时层
 * 再加可配置关保护，避免未配置环境中暴露半成品能力。
 */
import { lstat, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { logger } from '../common/logger.js';
import { LocalMatrixClient } from '../matrix/local-matrix-client.js';
import { DEFAULT_IGNORE_PATTERNS, sanitizeStem, totalBytes, uploadArchive, walkDeployableFiles, } from './archive-upload.js';
import { materializeWebsiteCover } from './cover-materializer.js';
import { deployFailure, ensureNotAborted, runDeployStage } from './deploy-failure.js';
/** Drive website 发布端点:archive oss_key → 解包 + 发布。 */
const PUBLISH_ARCHIVE_PATH = '/mavis/api/v1/drive/websites/publish_archive';
/** Drive website 原站更新端点:保留既有 node 与 URL,替换双归档内容。 */
const UPDATE_ARCHIVE_PATH = '/mavis/api/v1/drive/websites/update_archive';
// Mirrors IDL WebsiteManagementCode_CONTENT_REJECTED; non-zero base_resp always wins.
const CONTENT_REJECTED_CODE = 10;
const CONTENT_REJECTED_MESSAGE = '网站正文未通过审核，未发布';
const DEFAULT_UPLOAD_TIMEOUT_MS = 1_500_000;
/** 总字节硬上限(walk 后的文件总大小)。默认 200 MiB,与 cloud 对齐。 */
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export class LocalWebsiteDeployClient {
    gateway;
    maxTotalBytes;
    ignorePatterns;
    uploadTimeoutMs;
    dataDir;
    fetchImpl;
    constructor(options = {}) {
        this.gateway =
            options.gateway ??
                new LocalMatrixClient({
                    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
                    ...(options.authContext ? { authContext: options.authContext } : {}),
                    routingContextGetter: options.routingContextGetter,
                });
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
        // 1) walk + 过滤(symlink 不跟随)+ 大小上限。
        const siteFiles = await runDeployStage('validate_site', signal, () => walkDeployableFiles(input.dir, this.ignorePatterns));
        if (siteFiles.length === 0) {
            throw deployFailure(`Nothing to deploy: '${input.dir}' has no files after filtering.`, 'validation_failed', 'validate_site');
        }
        const siteBytes = totalBytes(siteFiles);
        if (siteBytes > this.maxTotalBytes) {
            throw deployFailure(`Directory total size ${siteBytes} bytes exceeds the ${this.maxTotalBytes}-byte deploy ` +
                `limit. Trim build output or move large assets out before deploying.`, 'validation_failed', 'validate_site');
        }
        const sourcePresent = input.sourceDir !== undefined;
        logStage('validate_site', 'ok', {
            source_present: sourcePresent,
            bytes: siteBytes,
            files: siteFiles.length,
        });
        // 2) site.zip:打包、获取 presigned PUT、上传；source.zip 只在这一步之后处理。
        const siteUpload = await uploadArchive({
            files: siteFiles,
            archiveName: `${sanitizeStem(basename(input.dir)) || 'website'}.zip`,
            gateway: this.gateway,
            signal,
            timeoutMs: this.uploadTimeoutMs,
            source: false,
        });
        logStage('upload_site', 'ok', {
            source_present: sourcePresent,
            bytes: siteBytes,
            files: siteFiles.length,
        });
        let sourceUpload;
        let sourceBytes = 0;
        let sourceFiles = 0;
        const sourceDir = input.sourceDir;
        if (sourceDir !== undefined) {
            const sourceRootStat = await runDeployStage('validate_source', signal, () => lstat(sourceDir));
            if (!sourceRootStat.isDirectory()) {
                throw deployFailure('website_deploy source directory must be a regular directory.', 'validation_failed', 'validate_source');
            }
            ensureNotAborted(signal, 'before source validation', 'validate_source');
            const [siteRoot, sourceRoot] = await runDeployStage('validate_source', signal, () => Promise.all([realpath(input.dir), realpath(sourceDir)]));
            const sourceEntries = siteRoot === sourceRoot
                ? siteFiles
                : await runDeployStage('validate_source', signal, () => walkDeployableFiles(sourceDir, this.ignorePatterns, input.dir));
            if (sourceEntries.length === 0) {
                throw deployFailure('Nothing to archive: source directory has no files after filtering.', 'validation_failed', 'validate_source');
            }
            sourceFiles = sourceEntries.length;
            sourceBytes = totalBytes(sourceEntries);
            if (sourceBytes > this.maxTotalBytes) {
                throw deployFailure(`Source directory total size ${sourceBytes} bytes exceeds the ${this.maxTotalBytes}-byte ` +
                    `source archive limit. Trim source files before deploying.`, 'validation_failed', 'validate_source');
            }
            logStage('validate_source', 'ok', {
                source_present: true,
                bytes: sourceBytes,
                files: sourceFiles,
            });
            sourceUpload = await uploadArchive({
                files: sourceEntries,
                archiveName: `${sanitizeStem(basename(sourceDir)) || 'website'}-source.zip`,
                gateway: this.gateway,
                signal,
                timeoutMs: this.uploadTimeoutMs,
                source: true,
                differentFromOssKey: siteUpload.ossKey,
            });
            logStage('upload_source', 'ok', {
                source_present: true,
                bytes: sourceBytes,
                files: sourceFiles,
            });
        }
        const isUpdate = input.nodeId !== undefined;
        const archiveOperation = isUpdate ? 'update_archive' : 'publish_archive';
        const archivePath = isUpdate ? UPDATE_ARCHIVE_PATH : PUBLISH_ARCHIVE_PATH;
        ensureNotAborted(signal, `before ${archiveOperation}`, archiveOperation);
        logStage(archiveOperation, 'started', {
            source_present: sourcePresent,
            bytes: siteBytes + sourceBytes,
            files: siteFiles.length + sourceFiles,
        });
        const published = (await runDeployStage(archiveOperation, signal, () => this.gateway.postGatewayJson(archivePath, {
            ...(input.nodeId !== undefined ? { node_id: input.nodeId } : {}),
            oss_key: siteUpload.ossKey,
            ...(sourceUpload ? { source_oss_key: sourceUpload.ossKey } : {}),
            project_name: input.projectName,
            session_id: input.sessionId,
            ...(input.nodeId === undefined && input.watermark_enabled !== undefined
                ? { watermark_enabled: input.watermark_enabled }
                : {}),
        }, signal, this.uploadTimeoutMs)));
        const baseStatusCode = published.base_resp?.status_code ?? 0;
        const statusCode = baseStatusCode !== 0 ? baseStatusCode : (published.code ?? 0);
        if (statusCode !== 0) {
            const statusMsg = baseStatusCode !== 0
                ? (published.base_resp?.status_msg ?? published.message)
                : statusCode === CONTENT_REJECTED_CODE
                    ? CONTENT_REJECTED_MESSAGE
                    : published.message;
            const errorCode = baseStatusCode === 0 ? normalizeNonEmptyString(published.error_code) : undefined;
            // 限额拒绝(code=19)时后端在 envelope 上带 EntitlementDenial(方案 §四-C3)。
            // 与 error_code 同一约定:仅业务 envelope 失败(base_resp 正常)时透传;
            // 非 record 形态直接丢弃(fail-open,工具层还有一层容错解析)。
            const entitlementDenial = baseStatusCode === 0 &&
                typeof published.entitlement_denial === 'object' &&
                published.entitlement_denial !== null &&
                !Array.isArray(published.entitlement_denial)
                ? published.entitlement_denial
                : undefined;
            // 拒绝分支的可观测锚点。工具层(agent-tools/desktop `local-website-deploy.ts`)按
            // 约定不持有 logger,而面向用户的真因文案完全取决于后端是否带回了 status_msg ——
            // 所以在这里记录 error_code 与 status_msg_present(只记"有没有",不记 message 正文,
            // 与本 logger 既有的"不落业务内容"约束一致)。status_msg_present=false 即等价于
            // 工具层只能输出中立兜底文案,失败分支走哪条据此可完整还原。
            logStage(archiveOperation, 'failed', {
                source_present: sourcePresent,
                bytes: siteBytes + sourceBytes,
                files: siteFiles.length + sourceFiles,
                status_code: statusCode,
                status_msg_present: Boolean(normalizeNonEmptyString(statusMsg)),
                ...(errorCode ? { error_code: errorCode } : {}),
                ...(entitlementDenial ? { entitlement_denial_present: true } : {}),
            });
            return {
                base_resp: {
                    status_code: statusCode,
                    status_msg: statusMsg ?? `publish service returned status_code=${statusCode}`,
                },
                ...(errorCode ? { error_code: errorCode } : {}),
                ...(entitlementDenial ? { entitlement_denial: entitlementDenial } : {}),
            };
        }
        const cdnUrl = published.cdn_url ?? published.node?.cdn_url ?? '';
        const returnedNodeId = normalizeNonEmptyString(published.node_id ?? published.node?.node_id);
        if (isUpdate && (!returnedNodeId || returnedNodeId !== input.nodeId || !cdnUrl)) {
            throw deployFailure('website_deploy update_archive returned an invalid success response.', 'publish_contract_failed', 'update_archive');
        }
        const nodeId = returnedNodeId ?? input.nodeId;
        const screenshotUrl = normalizeNonEmptyString(published.node?.screenshot_url);
        logStage('complete', 'ok', {
            source_present: sourcePresent,
            bytes: siteBytes + sourceBytes,
            files: siteFiles.length + sourceFiles,
        });
        // Cover acquisition is strictly best-effort after publish success. A bad or expired signed
        // URL must never rewrite a successful deployment into a retryable tool failure.
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
function normalizeNonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function logStage(stage, result, fields) {
    logger.info({ stage, result, ...fields }, 'website deploy stage');
}
//# sourceMappingURL=local-website-deploy-client.js.map