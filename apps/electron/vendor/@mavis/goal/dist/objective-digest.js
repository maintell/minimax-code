import { createHash } from 'node:crypto';
/** Stable full SHA-256 identity for one exact Goal objective. */
export function digestThreadGoalObjective(objective) {
    return createHash('sha256').update(objective).digest('hex');
}
//# sourceMappingURL=objective-digest.js.map