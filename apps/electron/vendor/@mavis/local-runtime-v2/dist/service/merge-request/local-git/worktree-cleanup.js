import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { commitExists, countCommits, gitFailureMessage, isCommitSha, runGit, } from './git-command.js';
const MEASURE_BUDGET_MS = 1_000;
/** Stops counting a tree this large even when the clock still allows it. */
const MEASURE_MAX_ENTRIES = 200_000;
const MEASURE_BATCH = 256;
/** Removing a worktree deletes its build output too; this only guards against a hung git. */
const REMOVE_TIMEOUT_MS = 10 * 60_000;
/** How far up parentSessionId to look for the Session that owns a subagent or side chat. */
const MAX_OWNER_DEPTH = 16;
/**
 * Removes the worktree a Session works in, and its local branch, once the
 * merge request is merged. Unlike the worktree list in Settings, which never
 * removes a worktree a Session uses, this removes exactly the asking Session's
 * own worktree, and only while that Session is idle and nothing would be lost.
 */
export class WorktreeCleanup {
    options;
    constructor(options) {
        this.options = options;
    }
    /** Checks every condition and reports each one that fails; never throws. */
    async prepare(target) {
        try {
            return await this.inspect(target);
        }
        catch (error) {
            return {
                plan: {
                    available: false,
                    issues: [
                        { blocker: 'other', message: error instanceof Error ? error.message : String(error) },
                    ],
                },
            };
        }
    }
    /** Removes the worktree, then the branch; the Session itself is kept. */
    async remove(prepared) {
        const { plan, mainCheckout } = prepared;
        if (!plan.available || !mainCheckout || !plan.worktreePath || !plan.branch) {
            return { worktreeRemoved: false, branchDeleted: false, issues: plan.issues };
        }
        // Without --force git refuses a worktree that gained changes or a lock since the plan was made.
        const removed = await runGit(this.options.git, ['worktree', 'remove', '--', plan.worktreePath], mainCheckout, REMOVE_TIMEOUT_MS);
        if (removed.code !== 0) {
            return {
                worktreeRemoved: false,
                branchDeleted: false,
                issues: [
                    { blocker: 'other', message: gitFailureMessage(removed, 'git worktree remove failed') },
                ],
            };
        }
        // -D because a squash or rebase merge leaves the branch unmerged in git's eyes; the
        // plan already checked that it holds nothing the merge request does not.
        const deleted = await runGit(this.options.git, ['branch', '-D', plan.branch], mainCheckout);
        if (deleted.code !== 0) {
            return {
                worktreeRemoved: true,
                branchDeleted: false,
                issues: [{ blocker: 'other', message: gitFailureMessage(deleted, 'git branch -D failed') }],
            };
        }
        return { worktreeRemoved: true, branchDeleted: true };
    }
    async inspect(target) {
        const located = await this.locate(target.workspaceDir);
        if ('message' in located)
            return unavailable(located.message);
        const { own, main, root } = located;
        const roots = await worktreeRoots(own.path, root, target.workspaceDir);
        const [status, unpushed, sessions] = await Promise.all([
            runGit(this.options.git, ['status', '--porcelain'], own.path),
            this.unpushedCommits(own.path, target.headSha),
            // A Session in any directory inside the worktree loses that directory with it.
            this.options.sessionsWithin(roots),
        ]);
        const issues = [
            ...checkoutIssues(own, main, target.branch),
            ...sessionIssues(target.sessionId, sessions),
            ...statusIssues(status),
            ...unpushedIssues(unpushed),
            ...lockIssues(own),
        ];
        const available = issues.length === 0;
        const sizeBytes = available ? await this.measure(own.path) : undefined;
        return {
            plan: {
                available,
                worktreePath: resolve(own.path),
                ...(own.branch ? { branch: own.branch } : {}),
                issues,
                ...(sizeBytes !== undefined ? { sizeBytes } : {}),
            },
            mainCheckout: main.path,
        };
    }
    /** The worktree a directory belongs to, and the repository's main checkout. */
    async locate(workspaceDir) {
        const { git } = this.options;
        const top = await runGit(git, ['rev-parse', '--show-toplevel'], workspaceDir);
        if (top.code !== 0) {
            return { message: gitFailureMessage(top, 'The Session directory is not a git repository') };
        }
        const root = top.stdout.trim();
        const listed = await runGit(git, ['worktree', 'list', '--porcelain'], root);
        if (listed.code !== 0) {
            return { message: gitFailureMessage(listed, "The repository's worktrees could not be read") };
        }
        const entries = parseWorktreeList(listed.stdout);
        const own = await findEntry(entries, root);
        const main = entries[0];
        if (!own || !main)
            return { message: "The Session directory is not one of the repository's worktrees" };
        return { own, main, root };
    }
    /**
     * Local commits the merge request lacks. Counted against its head when that
     * commit is here; otherwise every commit no remote branch has counts.
     */
    async unpushedCommits(worktree, headSha) {
        const { git } = this.options;
        if (isCommitSha(headSha) && (await commitExists(git, worktree, headSha))) {
            return countCommits(git, worktree, [`${headSha}..HEAD`]);
        }
        return countCommits(git, worktree, ['HEAD', '--not', '--remotes']);
    }
    /**
     * Disk space the worktree takes, when it can be counted within the budget;
     * undefined for a tree too large to count quickly. Symbolic links count as
     * links: removing the worktree does not touch what they point to.
     */
    async measure(root) {
        const deadline = this.options.nowMs() + (this.options.measureBudgetMs ?? MEASURE_BUDGET_MS);
        const pending = [root];
        let total = 0;
        let entries = 0;
        while (pending.length > 0) {
            if (this.options.nowMs() > deadline || entries > MEASURE_MAX_ENTRIES)
                return undefined;
            const listed = await listDirectory(pending.pop() ?? root);
            if (!listed)
                return undefined;
            entries += listed.count;
            for (const directory of listed.directories)
                pending.push(directory);
            total += await totalSize(listed.files);
        }
        return total;
    }
}
function unavailable(message) {
    return { plan: { available: false, issues: [{ blocker: 'other', message }] } };
}
function checkoutIssues(own, main, branch) {
    const issues = [];
    if (own === main)
        issues.push({ blocker: 'main_checkout' });
    if (!branch || own.branch !== branch) {
        issues.push({
            blocker: 'branch_not_checked_out',
            message: own.branch ? `${own.branch} is checked out` : 'The worktree has a detached HEAD',
        });
    }
    return issues;
}
function statusIssues(status) {
    if (status.code !== 0) {
        return [{ blocker: 'other', message: gitFailureMessage(status, 'git status failed') }];
    }
    const changed = status.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    return changed.length > 0 ? [{ blocker: 'uncommitted_changes', count: changed.length }] : [];
}
function unpushedIssues(count) {
    if (count === undefined) {
        return [{ blocker: 'other', message: 'The local commits could not be compared' }];
    }
    return count > 0 ? [{ blocker: 'unpushed_commits', count }] : [];
}
function lockIssues(entry) {
    if (!entry.locked)
        return [];
    return [
        {
            blocker: 'other',
            message: entry.lockReason
                ? `The worktree is locked: ${entry.lockReason}`
                : 'The worktree is locked',
        },
    ];
}
async function listDirectory(directory) {
    let children;
    try {
        children = await readdir(directory, { withFileTypes: true });
    }
    catch {
        return undefined;
    }
    const directories = [];
    const files = [];
    for (const child of children) {
        (child.isDirectory() ? directories : files).push(join(directory, child.name));
    }
    return { count: children.length, directories, files };
}
async function totalSize(files) {
    let total = 0;
    for (let start = 0; start < files.length; start += MEASURE_BATCH) {
        const sizes = await Promise.all(files.slice(start, start + MEASURE_BATCH).map(sizeOf));
        for (const size of sizes)
            total += size;
    }
    return total;
}
async function sizeOf(path) {
    try {
        return (await lstat(path)).size;
    }
    catch {
        return 0;
    }
}
/** Entries of `git worktree list --porcelain`; the first one is the main checkout. */
function parseWorktreeList(output) {
    return output
        .split(/\r?\n\r?\n/u)
        .map((block) => block.split(/\r?\n/u).filter((line) => line.length > 0))
        .flatMap((lines) => {
        const path = valueOf(lines, 'worktree');
        if (!path)
            return [];
        const branch = valueOf(lines, 'branch')?.replace(/^refs\/heads\//u, '');
        const lock = lines.find((line) => line === 'locked' || line.startsWith('locked '));
        const lockReason = lock?.slice('locked'.length).trim();
        return [
            {
                path,
                ...(branch ? { branch } : {}),
                locked: lock !== undefined,
                ...(lockReason ? { lockReason } : {}),
            },
        ];
    });
}
function valueOf(lines, key) {
    const line = lines.find((candidate) => candidate.startsWith(`${key} `));
    return line?.slice(key.length + 1);
}
/** The entry of the worktree at `path`, compared after resolving links and separators. */
async function findEntry(entries, path) {
    const wanted = await canonical(path);
    for (const entry of entries) {
        if ((await canonical(entry.path)) === wanted)
            return entry;
    }
    return undefined;
}
/**
 * The worktree's root as git lists it, as git resolves it, and as the Session
 * spelled it. A path through a symbolic link names the same worktree, and
 * other Sessions may have stored that spelling.
 */
async function worktreeRoots(listed, resolved, workspaceDir) {
    const wanted = await canonical(listed);
    const roots = new Set([listed, resolved]);
    for (let directory = resolve(workspaceDir);; directory = dirname(directory)) {
        if ((await canonical(directory)) === wanted) {
            roots.add(directory);
            break;
        }
        if (dirname(directory) === directory)
            break;
    }
    return [...roots];
}
async function canonical(path) {
    try {
        return await realpath(path);
    }
    catch {
        return resolve(path);
    }
}
/**
 * The asking Session owns its subagents and side chats: they run in its
 * directory and stop with it. A running one keeps the worktree as the Session's
 * own Turn would. Every other Session in the directory counts once, under the
 * Session the user sees it as.
 */
function sessionIssues(sessionId, sessions) {
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    const chainOf = (session) => {
        const chain = [session.sessionId];
        let current = session;
        for (let depth = 0; current && depth < MAX_OWNER_DEPTH; depth += 1) {
            const owner = current.parentSessionId ?? current.sideChatOf;
            if (!owner || chain.includes(owner))
                break;
            chain.push(owner);
            current = byId.get(owner);
        }
        return chain;
    };
    let running = false;
    const others = new Set();
    for (const session of sessions) {
        const chain = chainOf(session);
        if (chain.includes(sessionId))
            running ||= session.running;
        else
            others.add(chain.at(-1) ?? session.sessionId);
    }
    const issues = [];
    if (running)
        issues.push({ blocker: 'session_running' });
    if (others.size > 0)
        issues.push({ blocker: 'other_sessions', count: others.size });
    return issues;
}
//# sourceMappingURL=worktree-cleanup.js.map