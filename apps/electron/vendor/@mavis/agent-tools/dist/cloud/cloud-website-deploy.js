var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
import { Type } from '@sinclair/typebox';
import { isAbsolute, join, relative, sep } from 'node:path';
import { bindTool, } from '@mavis/agent-core/tools';
import { logger } from './runtime-types.js';
import { createLocalWebsiteDeployFiles, } from './website-deploy-files.js';
import { ENTITLEMENT_LIMIT_EXCEEDED_ERROR_CODE, WEBSITE_ENTITLEMENT_LIMIT_EXCEEDED_CODE, buildEntitlementLimitReachedEvent, parseEntitlementDenial, websiteDeployEntitlementLimitText, } from '../shared/entitlement.js';
const ARCHIVE_MIME = 'application/zip';
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const ARCHIVE_REQUEST_TIMEOUT_MS = 1_500_000;
const GET_UPLOAD_URL_PATH = '/matrix/api/v1/mcp/get_upload_url';
const PUBLISH_WEBSITE_ARCHIVE_PATH = '/matrix/api/v1/mcp/publish_website_archive';
export { isWebsiteDeployIgnoredName, } from './website-deploy-files.js';
export const WebsiteDeployToolDef = {
    name: 'website_deploy',
    description: '⚠️ **Public deployment — user confirmation required.** This tool publishes the ' +
        'built site to a **publicly-accessible URL on the open Internet**. Anyone with the link ' +
        'can view the deployed site. Before invoking this tool you MUST: (1) tell the user the ' +
        'site will be publicly accessible, (2) get explicit confirmation to publish. Do NOT ' +
        'auto-invoke without confirmation, even if the user previously asked to "deploy" or ' +
        '"build a website" — ask for confirmation in your reply and publish only after the user\'s ' +
        'next message confirms. `source_path` is required and ' +
        'uploaded to private storage as a separate source archive. Before invoking, tell the user ' +
        'about that private source upload and ask them to confirm it contains no secrets. `.env*`, ' +
        '`.git`, `node_modules`, and symlinks are excluded, but this is not a secrets scanner.\n\n' +
        'Deploy a **built static website** (a directory containing index.html and bundled assets — ' +
        'e.g. the output of `vite build` / `next export` / similar bundler dist/) to a public URL. ' +
        'The directory **must contain index.html at the root**; CDN routes `/` to ' +
        '/<domain>/index.html and the deploy will be unusable without it. ' +
        '**Do not pass source code or unbuilt project directories as `path`** — run the build step ' +
        'first and pass the dist/ output. `source_path` may be the same directory for a ' +
        'self-contained static site. The site is registered as a node in the user drive ' +
        '(category=website). Returns the public URL and node ID.\n\n' +
        'When delivering the deployed site to the user, output it inside a <deliver-assets> block ' +
        'with type="website":\n\n' +
        '<deliver-assets>\n' +
        '<media type="website" src="<the deployed URL returned in tool result>" name="<project_name>" />\n' +
        '</deliver-assets>\n\n' +
        'Use the URL string as src; the runtime maps it to a drive transport id transparently.',
    schema: Type.Object({
        path: Type.String({
            description: 'Workspace-relative or absolute path to the **built** static-site root directory ' +
                '(bundler dist/ output). Must contain index.html.',
        }),
        source_path: Type.String({
            description: 'Required workspace-relative or absolute path to the project source root. It is saved ' +
                'as a private ZIP separate from the public built-site ZIP. A self-contained static site ' +
                'may use the same directory as path.',
        }),
        project_name: Type.String({
            description: 'Used as the display name of the drive node and the HTML <title> tag when missing from ' +
                'the source. Pick a short human-readable name.',
        }),
    }),
};
let CloudWebsiteDeployTool = (() => {
    let _classDecorators = [bindTool(WebsiteDeployToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudWebsiteDeployTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudWebsiteDeployTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        deployFiles;
        constructor(archonServer, workspaceRoot, 
        /** 缺省直接读写本机 workspace；cloud-harness-server 传入走 compute 的实现。 */
        deployFiles = createLocalWebsiteDeployFiles(workspaceRoot)) {
            this.archonServer = archonServer;
            this.deployFiles = deployFiles;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted) {
                return aiReadableFailure('Deploy was aborted before it started.', { reason: 'aborted' });
            }
            const sourcePath = input.source_path;
            if (typeof sourcePath !== 'string') {
                return aiReadableFailure('Cannot deploy: source_path is required.', {
                    reason: 'missing_source_path',
                });
            }
            if (!sourcePath.trim()) {
                return aiReadableFailure('Cannot deploy: source_path must not be empty.', {
                    reason: 'invalid_source_path',
                });
            }
            const files = this.deployFiles;
            const dir = await resolveDeployDirectory(files, input.path, 'path');
            if (!dir.ok)
                return aiReadableFailure(dir.message, dir.details);
            const index = await validateIndex(files, dir.path, input.path);
            if (!index.ok)
                return aiReadableFailure(index.message, index.details);
            const sourceDir = await resolveDeployDirectory(files, sourcePath, 'source');
            if (!sourceDir.ok)
                return aiReadableFailure(sourceDir.message, sourceDir.details);
            let canonicalSite;
            let canonicalSource;
            try {
                [canonicalSite, canonicalSource] = await Promise.all([
                    files.realpath(dir.path),
                    files.realpath(sourceDir.path),
                ]);
            }
            catch {
                return aiReadableFailure('Cannot deploy: unable to resolve the source directory safely.', {
                    reason: 'source_realpath_failed',
                });
            }
            if (canonicalSite !== canonicalSource && isPathInside(canonicalSite, canonicalSource)) {
                return aiReadableFailure('Cannot deploy: source_path cannot be nested inside the built site directory.', { reason: 'source_inside_build' });
            }
            let siteFiles;
            let sourceFiles;
            try {
                siteFiles = await files.list(dir.path, signal);
                sourceFiles =
                    canonicalSite === canonicalSource
                        ? siteFiles
                        : await files.list(sourceDir.path, signal, dir.path);
            }
            catch {
                if (signal?.aborted) {
                    return aiReadableFailure('Deploy was aborted before archive preparation finished.', {
                        reason: 'aborted',
                    });
                }
                return aiReadableFailure('Cannot deploy: unable to prepare the site or source archive.', {
                    reason: 'validation_failed',
                });
            }
            const siteBytes = totalBytes(siteFiles);
            if (siteFiles.length === 0 || siteBytes > MAX_ARCHIVE_BYTES) {
                return archiveSizeFailure('site', siteBytes, siteFiles.length);
            }
            const sourceBytes = totalBytes(sourceFiles);
            if (sourceFiles.length === 0 || sourceBytes > MAX_ARCHIVE_BYTES) {
                return archiveSizeFailure('source', sourceBytes, sourceFiles.length);
            }
            const sessionId = ctx.sessionId;
            if (!sessionId) {
                return aiReadableFailure('Deploy needs an active session, but the current turn has none. Please report this ' +
                    'to the user — it is an internal state issue, not something they can fix.', { reason: 'missing_session_id' });
            }
            const siteUpload = await uploadArchive({
                archonServer: this.archonServer,
                deployFiles: files,
                files: siteFiles,
                filename: 'website.zip',
                signal,
                stage: 'site',
            });
            if (!siteUpload.ok)
                return archiveUploadFailure(siteUpload);
            const sourceUpload = await uploadArchive({
                archonServer: this.archonServer,
                deployFiles: files,
                files: sourceFiles,
                filename: 'website-source.zip',
                signal,
                stage: 'source',
                differentFromOssKey: siteUpload.ossKey,
            });
            if (!sourceUpload.ok)
                return archiveUploadFailure(sourceUpload);
            let response;
            try {
                response = await this.archonServer.postJson(PUBLISH_WEBSITE_ARCHIVE_PATH, {
                    oss_key: siteUpload.ossKey,
                    source_oss_key: sourceUpload.ossKey,
                    project_name: input.project_name,
                    session_id: sessionId,
                }, signal, { timeoutMs: ARCHIVE_REQUEST_TIMEOUT_MS });
            }
            catch {
                if (signal?.aborted) {
                    return aiReadableFailure('Deploy was aborted before publishing finished.', {
                        reason: 'aborted',
                    });
                }
                return aiReadableFailure('Deploy could not reach the publish service after both archives uploaded. Retry the ' +
                    'same call to try again.', { reason: 'rpc_failed' });
            }
            const baseResp = recordValue(response.base_resp);
            const baseStatusCode = numberValue(baseResp?.status_code) ?? 0;
            const statusCode = baseStatusCode !== 0 ? baseStatusCode : (numberValue(response.code) ?? 0);
            if (statusCode !== 0) {
                const entitlementFailure = await entitlementLimitFailure(ctx, response, statusCode);
                if (entitlementFailure)
                    return entitlementFailure;
                return aiReadableFailure('Deploy was rejected by the publish service. This usually means the deployment ' +
                    'infrastructure has a config issue and the user cannot fix it from the chat.', {
                    reason: 'rpc_business_failure',
                    status_code: statusCode,
                    status_msg: stringValue(baseResp?.status_msg) ??
                        stringValue(response.message) ??
                        `publish service returned status_code=${statusCode}`,
                    ...(stringValue(response.error_code)
                        ? { error_code: stringValue(response.error_code) }
                        : {}),
                });
            }
            const node = recordValue(response.node);
            const websiteUrl = stringValue(response.cdn_url) ?? stringValue(node?.cdn_url);
            if (!websiteUrl) {
                return aiReadableFailure('Deploy returned an empty URL — this is unexpected. Please tell the user the deployment ' +
                    'did not complete cleanly and ask if they would like to retry.', { reason: 'rpc_empty_cdn_url' });
            }
            const nodeId = stringValue(response.node_id) ?? stringValue(node?.node_id);
            if (!nodeId) {
                return aiReadableFailure('Deploy returned an empty node ID — this is unexpected. Please ask the user to retry.', { reason: 'rpc_empty_node_id' });
            }
            const text = `Website deployed: ${websiteUrl}`;
            return {
                tool_name: WebsiteDeployToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: { ok: true, website_url: websiteUrl, node_id: nodeId },
            };
        }
    };
    return CloudWebsiteDeployTool = _classThis;
})();
export { CloudWebsiteDeployTool };
async function resolveDeployDirectory(files, inputPath, kind) {
    const label = kind === 'source' ? 'source_path' : 'path';
    let path;
    try {
        path = await files.resolve(inputPath);
    }
    catch {
        return {
            ok: false,
            message: `Cannot deploy: '${inputPath}' is outside the workspace or invalid.`,
            details: { reason: kind === 'source' ? 'source_path_escape' : 'path_escape' },
        };
    }
    let type;
    try {
        type = await files.typeOf(path);
    }
    catch {
        return {
            ok: false,
            message: `Cannot deploy: unable to read '${label}'. Check the path and permissions, then retry.`,
            details: { reason: kind === 'source' ? 'source_stat_failed' : 'stat_failed' },
        };
    }
    if (type === 'dir')
        return { ok: true, path };
    if (type === undefined) {
        return {
            ok: false,
            message: kind === 'source'
                ? `Cannot deploy: '${inputPath}' does not exist.`
                : `Cannot deploy: '${inputPath}' does not exist. Run the build first, then pass its output directory.`,
            details: { reason: kind === 'source' ? 'source_not_found' : 'not_found' },
        };
    }
    return {
        ok: false,
        message: kind === 'source'
            ? `Cannot deploy: '${inputPath}' is not a real source directory.`
            : `Cannot deploy: '${inputPath}' is not a directory. Pass the built site directory.`,
        details: { reason: kind === 'source' ? 'source_not_a_directory' : 'not_a_directory' },
    };
}
async function validateIndex(files, dir, inputPath) {
    let type;
    try {
        type = await files.typeOf(join(dir, 'index.html'));
    }
    catch {
        return {
            ok: false,
            message: `Cannot deploy: unable to read '${inputPath}/index.html'.`,
            details: { reason: 'index_stat_failed' },
        };
    }
    if (type === 'file')
        return { ok: true };
    if (type === undefined) {
        return {
            ok: false,
            message: `Cannot deploy: '${inputPath}' has no index.html at the root. website_deploy needs ` +
                'a built static site (a bundler dist/ output), not source code or an unbuilt project.',
            details: { reason: 'missing_index_html' },
        };
    }
    return {
        ok: false,
        message: `Cannot deploy: '${inputPath}/index.html' exists but is not a regular file.`,
        details: { reason: 'index_not_a_file' },
    };
}
async function uploadArchive(input) {
    if (input.signal?.aborted)
        return { ok: false, reason: 'aborted', stage: input.stage };
    let archive;
    try {
        archive = await input.deployFiles.pack(input.files, input.signal);
    }
    catch {
        return {
            ok: false,
            reason: input.signal?.aborted ? 'aborted' : 'oss_upload_failed',
            stage: input.stage,
        };
    }
    try {
        return await sendArchive(input, archive);
    }
    finally {
        await archive.dispose();
    }
}
async function sendArchive(input, archive) {
    let prepared;
    try {
        prepared = await input.archonServer.postJson(GET_UPLOAD_URL_PATH, {
            filename: input.filename,
            mime_type: ARCHIVE_MIME,
            size_bytes: archive.bytes,
            category: 'website',
        }, input.signal, { timeoutMs: ARCHIVE_REQUEST_TIMEOUT_MS });
    }
    catch {
        return {
            ok: false,
            reason: input.signal?.aborted ? 'aborted' : 'oss_upload_failed',
            stage: input.stage,
        };
    }
    const baseStatusCode = numberValue(recordValue(prepared.base_resp)?.status_code) ?? 0;
    const code = baseStatusCode !== 0 ? baseStatusCode : (numberValue(prepared.code) ?? 0);
    const putUrl = stringValue(prepared.put_url);
    const ossKey = stringValue(prepared.oss_key);
    if (code !== 0 || !putUrl || !ossKey || input.differentFromOssKey === ossKey) {
        return { ok: false, reason: 'upload_url_rejected', stage: input.stage };
    }
    try {
        const uploaded = await archive.put(putUrl, {
            contentType: ARCHIVE_MIME,
            timeoutMs: ARCHIVE_REQUEST_TIMEOUT_MS,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (input.signal?.aborted)
            return { ok: false, reason: 'aborted', stage: input.stage };
        if (!uploaded)
            return { ok: false, reason: 'oss_upload_failed', stage: input.stage };
    }
    catch {
        return {
            ok: false,
            reason: input.signal?.aborted ? 'aborted' : 'oss_upload_failed',
            stage: input.stage,
        };
    }
    return { ok: true, ossKey };
}
function archiveSizeFailure(kind, bytes, count) {
    if (count === 0) {
        return aiReadableFailure(`Cannot deploy: the ${kind} archive has no files after filtering.`, {
            reason: 'validation_failed',
            stage: kind,
        });
    }
    return aiReadableFailure(`Cannot deploy: ${kind} archive size ${bytes} bytes exceeds the ${MAX_ARCHIVE_BYTES}-byte limit. ` +
        'Reduce files and retry.', { reason: 'file_too_large', stage: kind });
}
function archiveUploadFailure(result) {
    if (result.reason === 'aborted') {
        return aiReadableFailure('Deploy was aborted before archive upload finished.', {
            reason: 'aborted',
        });
    }
    if (result.reason === 'upload_url_rejected') {
        return aiReadableFailure('Deploy could not prepare an archive upload. Retry the same call; no publish request was sent.', { reason: 'upload_url_rejected', stage: result.stage });
    }
    return aiReadableFailure('Deploy failed while uploading the archive. This is usually transient — retry the same call.', { reason: 'oss_upload_failed', stage: result.stage });
}
function totalBytes(files) {
    return files.reduce((sum, file) => sum + file.bytes, 0);
}
function isPathInside(parent, candidate) {
    const rel = relative(parent, candidate);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function recordValue(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function stringValue(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function numberValue(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function aiReadableFailure(message, details) {
    return {
        tool_name: WebsiteDeployToolDef.name,
        text: message,
        content: [{ type: 'text', text: message }],
        details: { ok: false, ...details },
    };
}
/**
 * WebsiteManagementCode.ENTITLEMENT_LIMIT_EXCEEDED = 19（方案 §四-C3 envelope）：
 * 服务端限额 gate 拒绝发布时返回用户拍板的 §四-D 文案，并经 ctx.reporter 发
 * §四-E `entitlement.limit_reached` 副流事件（CloudTodoWriteTool 同款通道）。
 *
 * 体验层兜底，不是强制点：`entitlement_denial` 缺失/字段不可用 → 返回
 * `undefined` 走既有通用业务失败文案；事件发送失败只记日志不影响 tool result。
 */
async function entitlementLimitFailure(ctx, response, statusCode) {
    const isEntitlementRejection = stringValue(response.error_code) === ENTITLEMENT_LIMIT_EXCEEDED_ERROR_CODE ||
        numberValue(response.code) === WEBSITE_ENTITLEMENT_LIMIT_EXCEEDED_CODE;
    if (!isEntitlementRejection)
        return undefined;
    const denial = parseEntitlementDenial(response.entitlement_denial);
    if (!denial) {
        logger.warn(`[cloud-website-deploy] stage=entitlement_denial_parse code=ENTITLEMENT_DENIAL_UNUSABLE ` +
            `session_id=${ctx.sessionId} status_code=${statusCode}`);
        return undefined;
    }
    let eventEmitted = false;
    try {
        await ctx.reporter.appendEvents([
            buildEntitlementLimitReachedEvent({
                sessionId: ctx.sessionId,
                turnId: ctx.turnId,
                reporter: ctx.reporter,
                denial,
            }),
        ]);
        eventEmitted = true;
    }
    catch {
        logger.warn(`[cloud-website-deploy] stage=entitlement_event_emit code=ENTITLEMENT_EVENT_EMIT_FAILED ` +
            `session_id=${ctx.sessionId} turn_id=${ctx.turnId}`);
    }
    return aiReadableFailure(websiteDeployEntitlementLimitText(denial), {
        reason: 'entitlement_limit_exceeded',
        retryable: false,
        status_code: statusCode,
        error_code: ENTITLEMENT_LIMIT_EXCEEDED_ERROR_CODE,
        entitlement_key: denial.entitlement_key,
        limit: denial.limit,
        current: denial.current,
        event_emitted: eventEmitted,
    });
}
//# sourceMappingURL=cloud-website-deploy.js.map