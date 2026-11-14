import { PTC_LIMITS, validatePtcStoreWrite, } from '../contracts.js';
import {} from './contracts.js';
import { concatChunks, encodeRecord, liveRecords, valueOffset } from './records.js';
function describeError(error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
/**
 * Session-scoped `store`/`load` values for PTC programs.
 *
 * Values live in an append-only `store.jsonl` inside the Session temp
 * directory; this process keeps only the index (type, size, description and
 * the value's offset), so a large stored value costs the runtime no memory and
 * is read only when a program actually loads it. The directory belongs to the
 * runtime instance and is removed when it exits, so nothing survives a restart
 * and no other process can read an old file.
 */
export class PtcSessionStore {
    #files;
    #now;
    #logger;
    #readLiveTurnIds;
    #readForkExcludedTurnIds;
    #sessions = new Map();
    /** Sessions whose records must be filtered by Turn before their next use. */
    #pendingRebuild = new Set();
    constructor(options) {
        this.#files = options.files;
        this.#now = options.now ?? Date.now;
        this.#logger = options.logger;
        this.#readLiveTurnIds = options.readLiveTurnIds;
        this.#readForkExcludedTurnIds = options.readForkExcludedTurnIds;
    }
    /**
     * Remembers that a Session's history changed (rewind, edit-and-resend,
     * withdraw, or a Fork that copied the parent's records). Synchronous on
     * purpose: the caller is a committed-event callback, and the actual read of
     * the surviving Turn ids happens the next time the Session uses its store.
     */
    markContextReset(sessionId) {
        this.#pendingRebuild.add(sessionId);
    }
    /** True while this Session still owes a rebuild; for tests and diagnostics. */
    needsRebuild(sessionId) {
        return this.#pendingRebuild.has(sessionId);
    }
    /**
     * Applies a pending rebuild: keeps only the records of Turns the Session's
     * history still has, so a rewound Turn's values are undone and the value it
     * overwrote becomes live again. A no-op when nothing is pending.
     *
     * Returns false when a pending rebuild could not be applied. The marker
     * stays, so the next program tries again; until then the caller must treat
     * the Session as holding nothing, because the records still include the ones
     * the rewind was supposed to undo. Never throws for that reason: losing a
     * rebuild is recoverable, failing the program that asked for it is not.
     */
    async prepare(sessionId) {
        if (!this.#pendingRebuild.has(sessionId))
            return true;
        const readLiveTurnIds = this.#readLiveTurnIds;
        if (!readLiveTurnIds) {
            this.#pendingRebuild.delete(sessionId);
            return true;
        }
        try {
            this.retainTurns(sessionId, await readLiveTurnIds(sessionId));
        }
        catch (error) {
            this.#warn({ session_id: sessionId, error: describeError(error) }, 'ptc session store rebuild could not read the surviving turns');
            return false;
        }
        // Only once the read and the filter both succeeded: a marker dropped
        // before that would leave the rewound Turn's values loadable for good.
        this.#pendingRebuild.delete(sessionId);
        return true;
    }
    /** Keys the Session currently holds, without their values. */
    index(sessionId) {
        return [...liveRecords(this.#records(sessionId))].map(([key, record]) => ({
            key,
            type: record.type,
            bytes: record.bytes,
            ...(record.desc === undefined ? {} : { desc: record.desc }),
        }));
    }
    /** Bytes the Session's store file holds; 0 until its first commit. */
    sessionBytes(sessionId) {
        return this.#sessions.get(sessionId)?.fileBytes ?? 0;
    }
    /** The stored value's JSON text, or undefined when the key is unknown. */
    async read(sessionId, key) {
        const record = liveRecords(this.#records(sessionId)).get(key);
        if (!record)
            return undefined;
        return await this.#files.read(sessionId, record.offset, record.bytes);
    }
    /**
     * Appends one program's writes. Each line records where its value starts, so
     * a later `load` reads exactly those bytes instead of parsing the file.
     *
     * The write is all-or-nothing: the index is published only after every byte
     * reached the file, and a failure or an abandoned commit (the program was
     * stopped while this ran) puts the file back to the length it had before, so
     * the offsets of the records already published stay correct.
     */
    async commit(sessionId, turnId, writes, admission = {}) {
        const { isStillCommitted = () => true, onPublished } = admission;
        if (writes.length === 0)
            return { keys: [], bytes: 0 };
        return await this.#serialize(sessionId, async (state) => {
            if (state.poisoned) {
                throw new Error('PTC session store offsets are no longer trustworthy for this session.');
            }
            // Something outside this process may have removed or rewritten the file
            // (a temp-directory cleaner: macOS $TMPDIR, systemd-tmpfiles, Windows
            // Storage Sense). The index's offsets then point into bytes that are no
            // longer there, so a `load` could read a neighbour's value or fail on a
            // short read. The old records are dropped and this commit continues from
            // the file's real length, which is the only thing the offsets written
            // after it can be built on. Worst case the Session falls back to never
            // having stored anything, which is recoverable; reading another key's
            // bytes is not.
            const actual = await this.#files.size(sessionId);
            if (actual !== state.fileBytes) {
                this.#warn({
                    session_id: sessionId,
                    expected_bytes: state.fileBytes,
                    actual_bytes: actual,
                }, 'ptc session store file changed outside the store');
                state.records = [];
                state.fileBytes = actual;
            }
            // A write without a desc keeps the key's current one, so the reminder
            // never loses the description an earlier store gave it. Read after the
            // check above, so a dropped record's description cannot reach a new one.
            const descs = new Map([...liveRecords(state.records)].map(([key, record]) => [key, record.desc]));
            const encoded = writes.map((write) => encodeRecord(write, { seq: state.nextSeq++, turnId, ts: this.#now(), descs }));
            const chunk = concatChunks(encoded.map((entry) => entry.chunk));
            const before = state.fileBytes;
            if (!isStillCommitted())
                return { keys: [], bytes: 0 };
            await this.#appendChunk(sessionId, state, chunk, before);
            // The last word on whether this commit may be published, in the same
            // synchronous block as the index update below: `await` returns through a
            // microtask, so a check made before that boundary could be overtaken by a
            // stop. Once the records are in, the host keeps the program's own outcome
            // (see PtcQuickJsExecution.stop), so the two never disagree.
            if (!isStillCommitted()) {
                await this.#rollback(sessionId, state, before);
                return { keys: [], bytes: 0 };
            }
            const written = encoded.map((entry, index) => ({
                ...entry.record,
                offset: before + valueOffset(encoded, index),
            }));
            state.fileBytes = before + chunk.byteLength;
            state.records.push(...written);
            const published = {
                keys: written.map((record) => record.key),
                bytes: written.reduce((total, record) => total + record.bytes, 0),
            };
            // Same synchronous block as the index update: the caller can read this
            // back synchronously and never sees "stored" and "not stored" at once.
            onPublished?.(published);
            return published;
        });
    }
    /** Writes every byte of the chunk, or puts the file back and rethrows. */
    async #appendChunk(sessionId, state, chunk, before) {
        try {
            await this.#files.append(sessionId, chunk);
        }
        catch (error) {
            await this.#rollback(sessionId, state, before);
            throw error;
        }
    }
    /** Puts the file back to its committed length, or gives up on the Session. */
    async #rollback(sessionId, state, before) {
        try {
            await this.#files.truncate(sessionId, before);
        }
        catch {
            state.poisoned = true;
            state.records = [];
        }
    }
    /**
     * Drops the records of Turns that are no longer in the Session's history
     * (rewind, edit-and-resend, withdraw). The file keeps every line, so an
     * earlier value of the same key becomes live again.
     */
    retainTurns(sessionId, turnIds) {
        const state = this.#sessions.get(sessionId);
        if (!state)
            return;
        state.records = state.records.filter((record) => turnIds.has(record.turnId));
    }
    /** Removes the Session's store directory and forgets its index. */
    async deleteSession(sessionId) {
        this.#sessions.delete(sessionId);
        await this.#files.removeSession(sessionId);
    }
    /**
     * Copies the records of the copied Turns into another Session, so a Forked
     * conversation can still load what its copied history produced. The original
     * Turn ids are kept: a rewind in the child filters on the same ids.
     *
     * One record is read and written before the next one is read, so copying a
     * Session never holds more than a single value in memory.
     */
    async copyTurns(sourceSessionId, targetSessionId, turnIds) {
        const copied = this.#records(sourceSessionId).filter((record) => turnIds.has(record.turnId));
        for (const record of copied) {
            const write = {
                key: record.key,
                valueJson: await this.#files.read(sourceSessionId, record.offset, record.bytes),
                ...(record.desc === undefined ? {} : { desc: record.desc }),
            };
            await this.commit(targetSessionId, record.turnId, [write]);
        }
    }
    /**
     * Copies every record of a Session into a Fork child and marks the child for
     * a rebuild. The copied history keeps the parent's Turn ids (message rows are
     * copied with their `turn_id`), so the child's first use filters the copy
     * down to the Turns its own history actually has.
     *
     * A copy that fails halfway leaves nothing behind: the child's partial
     * records and directory go before the failure is reported, so the child can
     * never read half of its parent's store.
     *
     * `boundary` says where the Fork stopped. A Turn the Fork cut in half is
     * left out entirely: the child kept only the messages up to the boundary, so
     * everything that Turn's programs stored after it is not part of the child's
     * history and the child must not be able to load it.
     */
    async copySession(sourceSessionId, targetSessionId, boundary) {
        // Nothing to copy: finding the fork boundary reads the source's whole
        // history and decodes it, which is wasted work for a Session that never
        // stored anything. A child of such a Session has nothing to rebuild
        // either, so it is not marked for one.
        if (this.#records(sourceSessionId).length === 0)
            return;
        const excluded = await this.#forkExcludedTurnIds(sourceSessionId, boundary);
        const turnIds = new Set(this.#records(sourceSessionId)
            .map((record) => record.turnId)
            .filter((turnId) => !excluded.has(turnId)));
        try {
            await this.copyTurns(sourceSessionId, targetSessionId, turnIds);
        }
        catch (error) {
            await this.#discardPartialCopy(targetSessionId);
            throw error;
        }
        this.markContextReset(targetSessionId);
    }
    /**
     * The Turns the Fork cut in half. A read that fails is not a reason to copy
     * records that may belong after the boundary, so it fails the copy and the
     * caller turns that into a child with an empty store.
     */
    async #forkExcludedTurnIds(sourceSessionId, boundary) {
        const read = this.#readForkExcludedTurnIds;
        if (!boundary || !read)
            return new Set();
        return await read({
            sessionId: sourceSessionId,
            throughAssistantMessageId: boundary.throughAssistantMessageId,
        });
    }
    /** Drops a Fork child's half-written copy; best effort, never throws. */
    async #discardPartialCopy(targetSessionId) {
        // Nothing was committed, so there is no Session state and no directory to
        // remove; asking for one would create it.
        if (!this.#sessions.has(targetSessionId))
            return;
        // The index goes first: whatever happens to the directory, the child must
        // not be able to read a record whose bytes may be a neighbour's.
        this.#sessions.delete(targetSessionId);
        try {
            await this.#files.removeSession(targetSessionId);
        }
        catch {
            // The directory may still hold the half-written copy, so a later commit
            // would append after those bytes while the index says the file is empty.
            // The child is marked unusable instead: it keeps showing nothing and
            // refuses writes rather than reading another record's bytes.
            this.#sessions.set(targetSessionId, {
                records: [],
                nextSeq: 1,
                fileBytes: 0,
                tail: Promise.resolve(),
                poisoned: true,
            });
        }
    }
    /** One program's view: staged writes, committed only when the program ends. */
    program(sessionId, turnId) {
        const staged = [];
        let published;
        // False while this program's rebuild could not be applied: it sees an
        // empty store, so it cannot read a value a rewind was supposed to undo.
        // Its own writes still commit; they are its own work.
        let usable = true;
        return {
            prepare: async () => {
                usable = await this.prepare(sessionId);
            },
            published: () => published,
            index: () => (usable ? this.index(sessionId) : []),
            read: (key) => (usable ? this.read(sessionId, key) : Promise.resolve(undefined)),
            stage: (write) => {
                this.validate(write);
                staged.push(write);
            },
            commit: async (isStillCommitted) => await this.commit(sessionId, turnId, staged.splice(0, staged.length), {
                ...(isStillCommitted ? { isStillCommitted } : {}),
                onPublished: (summary) => {
                    published = summary;
                },
            }),
            discard: () => {
                staged.length = 0;
            },
        };
    }
    /**
     * Validates one guest write against the shared rule; the guest's setup
     * script and the Worker already applied the same one.
     */
    validate(write) {
        validatePtcStoreWrite(write, PTC_LIMITS.maxBridgeMessageBytes);
    }
    #records(sessionId) {
        return this.#sessions.get(sessionId)?.records ?? [];
    }
    /** Diagnostics never affect the program or the Session they report on. */
    #warn(fields, message) {
        try {
            this.#logger?.warn?.(fields, message);
        }
        catch {
            // A failing logger cannot report itself.
        }
    }
    /** Runs one commit after the Session's earlier commits, so lines never interleave. */
    async #serialize(sessionId, work) {
        const state = this.#sessions.get(sessionId) ?? {
            records: [],
            nextSeq: 1,
            fileBytes: 0,
            tail: Promise.resolve(),
        };
        this.#sessions.set(sessionId, state);
        const previous = state.tail;
        let release;
        state.tail = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            await this.#files.ensureDirectory(sessionId);
            return await work(state);
        }
        finally {
            release();
        }
    }
}
//# sourceMappingURL=store.js.map