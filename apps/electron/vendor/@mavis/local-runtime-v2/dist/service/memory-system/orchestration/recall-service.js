import { isMemoryV2Enabled } from '@mavis/config';
import { fileFailure, isMemoryPath, noteFilePath, readFileWindow, renderStateMirror, searchFiles, } from './memory-files.js';
import { extractDocTitle, renderRulesMirror, renderSessionMirror } from './session-doc.js';
function encodeCursor(digest, sessionId) {
    return Buffer.from(JSON.stringify({ d: digest, s: sessionId })).toString('base64url');
}
function decodeCursor(cursor) {
    try {
        const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
        if (typeof obj.d === 'string' && typeof obj.s === 'string')
            return obj;
        return undefined;
    }
    catch {
        return undefined;
    }
}
export class MemoryRecallService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async loadSummaryForNewTurn(requestSessionId) {
        try {
            const resolved = await this.resolveScope(requestSessionId);
            if (resolved.status !== 'ok')
                return resolved;
            const config = this.deps.config();
            if (!config.recallEnabled)
                return { status: 'disabled' };
            const scope = resolved.scope;
            if (!scope.consolidatedDigest)
                return { status: 'empty' };
            const markdown = await this.deps.fileStore.readMemorySummary(scope.scopeKey);
            if (!markdown)
                return { status: 'empty' };
            // Validate first line
            const firstLine = markdown.split('\n')[0]?.trim();
            if (firstLine !== 'v2')
                return { status: 'empty' };
            // 长度限制由生成阶段负责，读取侧返回当前完整正文。
            return { status: 'ready', markdown };
        }
        catch {
            return { status: 'unavailable', reason: 'store-unavailable' };
        }
    }
    async getScopeStatus(requestSessionId) {
        try {
            const ctx = await this.deps.source.readContext(requestSessionId);
            const resolution = this.deps.accessPolicy.resolve({
                contextAvailable: ctx.status === 'found',
                agentName: ctx.status === 'found' ? ctx.canonicalAgentName : undefined,
                projectName: ctx.status === 'found' ? ctx.projectName : undefined,
                workspaceDir: ctx.status === 'found' ? ctx.workspaceDir : undefined,
            });
            if (resolution.status === 'scope-unresolved' || ctx.status !== 'found') {
                return { status: 'scope-unresolved' };
            }
            const scope = await this.deps.repository.getScope(resolution.scopeKey);
            if (!scope)
                return { status: 'scope-unresolved' };
            const config = this.deps.config();
            const access = this.deps.accessPolicy.evaluate({
                config,
                exclusionReason: undefined,
                rootConversation: ctx.rootConversation,
                sessionCreatedAtMs: ctx.createdAtMs,
                resetAtMs: scope.resetAtMs,
            });
            const work = await this.deps.repository.listReconciliationWork(Date.now());
            const rebuildPending = work.scopesNeedingConsolidation.includes(scope.scopeKey);
            return {
                status: 'ok',
                access,
                rebuildPending,
                resetEpoch: scope.resetEpoch,
                lastConsolidatedAtMs: scope.lastConsolidatedAtMs ?? undefined,
            };
        }
        catch {
            return { status: 'unavailable', reason: 'store-unavailable' };
        }
    }
    async canRecall(requestSessionId) {
        try {
            const result = await this.resolveScope(requestSessionId);
            return result.status === 'ok' || result.status === 'empty';
        }
        catch {
            return false;
        }
    }
    async canSubmitNote(requestSessionId) {
        try {
            if (!isMemoryV2Enabled({ v2: this.deps.config() }))
                return false;
            const result = await this.resolveScope(requestSessionId, 'note');
            return result.status === 'ok' || result.status === 'empty';
        }
        catch {
            return false;
        }
    }
    async search(input) {
        if (typeof input.query !== 'string' || !input.query.trim())
            return fileFailure('invalid-arguments', 'Provide a non-empty query.');
        const path = input.path ?? '';
        if (!isMemoryPath(path, true))
            return fileFailure('invalid-path', 'Use a relative memory path.');
        return this.withFiles(input.requestSessionId, (files) => {
            const selected = new Map([...files].filter(([name]) => path === '' || name === path || name.startsWith(`${path}/`)));
            if (path && selected.size === 0 && !MEMORY_DIRECTORIES.has(path))
                return fileFailure('not-found', 'No readable memory exists at this path.');
            return { status: 'ok', result: searchFiles(selected, input.query) };
        });
    }
    async read(input) {
        if (!isMemoryPath(input.path) || MEMORY_DIRECTORIES.has(input.path))
            return fileFailure('invalid-path', 'Choose a relative file path returned by search.');
        return this.withFiles(input.requestSessionId, (files) => {
            const content = files.get(input.path);
            return content === undefined
                ? fileFailure('not-found', 'This memory file is no longer available.')
                : readFileWindow(input.path, content, input.line_offset);
        });
    }
    async withFiles(requestSessionId, read) {
        try {
            const resolved = await this.resolveScope(requestSessionId);
            if (resolved.status === 'empty')
                return read(new Map());
            if (resolved.status !== 'ok')
                return fileFailure(resolved.status === 'disabled' ? 'disabled' : 'store-unavailable', 'Memory access is unavailable for this session.');
            return await this.deps.scopeMutation.withScopeMutation(resolved.scopeKey, async () => {
                const current = await this.resolveScope(requestSessionId);
                if (current.status !== 'ok')
                    return fileFailure(current.status === 'disabled' ? 'disabled' : 'store-unavailable', 'Memory access changed.');
                return read(await this.fileCatalog(current.scope));
            });
        }
        catch {
            return fileFailure('store-unavailable', 'Memory could not be read. Try again later.');
        }
    }
    async fileCatalog(scope) {
        const files = new Map();
        const rows = await this.deps.repository.selectCurrentSessions({
            scopeKey: scope.scopeKey,
            createdAfterMs: scope.resetAtMs,
            maxSessions: this.deps.config().maxSelectedSessions,
        });
        for (const row of rows) {
            files.set(`sessions/${row.sessionId}.md`, renderStateMirror(row));
            if (row.forgetRules !== undefined)
                files.set(`sessions/${row.sessionId}.rules.md`, renderRulesMirror({
                    sessionId: row.sessionId,
                    updatedAtMs: row.updatedAtMs,
                    rules: row.forgetRules,
                }));
        }
        for (const note of await this.deps.repository.listAdHocNotes(scope.scopeKey))
            files.set(noteFilePath(note.sessionId), renderStateMirror(note));
        if (scope.consolidatedDigest) {
            // 发布文件损坏不影响 DB 中普通文档与请求的可读性。
            try {
                const index = await this.deps.fileStore.readMemoryIndex(scope.scopeKey);
                if (index?.trim())
                    files.set('MEMORY.md', index);
            }
            catch {
                /* 文件由后台恢复。 */
            }
            try {
                const summary = await this.deps.fileStore.readMemorySummary(scope.scopeKey);
                if (summary?.split('\n')[0]?.trim() === 'v2')
                    files.set('memory_summary.md', summary);
            }
            catch {
                /* 文件由后台恢复。 */
            }
        }
        return new Map([...files].sort(([a], [b]) => comparePaths(a, b)));
    }
    async readSessionMemory(input) {
        try {
            const resolved = await this.resolveScope(input.requestSessionId, 'manage');
            // 尚未建立 scope 行等价于该 Session 没有可读记忆；MemoryReadResult 用 not-found
            // 表达这一分支,没有 empty。
            if (resolved.status === 'empty')
                return { status: 'not-found' };
            if (resolved.status !== 'ok')
                return resolved;
            const scope = resolved.scope;
            const state = await this.deps.repository.getSessionState(scope.scopeKey, input.sessionId);
            if (!state || state.exclusionReason || state.content === undefined) {
                return { status: 'not-found' };
            }
            // 详情从 content 拼装（§5.7），与镜像字节一致，不依赖镜像文件在场。
            return {
                status: 'ok',
                markdown: renderMirror(state),
                ...(state.forgetRules !== undefined
                    ? {
                        rulesMarkdown: renderRulesMirror({
                            sessionId: state.sessionId,
                            updatedAtMs: state.updatedAtMs,
                            rules: state.forgetRules,
                        }),
                    }
                    : {}),
                outputDigest: state.outputDigest,
            };
        }
        catch {
            return { status: 'unavailable', reason: 'store-unavailable' };
        }
    }
    async listSessionMemories(input) {
        try {
            const resolved = await this.resolveScope(input.requestSessionId, 'manage');
            if (resolved.status !== 'ok')
                return mapListResolution(resolved);
            const scope = resolved.scope;
            const pageRevision = scope.consolidatedDigest ?? `epoch:${scope.resetEpoch}`;
            const cursorState = input.cursor ? decodeCursor(input.cursor) : undefined;
            if (input.cursor && cursorState?.d !== pageRevision) {
                // 整理完成后游标失效：返回空页，前端重新从首页拉取(§5.7)。
                return { status: 'ok', sessions: [], nextCursor: undefined };
            }
            const config = this.deps.config();
            const rows = await this.deps.repository.selectCurrentSessions({
                scopeKey: scope.scopeKey,
                createdAfterMs: scope.resetAtMs,
                maxSessions: config.maxSelectedSessions,
            });
            const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
            const notes = await this.deps.repository.listAdHocNotes(scope.scopeKey);
            const { page, hasMore } = paginateSelection([...notes, ...rows], cursorState, limit);
            const last = page[page.length - 1];
            return {
                status: 'ok',
                sessions: page.map(toListedSession),
                nextCursor: hasMore && last ? encodeCursor(pageRevision, last.sessionId) : undefined,
            };
        }
        catch {
            return { status: 'unavailable', reason: 'store-unavailable' };
        }
    }
    async recordUsage(input) {
        try {
            const resolved = await this.resolveScope(input.requestSessionId);
            if (resolved.status === 'scope-unresolved')
                return { status: 'scope-unresolved' };
            if (resolved.status === 'empty' || resolved.status === 'disabled') {
                return { status: 'updated' };
            }
            if (resolved.status !== 'ok') {
                return { status: 'unavailable', reason: 'store-unavailable' };
            }
            const scope = resolved.scope;
            // 存在且同 scope 的行推进，其余忽略并计数上报(§5.7 引用协议)。
            await this.deps.scopeMutation.withScopeMutation(scope.scopeKey, async () => {
                await this.deps.repository.recordUsage({
                    scopeKey: scope.scopeKey,
                    sourceSessionIds: input.sourceSessionIds,
                    usedAtMs: input.usedAtMs,
                });
            });
            return { status: 'updated' };
        }
        catch {
            return { status: 'unavailable', reason: 'store-unavailable' };
        }
    }
    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------
    async resolveScope(requestSessionId, mode = 'recall') {
        const ctx = await this.deps.source.readContext(requestSessionId);
        if (ctx.status !== 'found')
            return { status: 'scope-unresolved' };
        const resolution = this.deps.accessPolicy.resolve({
            contextAvailable: true,
            agentName: ctx.canonicalAgentName,
            projectName: ctx.projectName,
            workspaceDir: ctx.workspaceDir,
        });
        if (resolution.status === 'scope-unresolved') {
            return { status: 'scope-unresolved' };
        }
        const scope = await this.deps.repository.getScope(resolution.scopeKey);
        if (mode !== 'manage') {
            const state = scope
                ? await this.deps.repository.getSessionState(scope.scopeKey, requestSessionId)
                : undefined;
            const access = this.deps.accessPolicy.evaluate({
                config: mode === 'note' ? { ...this.deps.config(), recallEnabled: true } : this.deps.config(),
                exclusionReason: state?.exclusionReason,
                rootConversation: ctx.rootConversation,
                sessionCreatedAtMs: ctx.createdAtMs,
                resetAtMs: scope?.resetAtMs ?? 0,
            });
            if (!access.canRecall || ctx.memoryPolicy?.recallEnabled === false)
                return { status: 'disabled' };
        }
        if (!scope)
            return { status: 'empty' };
        return { status: 'ok', scope, scopeKey: scope.scopeKey };
    }
}
// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const MEMORY_DIRECTORIES = new Set([
    'sessions',
    'extensions',
    'extensions/ad_hoc',
    'extensions/ad_hoc/notes',
]);
function mapListResolution(resolved) {
    switch (resolved.status) {
        case 'scope-unresolved':
            return { status: 'scope-unresolved' };
        case 'disabled':
        case 'empty':
            return { status: 'empty' };
        case 'unavailable':
            return resolved;
    }
}
function renderMirror(state) {
    return renderSessionMirror({
        sessionId: state.sessionId,
        sourceRevision: state.sourceRevision,
        sourceDigest: state.sourceDigest,
        capturedAtMs: state.capturedAtMs,
        agentName: state.agentName,
        projectName: state.projectName,
        workspaceDir: state.workspaceDir,
    }, state.content ?? '');
}
/** 基于选集顺序的游标分页；游标已在调用方按 consolidatedDigest 校验过（§5.7）。 */
function paginateSelection(rows, cursorState, limit) {
    let startIndex = 0;
    if (cursorState) {
        const at = rows.findIndex((row) => row.sessionId === cursorState.s);
        startIndex = at === -1 ? rows.length : at + 1;
    }
    return {
        page: rows.slice(startIndex, startIndex + limit),
        hasMore: startIndex + limit < rows.length,
    };
}
function toListedSession(state) {
    return {
        sourceSessionId: state.sessionId,
        title: extractDocTitle(state.content ?? ''),
        byteSize: Buffer.byteLength(state.content ?? '', 'utf8'),
        hasForgetRules: state.forgetRules !== undefined,
        capturedAtMs: state.capturedAtMs,
        lastUsedAtMs: state.lastUsedAtMs ?? undefined,
    };
}
function comparePaths(a, b) {
    if (a === b)
        return 0;
    return a < b ? -1 : 1;
}
//# sourceMappingURL=recall-service.js.map