import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { desc, eq, inArray } from 'drizzle-orm';
import { markBunnyFirstUse } from '../../../../infra/db/bunny-store.js';
import { bunnyArtifactLibrary, bunnySpaces, bunnySpaceSessions, } from '../../../../infra/db/schema/bunny-store.js';
import { findArtifactCatalogRow, findArtifactSourceSession, spaceArtifactCounts, spaceSourceSessions, } from '../repo/artifact-catalog.js';
import { readBunnyAssignedSessionIds } from '../../assignment-tasks/repo/assigned-by-bunny.js';
import { artifactId, artifactView } from './paths.js';
import { createImportedArtifacts } from './imports.js';
import { ArtifactCatalogError } from './errors.js';
import { readSpaceContext, syncSpaceContextGoal, writeSpaceContext, writeTidiedSpaceContext, } from './space-context.js';
import { LEGACY_DEFAULT_SPACE_ID, SPACE_ARTIFACTS_DIR, SPACE_IMPORTS_DIR, SPACE_STAGING_PREFIX, resolveSpaceDirectory, spaceDirectoryName, spaceStagingDirectory, spacesRoot, trashRoot, } from './space-directory.js';
import { readSpaceMeta, spaceMetaMatches, spaceMetaOf, unclaimedSpaceDirectories, writeSpaceMeta, writeSpaceMetaIn, } from './space-meta.js';
import { KeyedOperationQueue } from '../../../../infra/util/keyed-operation-queue.js';
import { logger } from '../../../../infra/logging/logger.js';
import { createMainSessionIndex, sweepSessionOrphans, } from '../../sessions/lifecycle/orphan-sweep.js';
import { spaceChanges, importContents } from './validation.js';
const META_WRITE_FAILED = 'Space meta.json mirror write failed; startup reconciliation will repair it';
const CONTEXT_SYNC_FAILED = 'Space context.md goal sync failed';
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** How many `<name> (n)` copies an import tries before it gives up. */
const MAX_IMPORT_NAME_COPIES = 999;
/**
 * The file system refused a name for being too long. A name already at the limit imports once, but
 * a second import of it has to append ` (n)` and no longer fits. Say which of the two happened
 * instead of letting the raw errno through, where it reads as a 500 and a retry cannot help.
 */
function nameTooLong(copy) {
    return new ArtifactCatalogError(copy === 0
        ? 'File name is too long for the file system'
        : `File name is too long to add the " (${copy})" that a same-name import needs`);
}
/**
 * Writes an imported file without replacing one already there. A taken name gets the next free
 * `<stem> (n)<ext>` the way Finder names downloads: `报告.md`, `报告 (1).md`, `报告 (2).md`.
 * Each try is an exclusive create, so a file that appears meanwhile is skipped, not overwritten.
 * Later candidates only grow, so a name the file system refuses ends the search at once.
 */
async function writeUnderFreeName(directory, name, data) {
    const extension = path.extname(name);
    const stem = name.slice(0, name.length - extension.length);
    for (let copy = 0; copy <= MAX_IMPORT_NAME_COPIES; copy += 1) {
        const candidate = copy ? `${stem} (${copy})${extension}` : name;
        const filePath = path.join(directory, candidate);
        try {
            await writeFile(filePath, data, { flag: 'wx' });
            return { name: candidate, filePath };
        }
        catch (error) {
            const code = error.code;
            if (code === 'ENAMETOOLONG')
                throw nameTooLong(copy);
            if (code !== 'EEXIST')
                throw error;
        }
    }
    throw new ArtifactCatalogError('Too many files with this name', 409);
}
/**
 * Spaces, their session links and the imported files live in the Bunny store
 * (`bunny/data/bunny.sqlite`); the session deliveries the catalog lists stay in the session
 * database. The two databases never share a transaction: every write commits in one of them,
 * and readers tolerate the other being a step behind.
 */
export class ArtifactLibraryService {
    db;
    bunny;
    dataDir;
    rootAgents;
    /**
     * Every change to a space's directory runs in this queue, one space at a time, so two writes
     * to the same space never interleave their database row and files.
     */
    spaceWrites = new KeyedOperationQueue();
    constructor(db, bunny, dataDir, rootAgents) {
        this.db = db;
        this.bunny = bunny;
        this.dataDir = dataDir;
        this.rootAgents = rootAgents;
    }
    directory(id) {
        return resolveSpaceDirectory(this.dataDir, id);
    }
    /** The root every space directory lives under. */
    spacesRoot() {
        return spacesRoot(this.dataDir);
    }
    sessionSpace(sessionId) {
        return this.bunny
            .select()
            .from(bunnySpaceSessions)
            .where(eq(bunnySpaceSessions.sessionId, sessionId))
            .get()?.spaceId;
    }
    /** Every session → space link, for catalog queries in the session database. */
    spaceLinks() {
        return new Map(this.bunny
            .select({ sessionId: bunnySpaceSessions.sessionId, spaceId: bunnySpaceSessions.spaceId })
            .from(bunnySpaceSessions)
            .all()
            .map((row) => [row.sessionId, row.spaceId]));
    }
    /** Sessions whose task Bunny assigned; hidden ones still surface their artifacts. */
    bunnyAssignedSessionIds() {
        return readBunnyAssignedSessionIds(this.bunny);
    }
    /** Which sessions the catalog lists: assigned task sessions and the registered roots. */
    catalogVisibility() {
        return { assigned: this.bunnyAssignedSessionIds(), rootAgents: this.rootAgents };
    }
    /** Everything catalog queries in the session database need from the Bunny store. */
    catalogFacts() {
        const legacyDefault = this.bunny
            .select({ id: bunnySpaces.id })
            .from(bunnySpaces)
            .where(eq(bunnySpaces.id, LEGACY_DEFAULT_SPACE_ID))
            .get();
        return {
            links: this.spaceLinks(),
            imports: createImportedArtifacts(this.bunny),
            ...(legacyDefault ? { rootSpaceId: legacyDefault.id } : {}),
            ...this.catalogVisibility(),
        };
    }
    /** Read-only: lists the rows as they are and never creates or repairs a file. */
    summary() {
        const counts = new Map(spaceArtifactCounts(this.db, this.catalogFacts()).map((row) => [row.spaceId, row.count]));
        const spaces = this.bunny
            .select()
            .from(bunnySpaces)
            .orderBy(desc(bunnySpaces.createdAtMs), bunnySpaces.id)
            .all()
            .map((space) => ({
            ...space,
            count: counts.get(space.id) ?? 0,
        }));
        return { spaces };
    }
    saveSpace(input) {
        const id = input.id ?? randomUUID();
        return this.spaceWrites.run(id, async () => this.saveSpaceNow(id, input));
    }
    async saveSpaceNow(id, input) {
        const current = input.id ? this.requireSpace(input.id) : undefined;
        const values = spaceChanges(input, current);
        const existing = this.bunny
            .select()
            .from(bunnySpaces)
            .all()
            .find((space) => space.id !== current?.id && space.name === values.name);
        if (existing)
            throw Object.assign(new ArtifactCatalogError(`Workline already exists: ${existing.id}`, 409), { code: 'WORKLINE_ALREADY_EXISTS', worklineId: existing.id });
        const now = Date.now();
        const upsert = () => this.bunny
            .insert(bunnySpaces)
            .values({ id, ...values, createdAtMs: now, updatedAtMs: now })
            .onConflictDoUpdate({ target: bunnySpaces.id, set: { ...values, updatedAtMs: now } })
            .run();
        if (current) {
            upsert();
            await this.mirror(id);
            // An existing space only follows a goal change; a new one got its context.md when staged.
            if (current.objective !== values.objective)
                await this.syncContextGoal(id, values.objective, { create: false });
        }
        else {
            await this.createSpaceDirectory({ id, ...values, createdAtMs: now, updatedAtMs: now }, () => {
                upsert();
                markBunnyFirstUse(this.bunny, 'space', now);
            });
        }
        return { space: this.summary().spaces.find((space) => space.id === id) };
    }
    /**
     * Two-phase create of a space directory: `spaces/.staging-<id>/` gets meta.json, context.md
     * and `artifacts/`, then `commit` writes the row, then the staging directory is renamed to
     * `<slug>-<id>`. A failed commit removes the staging directory and leaves no row; a crash
     * after it leaves a row without a directory, which startup reconciliation builds again.
     */
    async createSpaceDirectory(space, commit) {
        const staging = spaceStagingDirectory(this.dataDir, space.id);
        await rm(staging, { recursive: true, force: true });
        try {
            await mkdir(path.join(staging, SPACE_ARTIFACTS_DIR), { recursive: true });
            await this.stageSpaceFiles(staging, space);
            commit();
        }
        catch (error) {
            await rm(staging, { recursive: true, force: true });
            throw error;
        }
        const target = path.join(this.spacesRoot(), spaceDirectoryName(space.id, space.name));
        try {
            await rename(staging, target);
        }
        catch (error) {
            logger.error({ spaceId: space.id, staging, target, error: errorMessage(error) }, 'Space directory could not be moved into place; startup reconciliation will build it');
        }
    }
    /** The generated files of a staged space. A failed write is logged like any mirror write. */
    async stageSpaceFiles(staging, space) {
        try {
            await writeSpaceMetaIn(staging, space, { nowMs: Date.now() });
        }
        catch (error) {
            logger.warn({ spaceId: space.id, error: errorMessage(error) }, META_WRITE_FAILED);
        }
        try {
            await syncSpaceContextGoal(staging, space.objective, { create: true });
        }
        catch (error) {
            logger.warn({ spaceId: space.id, error: errorMessage(error) }, CONTEXT_SYNC_FAILED);
        }
    }
    /** The space's context.md: `<goal>` from the database, `<summary>` from the file. */
    readContext(id) {
        const space = this.requireSpace(id);
        const directory = this.directory(id);
        return { goal: space.objective, ...readSpaceContext(directory), directory };
    }
    /**
     * Rewrites `<summary>` (whole, or only the named sections) when `revision` is still current.
     * `<goal>` is rewritten from the database at the same time and cannot be changed here.
     */
    writeContext(input) {
        return this.spaceWrites.run(input.id, async () => {
            const space = this.requireSpace(input.id);
            const directory = this.directory(input.id);
            const written = await writeSpaceContext(directory, {
                goal: space.objective,
                revision: input.revision,
                ...(input.sections ? { sections: input.sections } : { summary: input.summary }),
            });
            return { ...written, goal: space.objective, directory };
        });
    }
    /** Replaces a summary the background tidy rewrote; the replaced one goes to the archive. */
    tidyContext(input) {
        return this.spaceWrites.run(input.id, async () => {
            const space = this.requireSpace(input.id);
            const directory = this.directory(input.id);
            const written = await writeTidiedSpaceContext(directory, {
                goal: space.objective,
                revision: input.revision,
                summary: input.summary,
                nowMs: input.nowMs,
            });
            return { ...written, goal: space.objective, directory };
        });
    }
    /** A failed `<goal>` sync is logged: the database already holds the goal. */
    async syncContextGoal(id, goal, options) {
        try {
            await syncSpaceContextGoal(this.directory(id), goal, options);
        }
        catch (error) {
            logger.warn({ spaceId: id, error: errorMessage(error) }, CONTEXT_SYNC_FAILED);
        }
    }
    getSpace(id) {
        this.requireSpace(id);
        const space = this.summary().spaces.find((item) => item.id === id);
        const linked = this.bunny
            .select({ sessionId: bunnySpaceSessions.sessionId })
            .from(bunnySpaceSessions)
            .where(eq(bunnySpaceSessions.spaceId, id))
            .all()
            .map((row) => row.sessionId);
        return {
            space,
            sessions: spaceSourceSessions(this.db, id, { ...this.catalogFacts(), linked }),
        };
    }
    linkSession(input) {
        this.requireSpace(input.id);
        const session = findArtifactSourceSession(this.db, this.catalogVisibility(), input.sessionId);
        if (!session)
            throw new ArtifactCatalogError('Source chat not available', 404);
        this.bunny
            .insert(bunnySpaceSessions)
            .values({ sessionId: input.sessionId, spaceId: input.id, createdAtMs: Date.now() })
            .onConflictDoUpdate({ target: bunnySpaceSessions.sessionId, set: { spaceId: input.id } })
            .run();
        return {};
    }
    deleteSpace(id) {
        return this.spaceWrites.run(id, async () => this.deleteSpaceNow(id));
    }
    async deleteSpaceNow(id) {
        this.requireSpace(id);
        const directory = this.directory(id);
        // Marked before the row goes, so a crash in between leaves a directory that says why.
        await this.mirror(id, 'deleting');
        // The row (and its session links, by cascade) goes together with its imported files'
        // space: they fall back to no space.
        this.bunny.transaction((tx) => {
            tx.delete(bunnySpaces).where(eq(bunnySpaces.id, id)).run();
            tx.update(bunnyArtifactLibrary)
                .set({ spaceId: null, updatedAtMs: Date.now() })
                .where(eq(bunnyArtifactLibrary.spaceId, id))
                .run();
        });
        await this.moveToTrash(directory);
        return {};
    }
    /**
     * Moves a deleted space's directory to `<bunny>/.trash/<ms>-space-<name>/`; nothing is removed
     * outright. A failed move leaves the directory, marked `deleting`, for startup reconciliation.
     */
    async moveToTrash(directory) {
        if (!existsSync(directory))
            return undefined;
        const target = path.join(trashRoot(this.dataDir), `${Date.now()}-space-${path.basename(directory)}`);
        try {
            await mkdir(path.dirname(target), { recursive: true });
            await rename(directory, target);
            return target;
        }
        catch (error) {
            logger.warn({ directory, target, error: errorMessage(error) }, 'Deleted space directory could not be moved to the trash; startup reconciliation retries');
            return undefined;
        }
    }
    /** An imported file always belongs to one space. */
    async importFile(input) {
        const spaceId = input.spaceId?.trim();
        if (!spaceId)
            throw new ArtifactCatalogError('Space required');
        return this.spaceWrites.run(spaceId, () => this.importFileNow(spaceId, input));
    }
    async importFileNow(spaceId, input) {
        const { name, data, category } = importContents(input);
        this.requireSpace(spaceId);
        const assetKey = randomUUID();
        const workspaceDir = path.join(this.directory(spaceId), SPACE_ARTIFACTS_DIR, SPACE_IMPORTS_DIR);
        const id = artifactId('', assetKey);
        await mkdir(workspaceDir, { recursive: true });
        const written = await writeUnderFreeName(workspaceDir, name, data);
        const now = Date.now();
        try {
            this.bunny
                .insert(bunnyArtifactLibrary)
                .values({
                id,
                assetKey,
                name: written.name,
                path: written.filePath,
                category,
                workspaceDir,
                spaceId,
                importedAtMs: now,
                updatedAtMs: now,
            })
                .run();
        }
        catch (error) {
            // No row claims the file; leaving it would make a retry land beside it as `<name> (1)`.
            await rm(written.filePath, { force: true });
            throw error;
        }
        return { artifact: await artifactView(this.resolve(id)) };
    }
    requireSpace(id) {
        const space = this.bunny.select().from(bunnySpaces).where(eq(bunnySpaces.id, id)).get();
        if (!space)
            throw new ArtifactCatalogError('Space not found', 404);
        return space;
    }
    /**
     * Startup reconciliation, before any left-over work resumes: every space row gets a directory
     * and a meta.json that says what the row says; a directory left by an interrupted delete
     * (meta.json says `deleting`) is moved to the trash and left-over `.staging-*` directories go.
     * Other directories no row claims are reported, never touched. With `sessionLinks`, links to
     * Sessions the main database no longer holds are deleted under that guard (see
     * sweepSessionOrphans); without it they stay.
     */
    async reconcileSpaceMirrors(options = {}) {
        await this.clearStaging();
        const spaces = this.bunny.select().from(bunnySpaces).all();
        const rewritten = [];
        for (const space of spaces) {
            await this.spaceWrites.run(space.id, async () => {
                if (await this.reconcileSpace(space))
                    rewritten.push(space.id);
            });
        }
        const { orphans, duplicates } = unclaimedSpaceDirectories(this.dataDir, new Set(spaces.map((space) => space.id)));
        const kept = [];
        for (const directory of orphans)
            if (!(await this.reconcileOrphan(directory)))
                kept.push(directory);
        for (const [id, directories] of duplicates)
            logger.error({ spaceId: id, directories, chosen: this.directory(id) }, 'Several directories claim one space; left in place');
        const sessionLinks = options.sessionLinks
            ? await this.sweepSessionLinks(options.sessionLinks)
            : undefined;
        return {
            rewritten,
            orphans: kept,
            duplicates: [...duplicates.keys()],
            ...(sessionLinks ? { sessionLinks } : {}),
        };
    }
    /** A failed sweep leaves the links for the next startup; reads already filter them out. */
    async sweepSessionLinks(guard) {
        try {
            const outcome = await sweepSessionOrphans({
                guard,
                sessions: createMainSessionIndex(this.db),
                rows: {
                    listSessionIds: async () => this.bunny
                        .select({ sessionId: bunnySpaceSessions.sessionId })
                        .from(bunnySpaceSessions)
                        .all()
                        .map((row) => row.sessionId),
                    deleteForSessions: async (sessionIds) => this.bunny
                        .delete(bunnySpaceSessions)
                        .where(inArray(bunnySpaceSessions.sessionId, [...sessionIds]))
                        .run().changes,
                },
            });
            if (outcome.status === 'skipped')
                logger.info({ reason: outcome.reason }, 'Space session link orphan sweep skipped');
            else if (outcome.deleted > 0)
                logger.info(outcome, 'Removed space links to deleted Sessions');
            return outcome;
        }
        catch (error) {
            logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Space session link orphan sweep failed; it runs again at the next startup');
            return undefined;
        }
    }
    /** Rebuilds a missing directory or rewrites a stale meta.json; true when it wrote. */
    async reconcileSpace(space) {
        const directory = this.directory(space.id);
        if (!existsSync(directory)) {
            await this.createSpaceDirectory(space, () => undefined);
            return true;
        }
        const stored = readSpaceMeta(directory);
        if (spaceMetaMatches(stored, spaceMetaOf(space, { syncedAtMs: 0 })))
            return false;
        return this.mirror(space.id);
    }
    /** Finishes an interrupted delete; true when the directory went to the trash. */
    async reconcileOrphan(directory) {
        const meta = readSpaceMeta(directory);
        const deleting = meta?.status === 'deleting';
        if (deleting) {
            const moved = await this.moveToTrash(directory);
            if (moved) {
                logger.info({ directory, trash: moved }, 'Moved the directory of a deleted space to the trash');
                return true;
            }
        }
        logger.warn({ directory, deleting }, deleting
            ? 'Space directory outlived its interrupted deletion; left in place'
            : 'Space directory has no space in the database; left in place');
        return false;
    }
    /** `.staging-<id>` directories hold only generated files; one that outlived its create goes. */
    async clearStaging() {
        let entries;
        try {
            entries = await readdir(this.spacesRoot());
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.startsWith(SPACE_STAGING_PREFIX))
                continue;
            const id = entry.slice(SPACE_STAGING_PREFIX.length) || entry;
            await this.spaceWrites.run(id, async () => {
                await rm(path.join(this.spacesRoot(), entry), { recursive: true, force: true });
                logger.info({ staging: entry }, 'Removed a left-over space staging directory');
            });
        }
    }
    /**
     * Rewrites a space's meta.json from its database row. A failed write is logged, never
     * rolled back into the database: the next startup reconciliation repairs it.
     */
    async mirror(id, status) {
        const space = this.bunny.select().from(bunnySpaces).where(eq(bunnySpaces.id, id)).get();
        if (!space)
            return false;
        try {
            await writeSpaceMeta(this.dataDir, space, { status, nowMs: Date.now() });
            return true;
        }
        catch (error) {
            logger.warn({ spaceId: id, error: errorMessage(error) }, META_WRITE_FAILED);
            return false;
        }
    }
    resolve(id) {
        let parts;
        try {
            parts = JSON.parse(Buffer.from(id, 'base64url').toString());
        }
        catch {
            /* handled below */
        }
        if (!Array.isArray(parts) ||
            parts.length !== 2 ||
            parts.some((part) => typeof part !== 'string') ||
            artifactId(parts[0], parts[1]) !== id)
            throw new ArtifactCatalogError('Invalid artifact id');
        const row = findArtifactCatalogRow(this.db, this.catalogFacts(), parts[0], parts[1]);
        if (!row)
            throw new ArtifactCatalogError('Artifact not found', 404);
        return row;
    }
}
//# sourceMappingURL=service.js.map