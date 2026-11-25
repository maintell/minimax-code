import { splitCommand, unwrapCommandWrappers } from '@mavis/permission';
import { parseMergeRequestUrl, parseRemoteUrl } from './code-host/urls.js';
/**
 * Finds the merge request an agent command created: "glab mr create" or
 * "gh pr create", recognised from the command text and attributed by the URL
 * the CLI printed. The URL alone names the project, so the command may run in
 * any directory and may name another repository with -R.
 */
export function detectCreatedMergeRequest(command, output) {
    const platform = detectCreatePlatform(command);
    if (!platform)
        return undefined;
    const url = extractMergeRequestUrl(output, platform);
    return url ? parseMergeRequestUrl(url) : undefined;
}
/**
 * Matches the CLI at the start of a command segment, after optional variable
 * assignments, "command" or a path. Anchoring keeps
 * "printf 'gh pr create'" from counting.
 */
const CREATE_INVOCATION = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*(?:command\s+)?(?:\S*\/)?(gh\s+pr|glab\s+mr)\s+create\b/u;
function detectCreatePlatform(command) {
    // The repository's shell splitter handles heredocs, "if ...; then ...", comments
    // and line continuations; unwrap first so "timeout 60 gh pr create" still counts.
    for (const segment of splitCommand(command)) {
        for (const inner of unwrapCommandWrappers(segment)) {
            const match = CREATE_INVOCATION.exec(inner.trim());
            if (match?.[1])
                return match[1].startsWith('gh') ? 'github' : 'gitlab';
        }
    }
    return undefined;
}
const URL_PATTERN = {
    github: /https?:\/\/[^\s/]+\/[^\s]+?\/pull\/\d+\b/gu,
    gitlab: /https?:\/\/[^\s/]+\/[^\s]+?\/(?:-\/)?merge_requests\/\d+\b/gu,
};
/**
 * The URL the CLI printed for the new merge request. Scoped to the invoked
 * platform, and only accepted when unambiguous: a URL alone on its line wins,
 * otherwise exactly one URL must appear. Guessing between two would link an
 * unrelated merge request.
 */
function extractMergeRequestUrl(output, platform) {
    const pattern = new RegExp(URL_PATTERN[platform].source, 'gu');
    const matches = [...output.matchAll(pattern)];
    const ownLine = matches.filter((match) => isOwnLine(output, match));
    const chosen = only(ownLine) ?? only(matches);
    return chosen?.[0];
}
function only(items) {
    return items.length === 1 ? items[0] : undefined;
}
function isOwnLine(output, match) {
    const start = match.index ?? 0;
    const lineStart = output.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = output.indexOf('\n', start);
    return output.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim() === match[0];
}
/** `git push` at the start of a segment, after variables and git's global options such as -C. */
const PUSH_INVOCATION = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*(?:command\s+)?(?:\S*\/)?git(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--[A-Za-z-]+(?:=\S+)?))*\s+push\b/u;
const PUSH_REMOTE = /^To (\S+)$/u;
/**
 * One updated ref: ` <flag> <summary> <from> -> <to>`. The flag is blank for a
 * fast-forward, "+" for a forced update and "*" for a new ref; "=" (up to date),
 * "!" (rejected) and "-" (deleted) left no branch moved on the remote.
 */
const PUSH_REF = /^([+*=!-]?)\s*(\[[^\]]+\]|[0-9a-f]{4,}\.{2,3}[0-9a-f]{4,})\s+(\S+)\s+->\s+(\S+)/u;
/** GitLab's reply to a push to a branch that has an open merge request. */
const GITLAB_VIEW_MERGE_REQUEST = /View merge request for ([^\s:]+):[^\S\n]*\r?\n(?:remote:)?\s*(https?:\/\/\S+)/gu;
/**
 * Finds what a successful `git push` moved, judged by the output rather than the
 * Session's checkout: an agent often pushes from a worktree while its Session
 * works in the main checkout. Only the first remote is read, and only refs that
 * actually moved there count.
 */
export function detectPush(command, output) {
    if (!invokesPush(command))
        return undefined;
    const pushed = readFirstRemote(output);
    if (!pushed || pushed.branches.size === 0)
        return undefined;
    return {
        host: pushed.host,
        projectPath: pushed.projectPath,
        branches: [...pushed.branches],
        mergeRequests: namedMergeRequests(output, pushed),
    };
}
/** The first "To <remote>" block: the remote and the branches that moved there. */
function readFirstRemote(output) {
    let remote;
    const branches = new Set();
    for (const line of output.split(/\r?\n/u)) {
        const trimmed = line.trim();
        const to = PUSH_REMOTE.exec(trimmed)?.[1];
        if (to) {
            if (remote)
                break;
            remote = parseRemoteUrl(to);
            if (!remote)
                return undefined;
            continue;
        }
        const branch = remote ? movedBranch(trimmed) : undefined;
        if (branch)
            branches.add(branch);
    }
    return remote ? { ...remote, branches } : undefined;
}
/** Only a URL on the pushed remote's own project counts; any other text in the output is ignored. */
function namedMergeRequests(output, pushed) {
    const named = new Map();
    for (const [, branch, url] of output.matchAll(GITLAB_VIEW_MERGE_REQUEST)) {
        const ref = url ? parseMergeRequestUrl(url) : undefined;
        const onRemote = ref?.host === pushed.host &&
            ref.projectPath.toLowerCase() === pushed.projectPath.toLowerCase();
        if (branch && ref && onRemote && pushed.branches.has(branch))
            named.set(branch, ref);
    }
    return named;
}
function invokesPush(command) {
    for (const segment of splitCommand(command)) {
        for (const inner of unwrapCommandWrappers(segment)) {
            if (PUSH_INVOCATION.test(inner.trim()))
                return true;
        }
    }
    return false;
}
function movedBranch(line) {
    const match = PUSH_REF.exec(line);
    if (!match)
        return undefined;
    const [, flag = '', summary = '', , target = ''] = match;
    if (flag === '=' || flag === '!' || flag === '-' || summary === '[new tag]')
        return undefined;
    if (target.startsWith('refs/') && !target.startsWith('refs/heads/'))
        return undefined;
    return target.replace(/^refs\/heads\//u, '') || undefined;
}
//# sourceMappingURL=command-detect.js.map