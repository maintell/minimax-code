import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { json } from '../api/host-helpers.js';
import { applyLocalTurnDiffSnapshotMutation } from './file-changes.js';
const execFile = promisify(execFileCallback);
// Read paths and metrics as NUL records; patch headers are presentation only.
const WORKSPACE_DIFF_ARGS = [
    '--raw',
    '--numstat',
    '-z',
    '--patch',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
];
export async function readLocalSessionDiff(input) {
    const record = input.messageId
        ? await input.diffStore.getByAssistantMessage(input.session.sessionId, input.messageId)
        : await input.diffStore.latestForSession(input.session.sessionId);
    if (record)
        return { diffs: record.fileChanges, changeSetId: record.changeSetId };
    const live = await readWorkspaceDiff(input.session.workspaceDir);
    return { diffs: live.fileChanges };
}
export async function readLocalTurnDiff(input) {
    const record = await findTurnDiffRecord(input.diffStore, input.sessionId, input.selector ?? {});
    if (!record)
        return { fileChanges: [] };
    const latest = await input.diffStore.latestForSession(input.sessionId);
    return serializeTurnDiffRecord(record, latest?.changeSetId === record.changeSetId);
}
export async function mutateLocalTurnDiff(input) {
    const record = await findTurnDiffRecord(input.diffStore, input.sessionId, input.selector ?? {});
    if (!record) {
        return { status: 404, body: { success: false, error: 'Turn diff not found' } };
    }
    if (input.action === 'revert' && record.status === 'reverted') {
        return { status: 200, body: { success: true, ...serializeTurnDiffRecord(record, true) } };
    }
    if (input.action === 'reapply' && record.status === 'active') {
        return { status: 200, body: { success: true, ...serializeTurnDiffRecord(record, true) } };
    }
    const latest = await input.diffStore.latestForSession(input.sessionId);
    if (latest?.changeSetId !== record.changeSetId) {
        return {
            status: 409,
            body: { success: false, error: 'Only the latest turn diff can be changed' },
        };
    }
    const result = await applyTurnDiffMutation(record, input.action);
    if (!result.ok) {
        return { status: 409, body: { success: false, error: result.error } };
    }
    const updated = await input.diffStore.updateStatus(input.sessionId, record.changeSetId, input.action === 'revert' ? 'reverted' : 'active', input.action === 'revert' ? input.nowMs() : undefined);
    return {
        status: 200,
        body: { success: true, ...serializeTurnDiffRecord(updated ?? record, true) },
    };
}
export async function routeLocalSessionDiffApi(input) {
    const messageId = input.url.searchParams.get('messageID') ??
        input.url.searchParams.get('messageId') ??
        input.url.searchParams.get('assistantMessageId');
    return json(await readLocalSessionDiff({
        diffStore: input.diffStore,
        session: input.session,
        ...(messageId ? { messageId } : {}),
    }));
}
export async function routeLocalTurnDiffApi(input) {
    const result = await readLocalTurnDiff({
        diffStore: input.diffStore,
        sessionId: input.session.sessionId,
        selector: readTurnDiffSelector(input.url.searchParams),
    });
    return json(toLegacyTurnDiffBody(result));
}
export async function routeLocalTurnDiffMutationApi(input) {
    const result = await mutateLocalTurnDiff({
        diffStore: input.diffStore,
        sessionId: input.session.sessionId,
        selector: readTurnDiffSelector(input.body),
        action: input.action,
        nowMs: input.nowMs,
    });
    return json(toLegacyTurnDiffBody(result.body), { status: result.status });
}
async function applyTurnDiffMutation(record, action) {
    if (record.undoable && record.undo?.length) {
        const result = await applyLocalTurnDiffSnapshotMutation(record, action);
        return result.success
            ? { ok: true }
            : { ok: false, error: result.reason ?? 'Turn diff conflict' };
    }
    if (!record.rawDiff)
        return { ok: false, error: 'Turn diff is not undoable' };
    return applyGitPatch({
        cwd: record.workspaceDir,
        patch: record.rawDiff,
        reverse: action === 'revert',
    });
}
function serializeTurnDiffRecord(record, isLatest) {
    const undoable = record.undoable === true || Boolean(record.rawDiff);
    return {
        fileChanges: record.fileChanges,
        sourceMessageId: record.assistantMessageId,
        changeSetId: record.changeSetId,
        status: record.status,
        revertedAt: record.revertedAt,
        undoable,
        canUndo: undoable && isLatest && record.status === 'active',
        canReapply: undoable && isLatest && record.status === 'reverted',
    };
}
async function findTurnDiffRecord(store, sessionId, selector) {
    if (selector.changeSetId)
        return store.getByChangeSetId(sessionId, selector.changeSetId);
    if (selector.assistantMessageId) {
        return store.getByAssistantMessage(sessionId, selector.assistantMessageId);
    }
    if (selector.turnId)
        return store.getByTurn(sessionId, selector.turnId);
    return store.latestForSession(sessionId);
}
function readTurnDiffSelector(source) {
    const read = (key) => {
        if (source instanceof URLSearchParams)
            return source.get(key) ?? undefined;
        return typeof source[key] === 'string' ? source[key] : undefined;
    };
    const assistantMessageId = read('assistantMessageId') ?? read('messageId') ?? read('messageID');
    return {
        ...(read('changeSetId') ? { changeSetId: read('changeSetId') } : {}),
        ...(assistantMessageId ? { assistantMessageId } : {}),
        ...(read('turnId') ? { turnId: read('turnId') } : {}),
    };
}
function toLegacyTurnDiffBody(view) {
    const { fileChanges, ...rest } = view;
    return {
        ...rest,
        ...(fileChanges ? { file_changes: fileChanges } : {}),
    };
}
async function readWorkspaceDiff(workspaceDir) {
    try {
        const result = await execGit(['diff', 'HEAD', ...WORKSPACE_DIFF_ARGS, '--'], workspaceDir);
        const trackedDiffs = parseGitDiffSummary(result.stdout);
        const untracked = await readUntrackedFiles(workspaceDir);
        const untrackedDiffs = await Promise.all(untracked.map((file) => readUntrackedFileDiff(workspaceDir, file)));
        const raw = [
            ...trackedDiffs.flatMap((item) => item.diff ?? []),
            ...untrackedDiffs.flatMap((item) => item.rawDiff ?? []),
        ]
            .filter(Boolean)
            .join('\n');
        const fileChanges = [...trackedDiffs, ...untrackedDiffs.map((item) => item.fileChange)];
        return { fileChanges, ...(raw ? { rawDiff: raw } : {}) };
    }
    catch {
        return { fileChanges: [] };
    }
}
async function execGit(args, cwd) {
    return execFile('git', args, {
        cwd,
        env: cleanGitEnv(),
        maxBuffer: 10 * 1024 * 1024,
    });
}
function parseGitDiffSummary(output) {
    if (!output)
        return [];
    // --raw --numstat -z --patch emits raw records, then numstat records,
    // then an extra NUL before the patches. Git uses the same order for raw
    // records and patch blocks, including rename-only and binary changes. A
    // type change has two consecutive patches: remove the old type, add the new.
    const boundary = output.indexOf('\0\0');
    if (boundary < 0)
        throw new Error('Git diff is missing its patch boundary');
    const records = output.slice(0, boundary).split('\0');
    const files = [];
    let index = 0;
    while (records[index]?.startsWith(':')) {
        const status = records[index++].split(' ').at(-1);
        const source = records[index++];
        const file = /^[RC]/u.test(status) ? records[index++] : source;
        if (!file)
            throw new Error('Git diff is missing a raw path');
        files.push({ file, status: mapGitStatus(status), patchCount: status[0] === 'T' ? 2 : 1 });
    }
    const stats = new Map();
    while (index < records.length) {
        const [additions, deletions, ...pathParts] = records[index++].split('\t');
        let file = pathParts.join('\t');
        // Renames/copies have an empty numstat path followed by old and new paths.
        if (!file) {
            index += 1;
            file = records[index++] ?? '';
        }
        if (!file)
            throw new Error('Git diff is missing a numstat path');
        const previous = stats.get(file);
        stats.set(file, {
            additions: (previous?.additions ?? 0) + numericDiffStat(additions),
            deletions: (previous?.deletions ?? 0) + numericDiffStat(deletions),
        });
    }
    const patches = output
        .slice(boundary + 2)
        .split(/(?=^diff --git )/mu)
        .filter(Boolean);
    if (files.reduce((count, file) => count + file.patchCount, 0) !== patches.length) {
        throw new Error('Git diff raw paths and patch blocks do not match');
    }
    let patchIndex = 0;
    return files.map(({ file, status, patchCount }) => {
        const stat = stats.get(file);
        if (!stat)
            throw new Error('Git diff is missing file metrics');
        const diff = patches.slice(patchIndex, patchIndex + patchCount).join('');
        patchIndex += patchCount;
        return { file, status, ...stat, diff };
    });
}
async function readUntrackedFiles(workspaceDir) {
    try {
        const result = await execGit(['ls-files', '--others', '--exclude-standard', '-z'], workspaceDir);
        return result.stdout.split('\0').filter(Boolean);
    }
    catch {
        return [];
    }
}
async function readUntrackedFileDiff(workspaceDir, file) {
    try {
        const rawDiff = await execFile('git', ['diff', '--no-index', ...WORKSPACE_DIFF_ARGS, '--', '/dev/null', file], {
            cwd: workspaceDir,
            env: cleanGitEnv(),
            maxBuffer: 10 * 1024 * 1024,
        }).catch((err) => {
            const error = err;
            if (error.code === 1 && typeof error.stdout === 'string')
                return { stdout: error.stdout };
            throw err;
        });
        const parsed = parseGitDiffSummary(rawDiff.stdout)[0];
        if (!parsed)
            throw new Error('Git diff is missing an untracked file');
        return {
            fileChange: { ...parsed, file, status: 'added' },
            ...(parsed.diff ? { rawDiff: parsed.diff } : {}),
        };
    }
    catch {
        return {
            fileChange: {
                file,
                additions: 0,
                deletions: 0,
                status: 'added',
            },
        };
    }
}
function mapGitStatus(status) {
    const code = status?.[0];
    if (code === 'A')
        return 'added';
    if (code === 'D')
        return 'deleted';
    if (code === 'R')
        return 'renamed';
    if (code === 'C')
        return 'copied';
    return 'modified';
}
function numericDiffStat(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function applyGitPatch(input) {
    return new Promise((resolve) => {
        const args = ['apply', '--whitespace=nowarn', ...(input.reverse ? ['--reverse'] : [])];
        const child = spawn('git', args, { cwd: input.cwd, env: cleanGitEnv() });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', (err) => {
            resolve({ ok: false, error: err.message });
        });
        child.on('close', (code) => {
            if (code === 0) {
                resolve({ ok: true });
                return;
            }
            resolve({ ok: false, error: stderr.trim() || `git apply exited with ${String(code)}` });
        });
        child.stdin.end(input.patch);
    });
}
function cleanGitEnv() {
    const env = { ...process.env };
    delete env['GIT_DIR'];
    delete env['GIT_WORK_TREE'];
    delete env['GIT_INDEX_FILE'];
    delete env['GIT_PREFIX'];
    delete env['GIT_OBJECT_DIRECTORY'];
    delete env['GIT_ALTERNATE_OBJECT_DIRECTORIES'];
    return env;
}
//# sourceMappingURL=diff-api.js.map