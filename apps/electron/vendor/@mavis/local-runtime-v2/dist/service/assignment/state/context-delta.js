import { spaceContextRevision, spaceContextSections } from '../../session-system/index.js';
import { CONTEXT_PREAMBLE_HEADING, contextGoalLine, contextRevisionLine, } from '../../coordinator-text/index.js';
/** Baseline key prefix of one space's context.md: `space:<id>`. */
const SPACE_KEY = 'space:';
export function spaceContextKey(spaceId) {
    return `${SPACE_KEY}${spaceId}`;
}
/** The baseline state of a space's context.md: revision, section hashes and goal. */
function spaceContextState(context) {
    const delivered = {
        r: context.revision,
        s: sectionHashes(context.summary),
        g: context.goal,
    };
    return JSON.stringify(delivered);
}
/**
 * The baseline after Bunny's own `space context write` (spec 9.2). The write
 * required the latest revision, so Bunny had read every earlier edit: the
 * whole summary is absorbed. The goal stays as delivered, since a summary
 * write says nothing about it. Undefined: the space was never delivered.
 */
export function ownContextState(delivered, written) {
    const previous = parse(delivered);
    if (!previous)
        return undefined;
    return spaceContextState({ ...written, goal: previous.g });
}
/**
 * The baseline after Bunny changed a space goal itself: only the goal is
 * absorbed, so a summary edit the user made in between still shows up.
 * Undefined: the space was never delivered.
 */
export function ownGoalState(delivered, goal) {
    const previous = parse(delivered);
    return previous ? JSON.stringify({ ...previous, g: goal }) : undefined;
}
/**
 * Spaces whose context.md changed outside Bunny since the last delivery
 * (spec 9.2): the new summary revision with the sections that changed, and a
 * changed goal. Bunny's own `space context write` and goal updates are
 * absorbed into the baseline when they happen, so only the user's edits show
 * up here. Without a baseline the full block lists no space lines: the state
 * is only recorded. A space that cannot be read writes no line, keeps its
 * baseline and is listed in `unreadable`.
 */
export function renderContextDelta(input) {
    const lines = [];
    const updates = new Map();
    const unreadable = [];
    for (const space of input.spaces) {
        let current;
        try {
            current = input.read(space.id);
        }
        catch {
            unreadable.push(space);
            continue;
        }
        const key = spaceContextKey(space.id);
        const previous = parse(input.baseline?.get(key));
        if (previous?.r === current.revision && previous.g === current.goal)
            continue;
        updates.set(key, spaceContextState(current));
        // A space never delivered before (a new space, a first block) is current state, not news.
        if (!input.baseline || !previous)
            continue;
        lines.push(...contextLines(space, current, previous, input.safe));
    }
    return { lines, updates, unreadable };
}
function contextLines(space, current, previous, safe) {
    const name = { name: safe(space.name), id: safe(space.id) };
    const lines = [];
    if (previous.r !== current.revision) {
        const changed = changedSections(previous.s, sectionHashes(current.summary));
        lines.push(contextRevisionLine(name, current.revision, changed.map(safe)));
    }
    if (previous.g !== current.goal)
        lines.push(contextGoalLine(name, safe(current.goal)));
    return lines;
}
/** Sections added, changed or removed, in the current order, then the removed ones. */
function changedSections(before, after) {
    const changed = Object.keys(after).filter((heading) => before[heading] !== after[heading]);
    const removed = Object.keys(before).filter((heading) => !(heading in after));
    return [...changed, ...removed];
}
function sectionHashes(summary) {
    const hashes = {};
    for (const section of spaceContextSections(summary)) {
        const heading = section.heading || CONTEXT_PREAMBLE_HEADING;
        // A repeated heading is one section to the reader: hash the bodies together.
        const body = heading in hashes ? `${hashes[heading]}\n${section.body}` : section.body;
        hashes[heading] = spaceContextRevision(body);
    }
    return hashes;
}
function parse(value) {
    if (!value)
        return undefined;
    try {
        const parsed = JSON.parse(value);
        if (parsed &&
            typeof parsed === 'object' &&
            typeof Reflect.get(parsed, 'r') === 'string' &&
            typeof Reflect.get(parsed, 'g') === 'string' &&
            typeof Reflect.get(parsed, 's') === 'object' &&
            Reflect.get(parsed, 's') !== null)
            return parsed;
    }
    catch {
        // A damaged entry is treated as never delivered.
    }
    return undefined;
}
//# sourceMappingURL=context-delta.js.map