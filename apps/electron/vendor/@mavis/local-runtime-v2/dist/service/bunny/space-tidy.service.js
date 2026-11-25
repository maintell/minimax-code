import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { createConsolidationWorkdirTools, } from '../memory-system/index.js';
import { SPACE_CONTEXT_LOCKED_SECTIONS, SPACE_CONTEXT_SUMMARY_SOFT_LIMIT, parseSpaceContext, spaceContextLockedSection, spaceContextNeedsTidy, spaceContextSections, validateSpaceContextSummary, } from '../session-system/index.js';
/** The first retry waits a minute, doubling per failure up to an hour (in memory, per process). */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 3600_000;
/** A pass runs once per local day and at least this long after the last completed one. */
const MIN_PASS_INTERVAL_MS = 20 * 3600_000;
/** One pass tidies at most this many spaces, longest first, so a backlog never runs all night. */
const SPACES_PER_RUN = 3;
/** The work directory's file the model rewrites; the rest it only reads. */
const SUMMARY_FILE = 'context.md';
/**
 * Keeps a space's `<summary>` from growing until Bunny can no longer write it.
 *
 * Runs in the daily idle window, after memory upkeep, at most once a day (counted in this
 * process), and only for spaces past the soft limit. The model sees the summary in a work
 * directory and rewrites it; the result must be shorter, under the soft limit and keep the
 * locked sections byte for byte, and the checked write moves the summary it replaces to
 * `context-archive.md`. A space whose candidate fails a check, or whose revision moved, is
 * left as it was and the next space runs; a model failure ends the pass and backs off.
 */
export class BunnySpaceTidyService {
    options;
    abort = new AbortController();
    nowMs;
    retryAtMs = 0;
    failures = 0;
    lastPassMs = 0;
    running = false;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    /** Cancels a model run in progress; later runs return at once. */
    stop() {
        this.abort.abort();
    }
    /** Tidies the spaces past the soft limit, longest first. Never throws: failure warns. */
    async run() {
        if (this.abort.signal.aborted)
            return { status: 'skipped', tidied: 0, reason: 'stopped' };
        if (this.running)
            return { status: 'skipped', tidied: 0, reason: 'already-running' };
        if (this.passedToday())
            return { status: 'skipped', tidied: 0, reason: 'already-tidied' };
        if (this.retryAtMs > this.nowMs())
            return { status: 'skipped', tidied: 0, reason: 'model-backoff' };
        this.running = true;
        try {
            const targets = this.targets();
            if (!targets.length) {
                this.lastPassMs = this.nowMs();
                return { status: 'skipped', tidied: 0, reason: 'nothing-to-tidy' };
            }
            let tidied = 0;
            for (const target of targets) {
                const outcome = await this.tidy(target);
                if (outcome === 'stopped')
                    return { status: 'ok', tidied };
                if (outcome === 'published')
                    tidied += 1;
            }
            this.lastPassMs = this.nowMs();
            return { status: 'ok', tidied };
        }
        catch (error) {
            this.options.warn(error);
            this.backOff();
            return { status: 'skipped', tidied: 0, reason: 'failed' };
        }
        finally {
            this.running = false;
        }
    }
    passedToday() {
        if (!this.lastPassMs)
            return false;
        const now = this.nowMs();
        return (new Date(this.lastPassMs).toDateString() === new Date(now).toDateString() ||
            now - this.lastPassMs < MIN_PASS_INTERVAL_MS);
    }
    /**
     * The spaces past the soft limit, longest first. A space whose locked sections alone reach
     * the soft limit cannot be tidied under it and is skipped.
     */
    targets() {
        return this.options.spaces
            .list()
            .filter((space) => spaceContextNeedsTidy(space.summary))
            .filter((space) => lockedLength(space.summary) < SPACE_CONTEXT_SUMMARY_SOFT_LIMIT)
            .sort((a, b) => b.summary.length - a.summary.length)
            .slice(0, SPACES_PER_RUN);
    }
    /** One space: a model run over a work directory, then the checked write. */
    async tidy(target) {
        if (this.abort.signal.aborted)
            return 'stopped';
        const workDir = await mkdtemp(join(tmpdir(), 'bunny-space-tidy-'));
        try {
            await writeFile(join(workDir, SUMMARY_FILE), target.summary, 'utf8');
            const result = await this.options.model.run({
                prompt: await this.options.readPrompt(),
                briefing: briefing(target),
                tools: tidyTools(workDir),
                signal: this.abort.signal,
            });
            if (this.abort.signal.aborted)
                return 'stopped';
            if (result.status !== 'ok') {
                this.backOff(result.retryAtMs);
                return 'stopped';
            }
            this.failures = 0;
            const summary = parseSpaceContext(await readFile(join(workDir, SUMMARY_FILE), 'utf8'));
            if (!accepted(target, summary)) {
                this.options.warn(new Error(`space tidy left ${target.id} as it was: ${summary.length}`));
                return 'left';
            }
            try {
                await this.options.spaces.publish({
                    id: target.id,
                    revision: target.revision,
                    summary,
                    nowMs: this.nowMs(),
                });
            }
            catch (error) {
                // A stale revision or a failed check: this space waits for the next window.
                this.options.warn(error);
                return 'left';
            }
            return 'published';
        }
        finally {
            await rm(workDir, { recursive: true, force: true });
        }
    }
    backOff(retryAtMs = 0) {
        this.failures += 1;
        this.retryAtMs = Math.max(retryAtMs, this.nowMs() +
            Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.failures - 1, 6)));
    }
}
/**
 * What a rewritten summary must satisfy before it is written: valid at all, under the soft
 * limit, shorter than what it replaces, with the locked sections untouched.
 */
function accepted(target, summary) {
    if (!summary.trim() || summary.length >= target.summary.length)
        return false;
    if (summary.length > SPACE_CONTEXT_SUMMARY_SOFT_LIMIT)
        return false;
    try {
        validateSpaceContextSummary(summary);
    }
    catch {
        return false;
    }
    return SPACE_CONTEXT_LOCKED_SECTIONS.every((heading) => spaceContextLockedSection(summary, heading) ===
        spaceContextLockedSection(target.summary, heading));
}
function lockedLength(summary) {
    return SPACE_CONTEXT_LOCKED_SECTIONS.reduce((total, heading) => total + spaceContextLockedSection(summary, heading).length, 0);
}
/** What the model is told about this space and what it may do. */
function briefing(target) {
    const sections = spaceContextSections(target.summary).map((section) => section.heading || '(开头)');
    return [
        `事项：${target.name}`,
        `当前 summary：${target.summary.length} 个字符，软线 ${SPACE_CONTEXT_SUMMARY_SOFT_LIMIT}。`,
        `小节：${sections.join('、')}`,
        `只改 ${SUMMARY_FILE}；整理后必须短于现在，并且不超过 ${SPACE_CONTEXT_SUMMARY_SOFT_LIMIT} 个字符。`,
        `原样保留：${SPACE_CONTEXT_LOCKED_SECTIONS.map((heading) => `「${heading}」`).join('')}这几节。`,
    ].join('\n');
}
/** The model's file tools: read and list everything, rewrite only `context.md`. */
function tidyTools(workDir) {
    const readOnly = createConsolidationWorkdirTools(workDir).filter((tool) => tool.name === 'list_files' || tool.name === 'read_file');
    const existing = createConsolidationWorkdirTools(workDir).find((tool) => tool.name === 'write_file');
    if (!existing)
        return readOnly;
    return [
        ...readOnly,
        {
            ...existing,
            name: 'write_file',
            description: `Overwrite ${SUMMARY_FILE} with the tidied summary. Nothing else is writable.`,
            parameters: Type.Object({
                path: Type.String({ description: `Only ${SUMMARY_FILE}` }),
                content: Type.String(),
            }, { additionalProperties: false }),
            async execute(args) {
                if (args.path !== SUMMARY_FILE)
                    return { text: `${SUMMARY_FILE} is the only writable file.`, isError: true };
                if (typeof args.content !== 'string')
                    return { text: 'content must be a string.', isError: true };
                try {
                    validateSpaceContextSummary(args.content);
                }
                catch (error) {
                    return { text: String(error), isError: true };
                }
                await writeFile(join(workDir, SUMMARY_FILE), args.content, 'utf8');
                return { text: `Saved ${SUMMARY_FILE}` };
            },
        },
    ];
}
//# sourceMappingURL=space-tidy.service.js.map