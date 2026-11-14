import { renderTaskFirstMessage } from '../coordinator-text/index.js';
import { reviewTargetSection } from './review-target.js';
/** `<sid8>-<slug>`: a task's entry under its space's `artifacts/`. */
export function assignmentEntryName(sessionId, title) {
    const slug = title
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'task';
    return `${sessionId.replace(/^mvs_/, '').slice(0, 8)}-${slug}`;
}
export function validateCreateInput(input) {
    if (input.project !== undefined && !input.project.trim())
        throw new Error('project must not be empty');
    if (input.takesOver !== undefined && !input.takesOver.trim())
        throw new Error('takes_over must not be empty');
    for (const field of ['title', 'content', 'userWords']) {
        if (!input[field]?.trim())
            throw new Error(`${field} is required`);
    }
}
/**
 * The task's first message (requirement 3.1): Bunny's instruction, the done-when
 * criteria, then the user's own words it came from, quoted line by line (R4.1).
 *
 * A review dispatch also carries the `<review-target>` block: what the checked task recorded
 * about itself, which the reviewer has no tool to read for itself. Without `reviewTarget` the
 * message is byte-for-byte the one an ordinary dispatch writes.
 */
export function taskInstruction(input, reviewTarget) {
    return (renderTaskFirstMessage({
        content: input.content,
        criteria: (input.doneWhen ?? []).map((item) => item.trim()).filter(Boolean),
        userWords: input.userWords,
    }) + reviewTargetSection(reviewTarget));
}
/** A project task's `.link.json`: a pointer to where it runs, never a copy of its files. */
export function assignmentLink(input) {
    const link = {
        schemaVersion: 1,
        session_id: input.sessionId,
        title: input.title,
        path: input.path,
        run_location: input.runLocation,
        created_at_ms: input.createdAtMs,
    };
    return `${JSON.stringify(link, null, 2)}\n`;
}
/** Why an explicit close happened: Bunny closing its task is its review's verdict. */
export function closureReason(input) {
    if (input.state === 'cancelled')
        return 'cancelled';
    return input.by === 'user' ? 'user_marked' : 'review_passed';
}
//# sourceMappingURL=task-input.js.map