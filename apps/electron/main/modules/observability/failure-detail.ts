import { homedir } from "node:os";
/**
 * Telemetry bound for failure details. Upstream validation allows up to
 * MAX_RUNTIME_INIT_FAILURE_DETAIL_LENGTH (2048) for logs/UI; observability
 * payloads stay smaller so attribute pipelines never clip mid-field.
 */
const MAX_FAILURE_DETAIL_PAYLOAD_LENGTH = 500;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
/**
 * Diagnostics embed absolute paths (SQLITE_CANTOPEN, module resolution) that
 * contain the OS username. Telemetry must not become a path/identity channel,
 * so the home directory is redacted before the detail leaves the machine;
 * local logs and the startup-failure UI keep the full value. Shared between
 * the emit sites and the outbox boundary so every caller gets the same
 * redaction, not just the utility runtime observer.
 *
 * The same home directory reaches us in three spellings: the native
 * `homedir()` form (`C:\Users\Admin` on Windows), the forward-slash form that
 * stack frames use inside `file://` URLs (`file:///C:/Users/Admin/...`), and
 * the percent-encoded form of that URL — ESM module URLs escape spaces and
 * non-ASCII, so `My Name` arrives as `My%20Name` and `张三` as
 * `%E5%BC%A0%E4%B8%89`. Redacting only the native form leaks the username
 * through every ESM stack trace, so all variants are replaced (they collapse
 * to fewer entries whenever the spellings coincide, e.g. an ASCII home on
 * POSIX). `encodeURI` is used rather than `pathToFileURL` because the latter
 * resolves relative to the cwd instead of escaping the given path.
 */
export function boundFailureDetail(detail) {
    const home = homedir();
    let redacted = detail;
    if (home) {
        const slashHome = home.replace(/\\/g, '/');
        const homeVariants = new Set([home, slashHome, encodeURI(slashHome)]);
        for (const variant of homeVariants) {
            const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            redacted = redacted.replace(new RegExp(escaped, process.platform === 'win32' ? 'gi' : 'g'), '~');
        }
    }
    if (redacted.length <= MAX_FAILURE_DETAIL_PAYLOAD_LENGTH)
        return redacted;
    let head = redacted.slice(0, MAX_FAILURE_DETAIL_PAYLOAD_LENGTH - 1);
    const lastCode = head.charCodeAt(head.length - 1);
    if (lastCode >= HIGH_SURROGATE_START && lastCode <= HIGH_SURROGATE_END) {
        head = head.slice(0, -1);
    }
    return `${head}…`;
}
