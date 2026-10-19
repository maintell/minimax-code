import { createHash, randomBytes } from 'node:crypto';
import { GLOBAL_SCOPE_KEY } from '../contracts.js';
import { computeOutputDigest, renderSessionMirror, validateDocumentEnvelope, } from './session-doc.js';
// ---------------------------------------------------------------------------
// Synthetic Session ID (§8.3)
// ---------------------------------------------------------------------------
/**
 * Derive a migration synthetic session ID that is safe for file names on
 * both macOS and Windows. Format: `legacy-` + base64url(sha256(agentName + '\0' + sourceFile))[0..22]
 *
 * This avoids `/`, `:`, `\` that would break path safety contracts.
 */
function deriveLegacySessionId(agentName, sourceFile) {
    const hash = createHash('sha256')
        .update(`${agentName}\0${sourceFile}`, 'utf-8')
        .digest('base64url');
    // Take first 22 chars of base64url (≈16 bytes of entropy)
    return `legacy-${hash.slice(0, 22)}`;
}
/** 迁移落点恒为全局作用域，文档 frontmatter 标注来源 agent（§8.3）。 */
export class MemoryLegacyMigrationService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /** 每个旧文件单独抽成一份会话记忆文档，保持来源归因无歧义（§5.16）。 */
    async extractLegacyDocuments(sources, agentName, contractId) {
        const config = this.deps.config();
        const now = this.deps.nowMs();
        const documents = [];
        for (const source of sources) {
            const modelResult = await this.deps.modelGateway.migrateLegacy({
                contractId,
                source,
                agentName,
                maxDocBytes: config.maxSessionDocBytes,
                signal: new AbortController().signal,
            });
            if (modelResult.status !== 'ok')
                return 'model-unavailable';
            const envelope = validateDocumentEnvelope(modelResult.output.document, config.maxSessionDocBytes);
            if (envelope.status === 'invalid')
                return 'model-invalid-output';
            if (envelope.status === 'empty')
                continue;
            const sessionId = deriveLegacySessionId(agentName, source.sourceFile);
            const markdown = renderSessionMirror({
                sessionId,
                sourceRevision: 'legacy-migration',
                sourceDigest: sha256(source.content),
                capturedAtMs: now,
                agentName,
                projectName: undefined,
                workspaceDir: undefined,
            }, envelope.content);
            documents.push({ sourceFile: source.sourceFile, sessionId, markdown });
        }
        return documents;
    }
    async prepare(input) {
        try {
            const agentName = input.agentName.trim();
            if (agentName.length === 0)
                return { status: 'scope-unresolved' };
            const sources = await this.deps.fileStore.readLegacySources(agentName);
            if (sources.length === 0)
                return { status: 'legacy-source-empty' };
            const contract = await this.deps.modelGateway.resolveContract('migration');
            const documents = await this.extractLegacyDocuments(sources, agentName, contract.contractId);
            if (typeof documents === 'string')
                return { status: 'unavailable', reason: documents };
            if (documents.length === 0)
                return { status: 'legacy-source-empty' };
            const previewId = randomBytes(16).toString('base64url');
            try {
                await this.deps.fileStore.deleteStaging(previewId);
            }
            catch {
                // Ignore
            }
            await this.deps.fileStore.createStaging(previewId, { agentName });
            for (const doc of documents) {
                await this.deps.fileStore.writeStaging(previewId, `${doc.sessionId}.md`, doc.markdown);
            }
            return {
                status: 'prepared',
                previewId,
                sourceFileCount: sources.length,
                documents: documents.map((doc) => ({
                    sourceFile: doc.sourceFile,
                    markdown: doc.markdown,
                })),
            };
        }
        catch {
            return { status: 'unavailable', reason: 'legacy-source-unavailable' };
        }
    }
    async accept(input) {
        try {
            const staging = await this.deps.fileStore.readStaging(input.previewId);
            if (!staging || staging.owner.agentName !== input.agentName) {
                return { status: 'legacy-preview-not-found' };
            }
            const scope = await this.deps.repository.ensureScope(GLOBAL_SCOPE_KEY);
            const now = this.deps.nowMs();
            let documentCount = 0;
            await this.deps.scopeMutation.withScopeMutation(GLOBAL_SCOPE_KEY, async () => {
                const currentScope = await this.deps.repository.getScope(GLOBAL_SCOPE_KEY);
                if (!currentScope || currentScope.resetEpoch !== scope.resetEpoch)
                    throw new Error('Stale migration preview');
                for (const file of staging.files) {
                    const sessionId = file.fileName.replace(/\.md$/, '');
                    const previous = await this.deps.repository.getSessionState(GLOBAL_SCOPE_KEY, sessionId);
                    const content = stripMirrorFrontmatter(file.markdown);
                    if (content === undefined)
                        continue;
                    // 按提交行字段重渲镜像，保证 outputDigest 恒等于行渲染结果（§6.4 补物化不变量）。
                    const sourceRevision = `legacy-migration-${input.previewId}`;
                    const sourceDigest = sha256(content);
                    const mirror = renderSessionMirror({
                        sessionId,
                        sourceRevision,
                        sourceDigest,
                        capturedAtMs: now,
                        agentName: input.agentName,
                        projectName: undefined,
                        workspaceDir: undefined,
                    }, content);
                    // 迁移文档与正常抽取文档同构：单事务提交后物化镜像（§8.4）。
                    const commit = await this.deps.repository.commitCapture({
                        scopeKey: GLOBAL_SCOPE_KEY,
                        sessionId,
                        expectedResetEpoch: scope.resetEpoch,
                        expectedSourceRevision: previous?.sourceRevision,
                        sessionCreatedAtMs: now,
                        sourceRevision,
                        sourceDigest,
                        captureContractId: 'legacy-migration',
                        outputDigest: computeOutputDigest(mirror),
                        content,
                        agentName: input.agentName,
                        projectName: undefined,
                        workspaceDir: undefined,
                        capturedAtMs: now,
                    });
                    if (commit !== 'committed')
                        throw new Error('Stale migration capture');
                    documentCount += 1;
                    try {
                        await this.deps.fileStore.writeSessionMemory(GLOBAL_SCOPE_KEY, sessionId, mirror);
                    }
                    catch {
                        // 镜像由 Reconciler 补物化（§6.4）。
                    }
                }
                // 配置写入成功才完成接受；失败保留预览，重试覆盖同一批来源。
                await this.deps.disableLegacyRecall(input.agentName);
            }, { requestWakeOnComplete: true });
            try {
                await this.deps.fileStore.deleteStaging(input.previewId);
            }
            catch {
                // Best-effort
            }
            return {
                status: 'accepted',
                scopeKey: GLOBAL_SCOPE_KEY,
                documentCount,
            };
        }
        catch {
            return { status: 'unavailable', reason: 'store-unavailable' };
        }
    }
    async discard(input) {
        try {
            const staging = await this.deps.fileStore.readStaging(input.previewId);
            if (!staging || staging.owner.agentName !== input.agentName) {
                return { status: 'legacy-preview-not-found' };
            }
            await this.deps.fileStore.deleteStaging(input.previewId);
            return { status: 'discarded' };
        }
        catch {
            return { status: 'unavailable', reason: 'store-unavailable' };
        }
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** 暂存文件是完整镜像（含 frontmatter）；accept 时取回正文写入 content 列。 */
function stripMirrorFrontmatter(mirror) {
    const match = /^---\n[\s\S]*?\n---\n\n?/u.exec(mirror);
    const body = (match ? mirror.slice(match[0].length) : mirror).trim();
    return body.length === 0 ? undefined : body;
}
function sha256(value) {
    return createHash('sha256').update(value, 'utf-8').digest('base64url');
}
//# sourceMappingURL=legacy-migration-service.js.map