/**
 * 会话记忆文档的信封校验与镜像渲染（§5.5、§6.2）。
 *
 * 镜像必须能从状态行逐字节重物化（§6.4），因此这里的渲染只依赖状态行字段，
 * capture、治理直编与 Reconciler 补物化共用同一实现。
 */
import { createHash } from 'node:crypto';
/** §6.2 固定的三个二级小节标题；非空文档至少包含其一。 */
const SESSION_DOC_SECTIONS = ['## 用户偏好', '## 事实与决策', '## 做法与避坑'];
/** 信封校验（§5.5）：UTF-8/LF 由 gateway 保证，这里校验字节上限与小节骨架。 */
export function validateDocumentEnvelope(document, maxDocBytes) {
    const content = document.replace(/\r\n?/gu, '\n').trim();
    if (content.length === 0)
        return { status: 'empty' };
    if (Buffer.byteLength(content, 'utf8') > maxDocBytes) {
        return { status: 'invalid', detail: 'document exceeds maxSessionDocBytes' };
    }
    const hasSection = SESSION_DOC_SECTIONS.some((section) => content.includes(section));
    if (!hasSection) {
        return { status: 'invalid', detail: 'document is missing the section skeleton' };
    }
    return { status: 'ok', content };
}
/** 按 §6.2 拼装镜像：frontmatter 全部来自状态行字段，保证补物化字节一致。 */
export function renderSessionMirror(meta, content) {
    const lines = [
        '---',
        'version: 2',
        `session_id: ${meta.sessionId}`,
        `source_revision: ${meta.sourceRevision}`,
        `source_digest: ${meta.sourceDigest}`,
        `captured_at_ms: ${meta.capturedAtMs}`,
        ...(meta.agentName ? [`agent: ${meta.agentName}`] : []),
        ...(meta.projectName ? [`project: ${meta.projectName}`] : []),
        ...(meta.workspaceDir ? [`workspace: ${meta.workspaceDir}`] : []),
        '---',
        '',
        content,
        '',
    ];
    return lines.join('\n');
}
/** 遗忘规则镜像（§6.2）。 */
export function renderRulesMirror(input) {
    return [
        '---',
        'version: 1',
        `session_id: ${input.sessionId}`,
        `updated_at_ms: ${input.updatedAtMs}`,
        '---',
        '',
        '# 遗忘规则',
        '',
        input.rules,
        '',
    ].join('\n');
}
/** 镜像内容指纹；content 为空（合法空结果）时按空正文计算（§6.1）。 */
export function computeOutputDigest(mirrorMarkdown) {
    return createHash('sha256')
        .update(mirrorMarkdown ?? '', 'utf8')
        .digest('base64url');
}
/** 文档一级标题（会话主题），供列表展示；无标题时返回空串。 */
export function extractDocTitle(content) {
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('# '))
            return trimmed.slice(2).trim();
        if (trimmed.length > 0 && !trimmed.startsWith('#'))
            break;
    }
    return '';
}
//# sourceMappingURL=session-doc.js.map