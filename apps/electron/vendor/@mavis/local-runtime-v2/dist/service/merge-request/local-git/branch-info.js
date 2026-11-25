import { MergeRequestError } from '../contracts.js';
import { commitExists, countCommits, gitFailureMessage, pushRemote, runGit, } from './git-command.js';
/** Commits the create form lists, newest first. */
export const COMMIT_LIST_LIMIT = 20;
/** Enough subjects for a description; a longer branch lists its newest ones. */
const COMMIT_READ_LIMIT = 100;
const PUSH_TIMEOUT_MS = 60_000;
const FIELD = '\u001f';
const RECORD = '\u001e';
/**
 * Reads and pushes the branch a Session works on. Everything except the push
 * reads local refs only, so opening the create form costs no network request;
 * a remote-tracking ref that was never fetched simply reads as missing.
 */
export class LocalBranches {
    git;
    constructor(git) {
        this.git = git;
    }
    async read(workspaceDir, branch, targetBranch) {
        const remote = await pushRemote(this.git, workspaceDir, branch);
        const [needsPush, commits] = await Promise.all([
            this.lacksCommits(workspaceDir, remote, branch),
            this.commitsSince(workspaceDir, remote, targetBranch),
        ]);
        return { needsPush, commits };
    }
    async needsPush(workspaceDir, branch) {
        return this.lacksCommits(workspaceDir, await pushRemote(this.git, workspaceDir, branch), branch);
    }
    /** `git push -u <remote> <branch>`; a failure carries git's own message. */
    async push(workspaceDir, branch) {
        const remote = await pushRemote(this.git, workspaceDir, branch);
        if (!remote) {
            throw new MergeRequestError('MERGE_REQUEST_PUSH_FAILED', 'The repository has no remote to push to');
        }
        // A full refspec cannot be read as an option and names the branch on both sides.
        const result = await runGit(this.git, ['push', '-u', remote, `refs/heads/${branch}:refs/heads/${branch}`], workspaceDir, PUSH_TIMEOUT_MS);
        if (result.code !== 0) {
            throw new MergeRequestError('MERGE_REQUEST_PUSH_FAILED', gitFailureMessage(result, 'git push failed'));
        }
    }
    async lacksCommits(workspaceDir, remote, branch) {
        if (!remote)
            return true;
        const tracking = `refs/remotes/${remote}/${branch}`;
        if (!(await commitExists(this.git, workspaceDir, tracking)))
            return true;
        const ahead = await countCommits(this.git, workspaceDir, [`${tracking}..HEAD`]);
        return ahead === undefined || ahead > 0;
    }
    /** The branch's commits the target lacks, compared with the remote's copy of the target. */
    async commitsSince(workspaceDir, remote, targetBranch) {
        const candidates = [
            ...(remote ? [`refs/remotes/${remote}/${targetBranch}`] : []),
            `refs/heads/${targetBranch}`,
        ];
        let base;
        for (const candidate of candidates) {
            if (await commitExists(this.git, workspaceDir, candidate)) {
                base = candidate;
                break;
            }
        }
        if (!base)
            return [];
        const result = await runGit(this.git, [
            'log',
            `--max-count=${String(COMMIT_READ_LIMIT)}`,
            `--format=%H${FIELD}%an${FIELD}%at${FIELD}%s${FIELD}%b${RECORD}`,
            `${base}..HEAD`,
        ], workspaceDir);
        return result.code === 0 ? parseLog(result.stdout) : [];
    }
}
function parseLog(output) {
    return output.split(RECORD).flatMap((record) => {
        const [sha = '', authorName = '', authoredAt = '', title = '', ...body] = record
            .replace(/^\r?\n/u, '')
            .split(FIELD);
        if (!/^[0-9a-f]{7,64}$/u.test(sha))
            return [];
        const seconds = Number(authoredAt);
        const text = body.join(FIELD).trim();
        return [
            {
                sha,
                title,
                ...(text ? { body: text } : {}),
                ...(authorName ? { authorName } : {}),
                ...(Number.isFinite(seconds) && seconds > 0 ? { authoredAtMs: seconds * 1_000 } : {}),
            },
        ];
    });
}
/**
 * Title and description filled the way `gh pr create --fill` does: one commit
 * gives its subject and body; several give the branch name with dashes and
 * underscores read as spaces, and the subjects oldest first as a list.
 */
export function fillFromCommits(branch, commits) {
    const [only] = commits;
    if (commits.length === 1 && only) {
        return { title: only.title || branch, ...(only.body ? { description: only.body } : {}) };
    }
    const title = branch.replace(/[-_]/gu, ' ');
    if (commits.length === 0)
        return { title };
    const description = [...commits]
        .reverse()
        .map((commit) => `- **${commit.title}**`)
        .join('\n');
    return { title, description };
}
export function toMergeRequestCommit(commit) {
    return {
        sha: commit.sha,
        ...(commit.title ? { title: commit.title } : {}),
        ...(commit.authorName ? { authorName: commit.authorName } : {}),
        ...(commit.authoredAtMs !== undefined ? { authoredAtMs: commit.authoredAtMs } : {}),
    };
}
//# sourceMappingURL=branch-info.js.map