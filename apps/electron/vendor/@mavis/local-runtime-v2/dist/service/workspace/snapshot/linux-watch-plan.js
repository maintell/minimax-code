import { lstat, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { git } from '../operations/git-process.js';
const ADMIN_FILES = [
    'HEAD',
    'ORIG_HEAD',
    'FETCH_HEAD',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'REBASE_HEAD',
    'index',
    'packed-refs',
    'config',
    'config.worktree',
    'commondir',
    'gitdir',
];
const ADMIN_TREES = ['refs', 'rebase-apply', 'rebase-merge', 'sequencer'];
const BATCH_SIZE = 128;
/** Each directory is registered BEFORE enumeration; concurrent topology changes cause another pass. */
export async function buildLinuxWatchPlan(workspace, visit, signal) {
    if (!(await visit(workspace, { kind: 'control', name: '.git' })))
        throw layoutUnavailable();
    const layout = await readLayout(workspace, signal);
    if (!layout)
        return;
    const { root, gitDir, commonDir } = layout;
    if (!(await visit(root, { kind: 'workspace', root })))
        throw layoutUnavailable();
    for (const directory of new Set([gitDir, commonDir])) {
        await watchAdministrativeDirectories(directory, visit);
    }
    await watchGitConfiguration(root, visit, signal);
    const trackedDirectories = await readTrackedDirectories(root, signal);
    await walkWorkspace(root, {
        trackedDirectories,
        administrativeDirectories: new Set([resolve(gitDir), resolve(commonDir)]),
    }, visit, signal);
}
async function readLayout(workspace, signal) {
    const repository = await git(['rev-parse', '--is-inside-work-tree'], workspace, { signal });
    if (repository.code !== 0) {
        // Only an absent repository is a trustworthy root-only observation mode.
        if (repository.stderr.includes('not a git repository') && !(await hasGitMarker(workspace)))
            return undefined;
        throw layoutUnavailable();
    }
    const layout = await git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], workspace, { signal });
    const [root, gitDir, commonDir, ...extra] = layout.stdout.trimEnd().split('\n');
    if (layout.code !== 0 || !root || !gitDir || !commonDir || extra.length) {
        throw layoutUnavailable();
    }
    return { root, gitDir, commonDir };
}
function layoutUnavailable() {
    return Object.assign(new Error('Git administrative directory unavailable'), {
        code: 'GIT_LAYOUT_UNAVAILABLE',
    });
}
async function hasGitMarker(workspace) {
    let directory = workspace;
    for (;;) {
        if (await exists(join(directory, '.git')))
            return true;
        const parent = dirname(directory);
        if (parent === directory)
            return false;
        directory = parent;
    }
}
async function watchAdministrativeDirectories(directory, visit) {
    if (!(await visit(directory, {
        kind: 'repository',
        names: [...ADMIN_FILES, ...ADMIN_TREES, 'info'],
    }))) {
        throw layoutUnavailable();
    }
    await visit(join(directory, 'info'), { kind: 'repository', names: ['exclude'] });
    for (const tree of ADMIN_TREES)
        await walkAdministrativeTree(join(directory, tree), visit);
}
async function readTrackedDirectories(root, signal) {
    const tracked = await git(['ls-files', '--cached', '-z'], root, { signal });
    if (tracked.code !== 0)
        throw new Error('Cannot read tracked paths for Linux watcher');
    const trackedDirectories = new Set();
    for (const file of tracked.stdout.split('\0')) {
        if (!file)
            continue;
        // Including the leaf also protects a tracked gitlink (submodule directory).
        let path = file;
        while (path !== '.') {
            trackedDirectories.add(path);
            const slash = path.lastIndexOf('/');
            path = slash < 0 ? '.' : path.slice(0, slash);
        }
    }
    return trackedDirectories;
}
async function walkWorkspace(root, scope, visit, signal) {
    const { trackedDirectories, administrativeDirectories } = scope;
    const queue = await childDirectories(root);
    while (queue.length) {
        const batch = queue
            .splice(0, BATCH_SIZE)
            .filter((directory) => !administrativeDirectories.has(resolve(directory)));
        const paths = batch.map((directory) => ({
            directory,
            path: relative(root, directory).split(sep).join('/'),
        }));
        const candidates = paths
            .map(({ path }) => path)
            .filter((path) => !trackedDirectories.has(path));
        const ignored = await ignoredDirectories(root, candidates, signal);
        for (const { directory, path } of paths) {
            if (ignored.has(path))
                continue;
            if (!(await visit(directory, { kind: 'workspace', root })))
                continue;
            // Submodules and nested repositories need their own index/ignore policy
            // and administrative watches, rather than their parent's ignore rules.
            if (await exists(join(directory, '.git'))) {
                await buildLinuxWatchPlan(directory, visit, signal);
            }
            else {
                queue.push(...(await childDirectories(directory)));
            }
        }
    }
}
async function ignoredDirectories(root, paths, signal) {
    if (!paths.length)
        return new Set();
    const result = await git(['check-ignore', '--stdin', '-z'], root, {
        input: paths.map((path) => `${path}/\0`).join(''),
        signal,
    });
    if (result.code !== 0 && result.code !== 1) {
        throw new Error('Cannot classify Git ignored directories for Linux watcher');
    }
    return new Set(result.stdout
        .split('\0')
        .filter(Boolean)
        .map((path) => path.replace(/\/$/u, '')));
}
async function childDirectories(directory) {
    try {
        return (await readdir(directory, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && entry.name !== '.git')
            .map((entry) => join(directory, entry.name));
    }
    catch (error) {
        if (isMissing(error))
            return [];
        throw error;
    }
}
async function walkAdministrativeTree(directory, visit) {
    const queue = [directory];
    while (queue.length) {
        const next = queue.pop();
        if (!next)
            break;
        if (await visit(next, { kind: 'repository' }))
            queue.push(...(await childDirectories(next)));
    }
}
async function watchGitConfiguration(root, visit, signal) {
    const config = await git(['config', '--show-origin', '--null', '--list'], root, { signal });
    if (config.code !== 0)
        throw new Error('Cannot read Git ignore configuration');
    const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const files = configurationFiles(root, config.stdout);
    files.add(join(homedir(), '.gitconfig'));
    files.add(join(xdg, 'git', 'config'));
    files.add(await excludesFile(root, xdg, signal));
    for (const file of files)
        await watchControlFile(file, visit);
    const checked = await git(['config', '--show-origin', '--null', '--list'], root, { signal });
    if (checked.code !== 0 || checked.stdout !== config.stdout) {
        throw new Error('Git configuration changed while establishing coverage');
    }
}
function configurationFiles(root, output) {
    const files = new Set();
    const fields = output.split('\0');
    for (let index = 0; index + 1 < fields.length; index += 2) {
        const origin = fields[index] ?? '';
        if (!origin.startsWith('file:'))
            continue;
        const file = resolve(root, origin.slice(5));
        files.add(file);
        const entry = fields[index + 1] ?? '';
        const newline = entry.indexOf('\n');
        const key = entry.slice(0, newline).toLowerCase();
        if (key === 'include.path' || (key.startsWith('includeif.') && key.endsWith('.path'))) {
            const value = entry.slice(newline + 1);
            files.add(value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(dirname(file), value));
        }
    }
    return files;
}
async function excludesFile(root, xdg, signal) {
    const excludes = await git(['config', '--null', '--path', '--get', 'core.excludesFile'], root, {
        signal,
    });
    if (excludes.code !== 0 && excludes.code !== 1)
        throw new Error('Cannot read Git excludes file');
    const excludePath = excludes.stdout.replace(/\0$/u, '');
    if (excludes.code !== 0 || !excludePath)
        return join(xdg, 'git', 'ignore');
    return isAbsolute(excludePath) ? excludePath : resolve(root, excludePath);
}
async function watchControlFile(file, visit) {
    await watchControlParent(file, visit);
    try {
        const physical = await realpath(file);
        if (resolve(file) !== physical)
            await watchControlParent(physical, visit);
    }
    catch (error) {
        if (!isMissing(error))
            throw error;
    }
}
async function watchControlParent(file, visit) {
    let child = file;
    let parent = dirname(child);
    while (!(await visit(parent, { kind: 'control', name: basename(child) }))) {
        if (dirname(parent) === parent)
            throw new Error('Cannot observe Git control path');
        child = parent;
        parent = dirname(parent);
    }
}
export function isMissing(error) {
    return (error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR'));
}
async function exists(path) {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        if (isMissing(error))
            return false;
        throw error;
    }
}
//# sourceMappingURL=linux-watch-plan.js.map