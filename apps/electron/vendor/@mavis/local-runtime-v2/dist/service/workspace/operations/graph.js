import { randomUUID } from 'node:crypto';
import { WorkspaceGitGraphError, } from '../contracts.js';
import { git } from './git-process.js';
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SNAPSHOT_TTL_MS = 30 * 60_000;
const MAX_SNAPSHOTS = 32;
const MAX_TIPS = 100_000;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
/** Immutable revision tips keep offset pagination stable across commits and ref changes. */
export class WorkspaceGitGraphReader {
    snapshots = new Map();
    async read(workspace, cursor, limit = 50) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
            throw new WorkspaceGitGraphError('INVALID_GRAPH_REQUEST', 'Limit must be between 1 and 200');
        }
        const { snapshot, offset } = await this.getSnapshot(workspace, cursor);
        if (!snapshot.tips.length)
            return { commits: [] };
        const output = await runGraphGit(workspace, [
            'log',
            '--topo-order',
            `--skip=${offset}`,
            `--max-count=${limit + 1}`,
            '--format=%H%x00%P%x00%an%x00%at%x00%s%x00',
            '--stdin',
            '--',
        ], `${snapshot.tips.join('\n')}\n`);
        const commits = parseCommits(output, snapshot.refs);
        return {
            commits: commits.slice(0, limit),
            ...(commits.length > limit ? { nextCursor: `${snapshot.id}:${offset + limit}` } : {}),
        };
    }
    async getSnapshot(workspace, cursor) {
        const now = Date.now();
        for (const [id, entry] of this.snapshots) {
            if (entry.expiresAt <= now)
                this.snapshots.delete(id);
        }
        if (cursor !== undefined) {
            const match = /^([a-f0-9-]{36}):([0-9]{1,7})$/.exec(cursor);
            if (!match)
                throw new WorkspaceGitGraphError('INVALID_GRAPH_REQUEST', 'Invalid graph cursor');
            const stored = this.snapshots.get(match[1]);
            if (!stored || stored.workspace !== workspace) {
                throw new WorkspaceGitGraphError('GRAPH_EXPIRED', 'Refresh the graph to load a new snapshot');
            }
            return { snapshot: stored, offset: Number(match[2]) };
        }
        const snapshot = await this.capture(workspace);
        this.remember(snapshot);
        return { snapshot, offset: 0 };
    }
    remember(snapshot) {
        let bytes = [...this.snapshots.values()].reduce((total, entry) => total + entry.sizeBytes, 0);
        for (const [id, entry] of this.snapshots) {
            if (this.snapshots.size < MAX_SNAPSHOTS && bytes + snapshot.sizeBytes <= MAX_SNAPSHOT_BYTES)
                break;
            this.snapshots.delete(id);
            bytes -= entry.sizeBytes;
        }
        this.snapshots.set(snapshot.id, snapshot);
    }
    release(workspace) {
        for (const [id, entry] of this.snapshots) {
            if (entry.workspace === workspace)
                this.snapshots.delete(id);
        }
    }
    clear() {
        this.snapshots.clear();
    }
    async capture(workspace) {
        // for-each-ref also validates an empty repository without requiring HEAD to exist.
        const output = await runGraphGit(workspace, [
            'for-each-ref',
            '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)',
            'refs/heads',
            'refs/remotes',
            'refs/tags',
        ]);
        const refs = new Map();
        const add = (hash, ref) => {
            if (!HASH.test(hash))
                return;
            refs.set(hash, [...(refs.get(hash) ?? []), ref]);
        };
        for (const line of output.split('\n').filter(Boolean)) {
            const { name, hash } = await resolveRef(workspace, line);
            if (name.startsWith('refs/heads/'))
                add(hash, { name: name.slice(11), kind: 'branch' });
            else if (name.startsWith('refs/remotes/'))
                add(hash, { name: name.slice(13), kind: 'remote' });
            else if (name.startsWith('refs/tags/'))
                add(hash, { name: name.slice(10), kind: 'tag' });
        }
        const head = await git(['rev-parse', '--verify', 'HEAD'], workspace, {
            signal: AbortSignal.timeout(15_000),
        });
        if (head.code === 0)
            add(head.stdout.trim(), { name: 'HEAD', kind: 'head' });
        const tips = [...refs.keys()].sort();
        if (tips.length > MAX_TIPS) {
            throw new WorkspaceGitGraphError('GRAPH_UNAVAILABLE', 'Repository exceeds the graph reference limit');
        }
        return {
            id: randomUUID(),
            workspace,
            expiresAt: Date.now() + SNAPSHOT_TTL_MS,
            tips,
            refs,
            sizeBytes: Buffer.byteLength(output, 'utf8'),
        };
    }
}
async function resolveRef(workspace, line) {
    const [name = '', object = '', type, peeled = '', peeledType] = line.split('\0');
    let hash = '';
    if (type === 'commit')
        hash = object;
    else if (peeledType === 'commit')
        hash = peeled;
    // Nested annotated tags need recursive peeling. Tags to blobs/trees are not commits.
    else if (type === 'tag' && peeledType === 'tag') {
        const result = await git(['rev-parse', '--verify', `${object}^{commit}`], workspace, {
            signal: AbortSignal.timeout(15_000),
        });
        if (result.code === 0)
            hash = result.stdout.trim();
    }
    return { name, hash };
}
async function runGraphGit(workspace, args, input) {
    try {
        const result = await git(args, workspace, { signal: AbortSignal.timeout(15_000), input });
        if (result.code === 0)
            return result.stdout;
    }
    catch {
        // The public error remains stable and does not expose filesystem/process details.
    }
    throw new WorkspaceGitGraphError('GRAPH_UNAVAILABLE', 'Unable to read the repository graph');
}
function parseCommits(output, refs) {
    const fields = output.split('\0');
    const commits = [];
    for (let index = 0; index + 4 < fields.length; index += 5) {
        const hash = fields[index].trim();
        const parents = fields[index + 1].split(' ').filter(Boolean);
        const authoredAt = Number(fields[index + 3]) * 1000;
        if (!HASH.test(hash) ||
            parents.some((parent) => !HASH.test(parent)) ||
            !Number.isFinite(authoredAt)) {
            throw new WorkspaceGitGraphError('GRAPH_UNAVAILABLE', 'Invalid commit data');
        }
        commits.push({
            hash,
            parents,
            author: fields[index + 2],
            authoredAt,
            subject: fields[index + 4],
            refs: refs.get(hash) ?? [],
        });
    }
    return commits;
}
//# sourceMappingURL=graph.js.map