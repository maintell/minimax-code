import { BUNNY_FAILURE_CODES, } from '@mavis/shared/local-runtime-logging/metric-registry';
/** A failure's `code`: plain, short, the shape a metric label takes. */
const TOKEN = /^[A-Za-z0-9_]{1,64}$/;
/**
 * A failure's stable code: the error's own `code` when it is one (`SQLITE_BUSY`, `ENOENT`),
 * else its class name (`TypeError`), else `unknown`. Never the message.
 */
export function failureCode(error) {
    if (typeof error === 'object' && error !== null) {
        const code = Reflect.get(error, 'code');
        if (typeof code === 'string' && TOKEN.test(code))
            return code;
        const name = Reflect.get(error, 'name');
        if (typeof name === 'string' && name !== 'Error' && TOKEN.test(name))
            return name;
    }
    return 'unknown';
}
const METRIC_CODES = new Set(BUNNY_FAILURE_CODES);
/** The primary result code of an extended SQLite one: SQLITE_IOERR of SQLITE_IOERR_SHORT_READ. */
const SQLITE_PRIMARY_CODE = /^SQLITE_[A-Z]+/;
/**
 * A failure's `code` label of `bunny_failure_total`: its {@link failureCode} as lower
 * snake_case (`SQLITE_BUSY` is sqlite_busy, `TypeError` type_error), an extended SQLite code
 * as its primary one, and `other` for anything the closed list does not name.
 */
export function failureMetricCode(error) {
    const code = failureCode(error);
    const primary = SQLITE_PRIMARY_CODE.exec(code)?.[0] ?? code;
    const label = primary.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    return METRIC_CODES.has(label) ? label : 'other';
}
const DETAIL_MAX_LENGTH = 200;
/** Absolute POSIX or Windows paths, and `file:` URLs. */
const PATHS = /(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'"`<>()[\]{},;]*/gu;
/**
 * A failure's message for the local log only: paths replaced, cut to 200 characters. It
 * never goes into a metric.
 */
export function failureDetail(error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = message.replace(PATHS, '<path>');
    return detail.length > DETAIL_MAX_LENGTH ? `${detail.slice(0, DETAIL_MAX_LENGTH - 1)}…` : detail;
}
//# sourceMappingURL=sanitize.js.map