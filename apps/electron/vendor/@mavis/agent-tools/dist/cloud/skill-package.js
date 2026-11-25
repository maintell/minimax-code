/**
 * skill 包的纯函数：tree hash、内存解析 tar.gz、SKILL.md frontmatter。
 *
 * tree hash 与 AS PrepareUpsertSkill 的 content_hash 同一格式：
 * 文件相对路径按 localeCompare 排序，逐行 `rel:sha256hex`，再整体取 sha256，前缀 `sha256:`。
 * v1 cloud-runtime syncer 与 v2 cloud-harness-server 共用。
 */
import { createHash } from 'node:crypto';
import { Parser } from 'tar';
const ARCHIVE_FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);
export function combineSkillTreeHash(files) {
    const combined = [...files]
        .sort((a, b) => a.rel.localeCompare(b.rel))
        .map((file) => `${file.rel}:${file.sha256}`)
        .join('\n');
    return `sha256:${createHash('sha256').update(combined, 'utf-8').digest('hex')}`;
}
/** 在内存里解析 skill tar.gz；同一路径出现多次时以最后一个为准（与解压结果一致）。 */
export function readSkillArchive(archive) {
    return new Promise((resolve, reject) => {
        const hashes = new Map();
        let skillMd = null;
        const onReadEntry = (entry) => {
            const rel = normalizeArchivePath(entry.path);
            if (!rel || !ARCHIVE_FILE_TYPES.has(entry.type)) {
                entry.resume();
                return;
            }
            const hash = createHash('sha256');
            const chunks = [];
            entry.on('data', (chunk) => {
                hash.update(chunk);
                if (rel === 'SKILL.md')
                    chunks.push(chunk);
            });
            entry.on('end', () => {
                hashes.set(rel, hash.digest('hex'));
                if (rel === 'SKILL.md')
                    skillMd = Buffer.concat(chunks).toString('utf-8');
            });
        };
        const parser = new Parser({ strict: true, onReadEntry });
        parser.on('error', reject);
        parser.on('close', () => {
            const files = [...hashes].map(([rel, sha256]) => ({ rel, sha256 }));
            resolve({ skillMd, treeHash: combineSkillTreeHash(files) });
        });
        parser.end(Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength));
    });
}
function normalizeArchivePath(path) {
    return path.replace(/^(?:\.?\/)+/u, '').replace(/\/+$/u, '');
}
/** 从 SKILL.md YAML frontmatter 取 `name` / `description`；支持 `|` / `>` 块标量。 */
export function extractSkillFrontmatter(content) {
    const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!fmMatch?.[1])
        return { name: '', description: '' };
    const fm = fmMatch[1];
    const nameMatch = /^name:\s*(.+)$/m.exec(fm);
    const descMatch = /^description:\s*(.+)$/m.exec(fm);
    return {
        name: nameMatch?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '',
        description: descMatch?.[1] ? frontmatterDescription(fm, descMatch) : '',
    };
}
function frontmatterDescription(fm, descMatch) {
    const val = (descMatch[1] ?? '').trim();
    if (!/^[|>][+-]?$/.test(val))
        return val.replace(/^["']|["']$/g, '');
    // YAML 块标量：收集缩进的续行
    const afterDesc = fm.slice(fm.indexOf(descMatch[0]) + descMatch[0].length);
    const lines = [];
    for (const line of afterDesc.split(/\r?\n/)) {
        if (/^\s+\S/.test(line)) {
            lines.push(line.trim());
        }
        else if (line.trim() === '') {
            if (lines.length > 0)
                lines.push('');
        }
        else {
            break;
        }
    }
    return lines
        .join(' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}
//# sourceMappingURL=skill-package.js.map