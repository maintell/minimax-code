import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import * as tar from 'tar';
const FRONT_MATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
export function formatSkillContent(name, content, location) {
    const stripped = content.replace(FRONT_MATTER_RE, '').trim();
    return [
        `<skill_content name="${name}">`,
        `# Skill: ${name}`,
        '',
        stripped,
        '',
        `Base directory for this skill: ${location}`,
        'Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.',
        '',
        '<!-- <skill_files> placeholder: file listing will be populated in a future release -->',
        '</skill_content>',
    ].join('\n');
}
export async function resolveSkillContent(name, deps) {
    const { log, registryStore, ossClient, skillsDir } = deps;
    const localSkillMd = join(skillsDir, name, 'SKILL.md');
    try {
        await access(localSkillMd);
        return await readFile(localSkillMd, 'utf-8');
    }
    catch {
        log.debug('skill not on local disk, checking registry', { name, path: localSkillMd });
    }
    const registry = await registryStore.load();
    const entry = registry.entries[name];
    if (!entry?.data_oss_key)
        return null;
    const targetDir = join(skillsDir, name);
    try {
        const buffer = await ossClient.get(ossClient.defaultBucket, entry.data_oss_key);
        await mkdir(targetDir, { recursive: true });
        await extractTarGz(buffer, targetDir);
    }
    catch (err) {
        log.error('failed to download/extract skill from OSS', { name, error: err });
        await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
        return null;
    }
    try {
        const content = await readFile(localSkillMd, 'utf-8');
        await registryStore.markLoaded(name, await hashDirectory(targetDir));
        return content;
    }
    catch (err) {
        log.error('SKILL.md not found after extraction', { name, path: localSkillMd, error: err });
        return null;
    }
}
async function extractTarGz(buffer, targetDir) {
    await pipeline(Readable.from(buffer), zlib.createGunzip(), tar.extract({ cwd: targetDir }));
}
async function hashDirectory(dir) {
    const hash = createHash('sha256');
    const root = resolve(dir);
    async function visit(current) {
        const entries = await readdir(current, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const path = join(current, entry.name);
            const rel = path.slice(root.length + 1);
            if (entry.isDirectory()) {
                await visit(path);
                continue;
            }
            if (!entry.isFile())
                continue;
            const st = await stat(path);
            hash.update(rel);
            hash.update(String(st.size));
            hash.update(await readFile(path));
        }
    }
    await visit(root);
    return hash.digest('hex');
}
//# sourceMappingURL=skill-reader.js.map