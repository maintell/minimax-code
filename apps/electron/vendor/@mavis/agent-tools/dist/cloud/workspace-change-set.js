/**
 * 端云协同"云端结果变更集"的纯函数，v1 cloud-runtime 与 v2 harness 共用：
 * 路径过滤与排序、OSS key 约定、单文件 diff 生成、revision 摘要。
 * 不做任何 IO；读文件、上传与完整性校验由调用方负责。
 */
import { createHash } from 'node:crypto';
import { structuredPatch } from 'diff';
// 敏感文件判定与 v1 快照一致；转出给不直接依赖 @mavis/shared 的 v2 harness。
export { isSensitiveHandoffPath } from '@mavis/shared';
export const CHANGE_SET_SNAPSHOT_DIR = '.archon-session-change-sets';
export const MAX_DIFF_FILE_BYTES = 1 << 20;
export const MAX_DIFF_MANIFEST_BYTES = 32 << 20;
export const MAX_CHANGE_SET_ENTRIES = 10_000;
export const MAX_CHANGE_SET_FILE_BYTES = 256 << 20;
// 基线与结果快照共用总容量边界，避免合法交接的文件集在生成 diff 时被更小的限制拒绝。
export const MAX_CHANGE_SET_TOTAL_BYTES = 1 << 30;
export const CLOUD_DIFF_MANIFEST_SCHEMA = 'mavis.session.cloud-diff-manifest.v1';
export const CHANGE_SET_MANIFEST_SCHEMA = 'mavis.session.change-set-manifest.v1';
const MAX_DIFF_EDIT_LENGTH = 200_000;
const DIFF_TIMEOUT_MS = 5_000;
const DIFF_CONTEXT_LINES = 3;
// session-materializer(Go)对 approved manifest 要求路径严格字节序升序:
// `files[i-1].RelativePath >= files[i].RelativePath` 即判定非法并整批拒绝物化。
//
// `localeCompare` 是 locale 相关且大小写不敏感的,会把 `hello.txt` 排到
// `MiniMax-Code.pdf` 之前,而 Go 按字节比较得到相反次序('M'=0x4D < 'h'=0x68),
// 于是只要用户同时勾选大小写混排的文件,finalize 后的物化就必然失败。
//
// Buffer 比较走 UTF-8 字节,与 Go 的 string 比较逐字节等价,非 ASCII 路径同样成立。
export function compareWorkspacePaths(left, right) {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
export function excludedWorkspacePath(relativePath) {
    return (relativePath === '.archon' ||
        relativePath.startsWith('.archon/') ||
        relativePath === '.git' ||
        relativePath === '.mavis' ||
        relativePath.startsWith('.mavis/') ||
        relativePath.startsWith('.git/') ||
        relativePath === '.home' ||
        relativePath.startsWith('.home/') ||
        relativePath === '.plugin-cache' ||
        relativePath.startsWith('.plugin-cache/') ||
        relativePath === '.skills' ||
        relativePath.startsWith('.skills/') ||
        relativePath === '.archon-dispatch-baseline.json' ||
        relativePath === '.archon-dispatch-baseline.json.tmp' ||
        relativePath === CHANGE_SET_SNAPSHOT_DIR ||
        relativePath.startsWith(`${CHANGE_SET_SNAPSHOT_DIR}/`));
}
export function safeWorkspacePath(relativePath) {
    if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\\'))
        return false;
    const segments = relativePath.split('/');
    return !segments.some((segment) => segment === '' || segment === '.' || segment === '..');
}
export function workspaceSnapshotObjectKey(sessionId, contentSha256) {
    return `session-workspaces/${encodeURIComponent(sessionId)}/objects/sha256/${contentSha256}`;
}
export function changeSetManifestKey(sessionId, resultManifestId) {
    return `session-change-sets/${encodeURIComponent(sessionId)}/${resultManifestId}/manifest.json`;
}
export function cloudDiffManifestObjectKey(sessionId, resultManifestId) {
    return `session-change-sets/${encodeURIComponent(sessionId)}/${resultManifestId}/diff-manifest.json`;
}
export function workspaceChangeKindWire(kind) {
    switch (kind) {
        case 'add':
            return 1;
        case 'modify':
            return 2;
        case 'delete':
            return 3;
    }
}
/** 基线条目与当前条目的变更类型；内容未变返回 undefined。 */
export function workspaceChangeKind(before, after) {
    if (!before && after)
        return 'add';
    if (before && !after)
        return 'delete';
    if (before && after && before.sha256 !== after.sha256)
        return 'modify';
    return undefined;
}
/** v1 cloudRevisionId：当前文件集（已按字节序排序）的摘要。 */
export function workspaceRevisionId(files) {
    const payload = files.map(({ relativePath, sha256, sizeBytes }) => ({
        relativePath,
        sha256,
        sizeBytes,
    }));
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
/**
 * 不需要读内容就能确定的 diff 结果：敏感文件按 binary、超过 1MB 按 too_large。
 * 返回 undefined 表示需要读取前后内容再调用 {@link cloudDiffFromBodies}。
 */
export function cloudDiffPrecheck(relativePath, kind, before, after) {
    if (before?.sensitive === true || after?.sensitive === true) {
        return unavailableDiff(relativePath, kind, 'binary');
    }
    if ((before?.sizeBytes ?? 0) > MAX_DIFF_FILE_BYTES ||
        (after?.sizeBytes ?? 0) > MAX_DIFF_FILE_BYTES) {
        return unavailableDiff(relativePath, kind, 'too_large');
    }
    return undefined;
}
/** 由已校验过完整性的前后内容生成 diff；add 的 before、delete 的 after 传空 Buffer。 */
export function cloudDiffFromBodies(relativePath, kind, beforeBody, afterBody) {
    const beforeText = decodeUTF8(beforeBody);
    const afterText = decodeUTF8(afterBody);
    if (beforeText === undefined || afterText === undefined) {
        return unavailableDiff(relativePath, kind, 'binary');
    }
    const oldFileName = kind === 'add' ? '/dev/null' : `a/${relativePath}`;
    const newFileName = kind === 'delete' ? '/dev/null' : `b/${relativePath}`;
    let structured;
    try {
        structured = structuredPatch(oldFileName, newFileName, beforeText, afterText, undefined, undefined, {
            context: DIFF_CONTEXT_LINES,
            maxEditLength: MAX_DIFF_EDIT_LENGTH,
            timeout: DIFF_TIMEOUT_MS,
        });
    }
    catch {
        return unavailableDiff(relativePath, kind, 'too_large');
    }
    if (!structured)
        return unavailableDiff(relativePath, kind, 'too_large');
    if (structured.hunks.length === 0)
        return unavailableDiff(relativePath, kind, 'no_diff');
    const hunks = structured.hunks.map((hunk) => ({
        old_start: hunk.oldStart,
        old_lines: hunk.oldLines,
        new_start: hunk.newStart,
        new_lines: hunk.newLines,
        lines: [...hunk.lines],
    }));
    const { additions, deletions } = countChangedLines(hunks);
    return {
        relative_path: relativePath,
        preview_state: 'ready',
        additions,
        deletions,
        status: diffStatus(kind),
        diff: renderUnifiedDiff(oldFileName, newFileName, hunks),
        patch: {
            old_file_name: oldFileName,
            new_file_name: newFileName,
            hunks,
        },
    };
}
export function decodeUTF8(body) {
    if (body.includes(0))
        return undefined;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(body);
    }
    catch {
        return undefined;
    }
}
function unavailableDiff(relativePath, kind, previewState) {
    return {
        relative_path: relativePath,
        preview_state: previewState,
        additions: 0,
        deletions: 0,
        status: diffStatus(kind),
    };
}
function diffStatus(kind) {
    return kind === 'add' ? 'added' : kind === 'delete' ? 'deleted' : 'modified';
}
function countChangedLines(hunks) {
    let additions = 0;
    let deletions = 0;
    for (const hunk of hunks) {
        for (const line of hunk.lines) {
            if (line.startsWith('+'))
                additions += 1;
            else if (line.startsWith('-'))
                deletions += 1;
        }
    }
    return { additions, deletions };
}
function renderUnifiedDiff(oldFileName, newFileName, hunks) {
    const lines = [`--- ${oldFileName}`, `+++ ${newFileName}`];
    for (const hunk of hunks) {
        lines.push(`@@ -${hunk.old_start},${hunk.old_lines} +${hunk.new_start},${hunk.new_lines} @@`, ...hunk.lines);
    }
    return `${lines.join('\n')}\n`;
}
//# sourceMappingURL=workspace-change-set.js.map