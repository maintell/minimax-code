import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
export const IDL_REPO_URL = 'git@gitlab.xaminim.com:weaver/idl.git';
export const DESKTOP_SERVICE_IDL_RELATIVE_PATH = 'matrix/desktop_service/desktop_service.thrift';
export async function resolveDesktopServiceIdlSource(options = {}) {
    const cwd = resolve(options.cwd ?? process.cwd());
    const searchedCandidates = [];
    if (options.explicitIdlDir) {
        const idlDir = resolve(cwd, options.explicitIdlDir);
        return resolveExistingIdlDir('explicit', idlDir, searchedCandidates, options.idlRef);
    }
    const relativeCandidates = findRelativeIdlCandidates(cwd);
    if (!options.idlRef) {
        for (const candidate of relativeCandidates) {
            searchedCandidates.push(candidate);
            if (hasDesktopServiceIdl(candidate)) {
                return resolveExistingIdlDir('relative', candidate, searchedCandidates);
            }
        }
    }
    const cloneDir = await createCloneDir(options.tmpRoot);
    const cloneIdlRepo = options.cloneIdlRepo ?? gitCloneIdlRepo;
    await cloneIdlRepo({ repoUrl: IDL_REPO_URL, targetDir: cloneDir, ref: options.idlRef });
    return resolveExistingIdlDir('clone', cloneDir, searchedCandidates, options.idlRef);
}
export function findRelativeIdlCandidates(cwd) {
    const candidates = [];
    const seen = new Set();
    const addCandidate = (candidate) => {
        const normalized = resolve(candidate);
        if (seen.has(normalized))
            return;
        seen.add(normalized);
        candidates.push(normalized);
    };
    for (const dir of ancestorDirs(cwd)) {
        addCandidate(join(dir, 'weaver/idl'));
        addCandidate(join(dir, '../weaver/idl'));
        addCandidate(join(dir, '../../weaver/idl'));
        addCandidate(join(dir, '../../../weaver/idl'));
        addCandidate(join(dir, '../../../../weaver/idl'));
    }
    return candidates;
}
function resolveExistingIdlDir(source, idlDir, searchedCandidates, ref) {
    const idlFile = join(idlDir, DESKTOP_SERVICE_IDL_RELATIVE_PATH);
    if (!existsSync(idlFile)) {
        throw new Error(`Desktop service IDL not found at ${idlFile}. Expected ${DESKTOP_SERVICE_IDL_RELATIVE_PATH} under the IDL repo root.`);
    }
    return { source, idlDir, idlFile, searchedCandidates, ref };
}
function hasDesktopServiceIdl(idlDir) {
    return existsSync(join(idlDir, DESKTOP_SERVICE_IDL_RELATIVE_PATH));
}
async function createCloneDir(tmpRoot) {
    const root = tmpRoot ? resolve(tmpRoot) : tmpdir();
    return mkdtemp(join(root, 'mavis-thrift-gen-idl-'));
}
async function gitCloneIdlRepo(params) {
    await runCommand('git', ['clone', params.repoUrl, params.targetDir]);
    if (params.ref) {
        await runCommand('git', ['-C', params.targetDir, 'checkout', params.ref]);
    }
}
async function runCommand(command, args) {
    await new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: {
                ...process.env,
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_CONFIG_SYSTEM: '/dev/null',
            },
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolvePromise();
                return;
            }
            reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}: ${stderr.trim()}`));
        });
    });
}
function ancestorDirs(start) {
    const dirs = [];
    let current = resolve(start);
    while (true) {
        dirs.push(current);
        const parent = dirname(current);
        if (parent === current)
            return dirs;
        current = parent;
    }
}
//# sourceMappingURL=idl-source.js.map