import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { replaceFileAtomically } from '../../../../infra/file/jsonl.js';
import { ArtifactCatalogError } from './errors.js';
import { SPACE_CONTEXT_SUMMARY_TAG, spaceContextConflict, spaceContextLockedSectionChanged, spaceContextTidyDidNotShrink, spaceContextTooLong, } from '../../../coordinator-text/index.js';
/**
 * `context.md`: what a space is about and where it stands, next to its files.
 *
 * - `<goal>` mirrors the space's goal in the database (D2). The database is the source; the
 *   block is rewritten whenever the goal changes and is never read back.
 * - `<summary>` is Bunny's: conventions, settled decisions, progress, open questions and next
 *   steps. Only Bunny writes it (task sessions read it); the user may edit the file directly,
 *   so a write carries the revision it was based on and a stale revision is a conflict.
 *
 * A space without `context.md` reads as empty. Reading never creates or changes a file.
 */
export const SPACE_CONTEXT_FILE = 'context.md';
/** Where a tidy moves the summary it replaces, oldest block first. */
export const SPACE_CONTEXT_ARCHIVE_FILE = 'context-archive.md';
/**
 * The summary a write may still grow to, and the point past which it is marked for a tidy.
 *
 * A write is refused only above `LIMIT`; between the soft limit and it the space is tidied in
 * the background, so Bunny is never stopped from recording what it just learned.
 */
export const SPACE_CONTEXT_SUMMARY_LIMIT = 32000;
export const SPACE_CONTEXT_SUMMARY_SOFT_LIMIT = 12000;
/** The sections a tidy may never change: standing rules and questions still awaiting an answer. */
export const SPACE_CONTEXT_LOCKED_SECTIONS = ['约定', '待定问题'];
/** The recommended `<summary>` sections, in order. Not enforced. */
export const SPACE_CONTEXT_SECTIONS = ['约定', '已定事项', '进展', '待定问题', '下一步'];
export class SpaceContextConflictError extends ArtifactCatalogError {
    revision;
    code = 'SPACE_CONTEXT_CONFLICT';
    constructor(revision) {
        super(spaceContextConflict(revision), 409);
        this.revision = revision;
    }
}
export function spaceContextRevision(summary) {
    return createHash('sha256').update(summary).digest('hex').slice(0, 12);
}
/**
 * The `<summary>` of a context.md text; a file without the tags is all summary.
 */
export function parseSpaceContext(text) {
    const goalEnd = text.lastIndexOf('</goal>');
    const start = text.indexOf('<summary>', goalEnd < 0 ? 0 : goalEnd);
    const end = text.lastIndexOf('</summary>');
    if (start >= 0 && end > start)
        return trimBlock(text.slice(start + '<summary>'.length, end));
    const goalStart = text.indexOf('<goal>');
    const withoutGoal = goalStart >= 0 && goalEnd > goalStart
        ? `${text.slice(0, goalStart)}${text.slice(goalEnd + '</goal>'.length)}`
        : text;
    return trimBlock(withoutGoal.replace(/^\s*<!--[\s\S]*?-->/, ''));
}
/** A tag's content without the blank lines and indentation around it. */
function trimBlock(text) {
    return text.trim();
}
/** @internal Exported only for focused tests. */
export function renderSpaceContext(goal, summary) {
    return [
        '<!-- 目标由系统从空间设置同步写出，不要手改；现状（summary）由 Bunny 维护。 -->',
        '<goal>',
        ...(goal.trim() ? [goal.trim()] : []),
        '</goal>',
        '',
        '<summary>',
        ...(summary.trim() ? [summary.trim()] : []),
        '</summary>',
        '',
    ].join('\n');
}
/**
 * The summary a new space starts with: the recommended sections, empty.
 * @internal Exported only for focused tests.
 */
export function spaceContextSkeleton() {
    return SPACE_CONTEXT_SECTIONS.map((heading) => `## ${heading}`).join('\n\n');
}
export function readSpaceContext(directory) {
    const file = path.join(directory, SPACE_CONTEXT_FILE);
    if (existsSync(file)) {
        const summary = parseSpaceContext(readFileSync(file, 'utf8'));
        return { summary, revision: spaceContextRevision(summary), source: 'context' };
    }
    return { summary: '', revision: spaceContextRevision(''), source: 'empty' };
}
export function validateSpaceContextSummary(summary) {
    if (summary.length > SPACE_CONTEXT_SUMMARY_LIMIT)
        throw new ArtifactCatalogError(spaceContextTooLong(summary.length, SPACE_CONTEXT_SUMMARY_LIMIT));
    if (summary.includes('</summary>'))
        throw new ArtifactCatalogError(SPACE_CONTEXT_SUMMARY_TAG);
    return summary.trim();
}
/** Whether a summary is long enough that the background tidy should shrink it. */
export function spaceContextNeedsTidy(summary) {
    return summary.length > SPACE_CONTEXT_SUMMARY_SOFT_LIMIT;
}
/**
 * Rewrites `<summary>` when `revision` is still current, keeping `<goal>` in step with the
 * database: the whole summary, or only the named sections merged into the current one. The
 * merged result passes the same checks as a whole summary. The caller serializes writes to
 * one space.
 */
export async function writeSpaceContext(directory, input) {
    const current = readSpaceContext(directory);
    if (current.revision !== input.revision)
        throw new SpaceContextConflictError(current.revision);
    const next = input.sections
        ? mergeSpaceContextSections(current.summary, input.sections)
        : input.summary;
    const summary = validateSpaceContextSummary(next);
    await replaceFileAtomically(path.join(directory, SPACE_CONTEXT_FILE), renderSpaceContext(input.goal, summary));
    return {
        revision: spaceContextRevision(summary),
        changed: summary !== current.summary,
        summary,
    };
}
/**
 * Replaces a summary the tidy rewrote, after moving the summary it replaces into
 * `context-archive.md`. It refuses a stale revision like any write, a summary over the limit,
 * and any change to a locked section: rules and open questions are Bunny's to retire, not the
 * tidy's. The caller serializes writes to one space.
 */
export async function writeTidiedSpaceContext(directory, input) {
    const current = readSpaceContext(directory);
    if (current.revision !== input.revision)
        throw new SpaceContextConflictError(current.revision);
    const summary = validateSpaceContextSummary(input.summary);
    for (const heading of SPACE_CONTEXT_LOCKED_SECTIONS)
        if (spaceContextLockedSection(summary, heading) !==
            spaceContextLockedSection(current.summary, heading))
            throw new ArtifactCatalogError(spaceContextLockedSectionChanged(heading));
    if (summary.length >= current.summary.length)
        throw new ArtifactCatalogError(spaceContextTidyDidNotShrink(current.summary.length, summary.length));
    await appendSpaceContextArchive(directory, current.summary, input.nowMs);
    // The user may have edited the file by hand while the archive was written: their text wins.
    const latest = readSpaceContext(directory).revision;
    if (latest !== input.revision)
        throw new SpaceContextConflictError(latest);
    await replaceFileAtomically(path.join(directory, SPACE_CONTEXT_FILE), renderSpaceContext(input.goal, summary));
    return {
        revision: spaceContextRevision(summary),
        changed: summary !== current.summary,
        summary,
    };
}
/** Appends one replaced summary to the archive, oldest block first. */
async function appendSpaceContextArchive(directory, summary, nowMs) {
    const file = path.join(directory, SPACE_CONTEXT_ARCHIVE_FILE);
    const previous = existsSync(file) ? readFileSync(file, 'utf8').trimEnd() : '';
    const time = new Date(nowMs).toISOString();
    const block = `## ${time}（${summary.length} 字符）\n\n${summary}`;
    await replaceFileAtomically(file, previous ? `${previous}\n\n${block}\n` : `${block}\n`);
}
const MARKDOWN_HEADING = /^(#{1,6})\s+\S/;
function headingLevel(line) {
    return MARKDOWN_HEADING.exec(line.trim())?.[1]?.length;
}
/**
 * Replaces each named section of a summary. A section runs from its heading line (matched as
 * the whole line, trimmed) to the next heading of the same or a higher level, so its
 * sub-sections go with it. Empty content removes the section; a heading not found is added
 * at the end. Heading-like lines inside fenced or indented code are not headings. Text outside
 * the named sections stays as it is, except blank lines where a section was cut out.
 * @internal Exported only for focused tests.
 */
export function mergeSpaceContextSections(summary, updates) {
    let lines = summary.trim() ? summary.replace(/\r\n/g, '\n').split('\n') : [];
    for (const update of updates) {
        const heading = update.heading.trim();
        const content = update.content.trim();
        const block = content ? [heading, '', ...content.split('\n')] : [];
        const range = sectionRange(lines, heading);
        lines = range
            ? joinParts([lines.slice(0, range.start), block, lines.slice(range.end)])
            : joinParts([lines, block]);
    }
    return lines.join('\n').trim();
}
/** Where the section under `heading` starts and ends (exclusive), or undefined when absent. */
function sectionRange(lines, heading) {
    const structural = structuralLines(lines);
    const start = lines.findIndex((line, index) => structural[index] && line.trim() === heading);
    if (start < 0)
        return undefined;
    const level = headingLevel(heading);
    let end = start + 1;
    while (end < lines.length) {
        const next = structural[end] ? headingLevel(lines[end] ?? '') : undefined;
        if (next !== undefined && (level === undefined || next <= level))
            break;
        end += 1;
    }
    return { start, end };
}
/**
 * Every `## <heading>` section of a summary, heading line and sub-sections included, in order:
 * the text a tidy must keep byte for byte. Headings inside fenced or indented code do not start
 * or end a section, so a rule written after a code example still counts as part of it.
 */
export function spaceContextLockedSection(summary, heading) {
    const lines = summary.replace(/\r\n/g, '\n').split('\n');
    const structural = structuralLines(lines);
    const parts = [];
    for (let start = 0; start < lines.length; start += 1) {
        if (!structural[start] || lines[start]?.trim() !== `## ${heading}`)
            continue;
        let end = start + 1;
        while (end < lines.length && !(structural[end] && (headingLevel(lines[end] ?? '') ?? 7) <= 2))
            end += 1;
        parts.push(trimBlankEdges(lines.slice(start, end)).join('\n'));
        start = end - 1;
    }
    return parts.join('\n\n');
}
/** Lines that can be a heading: outside fenced code and not indented as code. */
function structuralLines(lines) {
    let fence;
    return lines.map((line) => {
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (fence !== undefined) {
            // A closing fence carries no info string, as in session-system/messages/repo/search-match.ts:
            // a nested ```lang line inside the block must not end it, or heading-like lines after it
            // would read as headings and cut the section short.
            if (marker?.startsWith(fence) && line.trim() === marker)
                fence = undefined;
            return false;
        }
        if (marker !== undefined) {
            fence = marker;
            return false;
        }
        return /^ {0,3}\S/.test(line);
    });
}
/** Joins parts with one blank line, trimming blank lines only where two parts meet. */
function joinParts(parts) {
    const kept = parts.map(trimBlankEdges).filter((part) => part.length > 0);
    return kept.flatMap((part, index) => (index === 0 ? [...part] : ['', ...part]));
}
function trimBlankEdges(part) {
    let start = 0;
    let end = part.length;
    while (start < end && !part[start]?.trim())
        start += 1;
    while (end > start && !part[end - 1]?.trim())
        end -= 1;
    return part.slice(start, end);
}
/**
 * Rewrites `<goal>` from the database, keeping the summary. A space that has no context.md yet
 * gets one only when `create` is set (a new space).
 */
export async function syncSpaceContextGoal(directory, goal, options = {}) {
    const file = path.join(directory, SPACE_CONTEXT_FILE);
    if (!existsSync(file)) {
        if (!options.create)
            return false;
        await replaceFileAtomically(file, renderSpaceContext(goal, spaceContextSkeleton()));
        return true;
    }
    const text = readFileSync(file, 'utf8');
    const next = renderSpaceContext(goal, parseSpaceContext(text));
    if (next === text)
        return false;
    await replaceFileAtomically(file, next);
    return true;
}
/** The body of one `## heading` section, or an empty string. */
export function spaceContextSection(summary, heading) {
    return sections(summary).find((section) => section.heading === heading)?.body ?? '';
}
/**
 * The first ~`limit` characters of the summary's non-empty sections, cut at a section boundary
 * when one is close enough, else at a line break.
 */
export function spaceContextExcerpt(summary, limit = 800) {
    const parts = sections(summary);
    const content = parts.length
        ? parts
            .filter((section) => section.body)
            .map((section) => section.heading ? `## ${section.heading}\n${section.body}` : section.body)
            .join('\n\n')
        : summary.trim();
    if (content.length <= limit)
        return content;
    const head = content.slice(0, limit);
    // Prefer a section boundary, then a line break, as long as it keeps at least half the limit.
    const cut = [head.lastIndexOf('\n## '), head.lastIndexOf('\n')].find((index) => index > limit / 2) ?? limit;
    return `${content.slice(0, cut).trimEnd()}\n…`;
}
/** The summary's `## ` sections in order; text before the first heading has an empty heading. */
export function spaceContextSections(summary) {
    return sections(summary);
}
/** `## ` sections of a Markdown text; text before the first heading has an empty heading. */
function sections(text) {
    const result = [];
    let heading = '';
    let lines = [];
    const flush = () => {
        const body = lines.join('\n').trim();
        if (heading || body)
            result.push({ heading, body });
    };
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
        const match = /^## +(.+?)\s*$/.exec(line);
        if (!match) {
            lines.push(line);
            continue;
        }
        flush();
        heading = match[1];
        lines = [];
    }
    flush();
    return result;
}
//# sourceMappingURL=space-context.js.map