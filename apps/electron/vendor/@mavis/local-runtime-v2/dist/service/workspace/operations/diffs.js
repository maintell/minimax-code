import { WorkspaceGitSnapshotChangedError } from '../contracts.js';
import { gitDiffArgs, gitDiffScopes } from './changes.js';
import { git, requireGitSuccess } from './git-process.js';
import { isKnownBinaryExtension, readWorkspaceFile } from './filesystem/workspace-path.js';
export async function getWorkspaceFileDiff(manager, workspace, filePath, options = {}) {
    const scope = options.scope ?? 'all';
    const snapshot = await readExpectedSnapshot(manager, workspace, options.snapshotId);
    const hasHead = await resolveHasHead(workspace, snapshot?.value.hasHead);
    const content = await resolveFileContent(workspace, filePath, scope, options.lean === true);
    const diff = requireGitSuccess(await git(gitDiffArgs(scope, hasHead, [filePath]), workspace), 'diff');
    const diffText = diff.stdout.trim() ? diff.stdout : undefined;
    const addedDiff = await maybeBuildAddedFileDiff({
        workspace,
        filePath,
        scope,
        existingDiff: diffText,
    });
    const binary = await detectBinaryFile({ workspace, filePath, scope, existingDiff: diffText });
    assertStillCurrent(manager, workspace, snapshot?.snapshotId);
    return {
        ...content,
        ...(scope !== 'all' ? { changeScope: scope } : {}),
        ...buildPreview(binary, diffText, addedDiff?.diff),
    };
}
export async function listWorkspaceFileDiffs(manager, workspace, options = {}) {
    const scope = options.scope ?? 'all';
    const snapshot = await manager.getChanges(workspace, 'full');
    if (options.snapshotId && options.snapshotId !== snapshot.snapshotId) {
        throw new WorkspaceGitSnapshotChangedError(snapshot.snapshotId);
    }
    const requestedScopes = gitDiffScopes(scope);
    const diffBlocksByScope = new Map();
    await Promise.all(requestedScopes.map(async (diffScope) => {
        const diff = requireGitSuccess(await git(gitBatchDiffArgs(diffScope, snapshot.value.hasHead), workspace), 'diff');
        diffBlocksByScope.set(diffScope, splitDiffBlocksByFile(diff.stdout));
    }));
    const files = snapshot.value.files.filter((file) => Boolean(file.changeScope && requestedScopes.includes(file.changeScope)));
    const untrackedPaths = await listUntrackedWorkspacePaths(workspace);
    const diffs = await Promise.all(files.map((file) => buildWorkspaceFileDiff(workspace, file, diffBlocksByScope, untrackedPaths)));
    assertStillCurrent(manager, workspace, snapshot.snapshotId);
    return { snapshotId: snapshot.snapshotId, diffs };
}
async function buildWorkspaceFileDiff(workspace, file, diffBlocksByScope, untrackedPaths) {
    const block = diffBlocksByScope.get(file.changeScope)?.get(file.path);
    const resolution = {
        workspace,
        filePath: file.path,
        scope: file.changeScope,
        existingDiff: block,
        knownUntrackedPaths: untrackedPaths,
    };
    const addedDiff = await maybeBuildAddedFileDiff(resolution);
    const diffText = block ?? addedDiff?.diff;
    const binary = await detectBinaryFile(resolution);
    return {
        type: binary ? 'binary' : 'text',
        content: '',
        file: file.path,
        ...(file.originalPath ? { originalPath: file.originalPath } : {}),
        additions: file.additions || addedDiff?.additions || 0,
        deletions: file.deletions,
        status: file.status,
        changeScope: file.changeScope,
        ...buildPreview(binary, diffText, undefined, true),
    };
}
async function readExpectedSnapshot(manager, workspace, snapshotId) {
    return snapshotId ? assertSnapshot(manager, workspace, snapshotId) : undefined;
}
async function resolveHasHead(workspace, knownValue) {
    if (knownValue !== undefined)
        return knownValue;
    return (await git(['rev-parse', '--verify', 'HEAD'], workspace)).code === 0;
}
async function resolveFileContent(workspace, filePath, scope, lean) {
    if (lean)
        return { type: 'text', content: '' };
    return readWorkspaceFileForScope(workspace, filePath, scope);
}
async function maybeBuildAddedFileDiff(input) {
    if (input.existingDiff || input.scope === 'staged')
        return undefined;
    return buildAddedFileDiff(input.workspace, input.filePath, input.knownUntrackedPaths);
}
async function detectBinaryFile(input) {
    if (input.existingDiff)
        return isBinaryDiff(input.existingDiff);
    if (input.scope === 'staged')
        return false;
    return isUntrackedBinaryFile(input.workspace, input.filePath, input.knownUntrackedPaths);
}
function buildPreview(binary, diffText, addedDiff, includeNoDiff = false) {
    if (binary)
        return { previewState: 'binary' };
    if (diffText)
        return { diff: diffText, previewState: 'ready' };
    if (addedDiff)
        return { diff: addedDiff, previewState: 'ready' };
    return includeNoDiff ? { previewState: 'no_diff' } : {};
}
export async function getWorkspaceDiffContext(manager, workspace, filePath, options = {}) {
    const snapshot = options.snapshotId
        ? await assertSnapshot(manager, workspace, options.snapshotId)
        : undefined;
    const scope = options.scope ?? 'all';
    const contextContent = scope === 'staged'
        ? await readTextFromGitIndex(workspace, filePath)
        : await readTextForWorkspaceDiff(workspace, filePath);
    assertStillCurrent(manager, workspace, snapshot?.snapshotId);
    if (contextContent === undefined)
        return undefined;
    return {
        contextContent,
        ...(scope === 'staged' || scope === 'unstaged' ? { changeScope: scope } : {}),
    };
}
async function assertSnapshot(manager, workspace, expectedSnapshotId) {
    const snapshot = await manager.getChanges(workspace, 'full');
    if (snapshot.snapshotId !== expectedSnapshotId) {
        throw new WorkspaceGitSnapshotChangedError(snapshot.snapshotId);
    }
    return snapshot;
}
function assertStillCurrent(manager, workspace, snapshotId) {
    if (!snapshotId || manager.isCurrentSnapshot(workspace, snapshotId))
        return;
    throw new WorkspaceGitSnapshotChangedError(manager.currentSnapshotId(workspace));
}
async function readWorkspaceFileForScope(workspace, filePath, scope) {
    if (scope !== 'staged')
        return readWorkspaceFile(workspace, filePath);
    return ((await readWorkspaceTextFileFromGitIndex(workspace, filePath)) ?? {
        type: 'text',
        content: '',
    });
}
async function readWorkspaceTextFileFromGitIndex(workspace, filePath) {
    if (isKnownBinaryExtension(filePath))
        return undefined;
    let normalizedPath;
    try {
        normalizedPath = normalizeGitPath(filePath);
    }
    catch {
        return undefined;
    }
    const result = await git(['show', `:${normalizedPath}`], workspace);
    if (result.code !== 0 || !isTextContent(result.stdout))
        return undefined;
    return { type: 'text', content: result.stdout };
}
async function readTextFromGitIndex(workspace, filePath) {
    const content = await readWorkspaceTextFileFromGitIndex(workspace, filePath);
    return content?.content;
}
async function readTextForWorkspaceDiff(workspace, filePath) {
    const content = await readWorkspaceFile(workspace, filePath);
    return content.type === 'text' && isTextContent(content.content) ? content.content : undefined;
}
async function buildAddedFileDiff(workspace, filePath, knownUntrackedPaths) {
    if (!(knownUntrackedPaths?.has(filePath) ?? (await isUntrackedWorkspacePath(workspace, filePath)))) {
        return undefined;
    }
    const content = await readWorkspaceFile(workspace, filePath);
    if (content.type !== 'text')
        return undefined;
    const lines = content.content.split('\n');
    if (lines.at(-1) === '')
        lines.pop();
    if (lines.length === 0)
        return undefined;
    return {
        additions: lines.length,
        diff: [
            `diff --git a/${filePath} b/${filePath}`,
            'new file mode 100644',
            '--- /dev/null',
            `+++ b/${filePath}`,
            `@@ -0,0 +1,${lines.length} @@`,
            ...lines.map((line) => `+${line}`),
        ].join('\n'),
    };
}
async function isUntrackedBinaryFile(workspace, filePath, knownUntrackedPaths) {
    if (!(knownUntrackedPaths?.has(filePath) ?? (await isUntrackedWorkspacePath(workspace, filePath)))) {
        return false;
    }
    return (await readWorkspaceFile(workspace, filePath)).type === 'binary';
}
async function listUntrackedWorkspacePaths(workspace) {
    const result = requireGitSuccess(await git(['ls-files', '--others', '--exclude-standard', '-z', '--'], workspace), 'ls-files');
    return new Set(result.stdout.split('\0').filter(Boolean));
}
async function isUntrackedWorkspacePath(workspace, filePath) {
    const result = requireGitSuccess(await git(['ls-files', '--others', '-z', '--exclude-standard', '--', filePath], workspace), 'ls-files');
    return result.stdout.split('\0').filter(Boolean).includes(filePath);
}
function splitDiffBlocksByFile(diff) {
    if (diff.length === 0)
        return new Map();
    const rawBoundary = diff.indexOf('\0\0');
    if (rawBoundary < 0)
        throw new Error('Git diff output is missing its raw path boundary');
    const paths = parseRawDiffPaths(diff.slice(0, rawBoundary + 1));
    const patchBlocks = diff
        .slice(rawBoundary + 2)
        .split(/(?=^diff --(?:git|cc|combined) )/mu)
        .filter((block) => block.trim().length > 0);
    if (paths.length !== patchBlocks.length) {
        throw new Error(`Git diff returned ${paths.length} raw paths but ${patchBlocks.length} patch blocks`);
    }
    return new Map(paths.map((filePath, index) => {
        const block = patchBlocks[index];
        return [filePath, block.trimEnd()];
    }));
}
function gitBatchDiffArgs(scope, hasHead) {
    const args = gitDiffArgs(scope, hasHead);
    const pathSeparator = args.indexOf('--');
    args.splice(pathSeparator, 0, '--raw', '-z');
    return args;
}
function parseRawDiffPaths(raw) {
    const records = raw.split('\0');
    const paths = [];
    for (let index = 0; index < records.length; index += 1) {
        const metadata = records[index];
        if (!metadata?.startsWith(':'))
            continue;
        const status = metadata.trim().split(/\s+/u).at(-1);
        const firstPath = records[index + 1];
        if (/^[CR]/u.test(status)) {
            const destinationPath = records[index + 2];
            paths.push(destinationPath);
            index += 2;
        }
        else {
            paths.push(firstPath);
            index += 1;
        }
    }
    return paths;
}
function normalizeGitPath(filePath) {
    const normalized = filePath.trim().replace(/\\/gu, '/');
    // Git emits repo-relative paths; reject POSIX ("/x") and Windows drive
    // ("C:/x") absolute forms plus parent escapes before they reach callers.
    if (!normalized ||
        normalized.includes('\0') ||
        normalized.startsWith('/') ||
        /^[A-Za-z]:/u.test(normalized) ||
        normalized.startsWith('../')) {
        throw new Error(`Invalid git path: ${filePath}`);
    }
    return normalized;
}
function isTextContent(content) {
    return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/u.test(content);
}
function isBinaryDiff(diff) {
    return /^Binary files /mu.test(diff) || /\nGIT binary patch\n/u.test(diff);
}
//# sourceMappingURL=diffs.js.map