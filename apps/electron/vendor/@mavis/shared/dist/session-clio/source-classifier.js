/**
 * Conservative provenance classification for Session Clio capture.
 *
 * This decides two load-bearing things, so it is an allow-list and its default
 * is "do not capture":
 *   - whether a message is a genuine user Query at all (`internal` is dropped);
 *   - whether it advances the 72h inactivity clock (`manual` does, `automatic`
 *     only starts it for an auto-only Session).
 *
 * Misclassifying a background continuation or an agent-to-agent message as user
 * intent would both pollute the tagging input and silently extend a Session's
 * life, so anything not explicitly listed here is `internal`.
 */
/** Sources that represent a person actually asking something. */
const MANUAL_SOURCES = ['api', 'code_review', 'channel'];
/** Prefix for per-channel manual sources such as `channel:feishu`. */
const MANUAL_SOURCE_PREFIX = 'channel:';
/**
 * Sources that represent a user-configured scheduled task firing.
 *
 * Only cron provenance qualifies. A cron Session is a standing instruction the
 * user really wrote, which is why it is captured at all — but it is `automatic`,
 * so it starts the clock without ever resetting it.
 */
const AUTOMATIC_SOURCES = ['cron'];
/** Prefix minted by `createCronSessionPurpose`, i.e. `cron:<agent>:<name>`. */
const AUTOMATIC_SOURCE_PREFIX = 'cron:';
/**
 * Classify a message/session source string.
 *
 * `internal` covers everything that is not a genuine user instruction:
 * background continuations, tool and task notifications, team/agent-to-agent
 * traffic, and every source this module has not been taught about.
 */
export function classifySessionClioSource(source) {
    const value = source.trim().toLowerCase();
    if (value === '')
        return 'internal';
    if (MANUAL_SOURCES.includes(value))
        return 'manual';
    if (value.startsWith(MANUAL_SOURCE_PREFIX))
        return 'manual';
    if (AUTOMATIC_SOURCES.includes(value))
        return 'automatic';
    if (value.startsWith(AUTOMATIC_SOURCE_PREFIX))
        return 'automatic';
    return 'internal';
}
//# sourceMappingURL=source-classifier.js.map