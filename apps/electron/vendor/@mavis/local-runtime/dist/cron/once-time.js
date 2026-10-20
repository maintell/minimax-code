export function parseOnceRunAtMs(req, now) {
    const hasAfter = typeof req.after === 'string' && req.after.trim().length > 0;
    const hasAt = req.at !== undefined && String(req.at).trim().length > 0;
    if (hasAfter === hasAt) {
        throw Object.assign(new Error('cron once requires exactly one of `after` or `at`'), {
            status: 400,
            statusCode: 400,
            code: 'VALIDATION_ERROR',
        });
    }
    const runAtMs = hasAfter ? now + parseDurationMs(req.after) : parseAtMs(req.at, req.timezone);
    if (!Number.isFinite(runAtMs) || runAtMs <= now) {
        throw Object.assign(new Error('cron once target time must be in the future'), {
            status: 400,
            statusCode: 400,
            code: 'VALIDATION_ERROR',
        });
    }
    return runAtMs;
}
export function parseAtMs(input, timezone) {
    if (typeof input === 'number') {
        if (timezone)
            validateTimeZone(timezone);
        return input;
    }
    const raw = input.trim();
    if (timezone)
        validateTimeZone(timezone);
    if (/^\d+$/.test(raw))
        return Number(raw);
    const wallClock = parseWallClockWithoutOffset(raw);
    if (timezone && wallClock)
        return zonedWallClockToEpochMs(wallClock, timezone);
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(raw)
        ? raw.replace(' ', 'T')
        : raw;
    const parsed = Date.parse(normalized);
    if (Number.isNaN(parsed)) {
        throw Object.assign(new Error(`Invalid cron once at time: ${JSON.stringify(input)}`), {
            status: 400,
            statusCode: 400,
            code: 'VALIDATION_ERROR',
        });
    }
    return parsed;
}
function parseWallClockWithoutOffset(input) {
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input);
    if (!match)
        return undefined;
    return {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: match[6] ? Number(match[6]) : 0,
    };
}
function validateTimeZone(timezone) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    }
    catch {
        throw Object.assign(new Error(`Invalid cron once timezone: ${JSON.stringify(timezone)}`), {
            status: 400,
            statusCode: 400,
            code: 'VALIDATION_ERROR',
        });
    }
}
function zonedWallClockToEpochMs(parts, timezone) {
    const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    let utcMs = localAsUtc - getTimeZoneOffsetMs(timezone, localAsUtc);
    utcMs = localAsUtc - getTimeZoneOffsetMs(timezone, utcMs);
    const resolved = getWallClockParts(timezone, utcMs);
    if (resolved.year !== parts.year ||
        resolved.month !== parts.month ||
        resolved.day !== parts.day ||
        resolved.hour !== parts.hour ||
        resolved.minute !== parts.minute ||
        resolved.second !== parts.second) {
        throw Object.assign(new Error(`Invalid cron once at time for timezone ${timezone}: nonexistent wall-clock time`), {
            status: 400,
            statusCode: 400,
            code: 'VALIDATION_ERROR',
        });
    }
    return utcMs;
}
function getTimeZoneOffsetMs(timezone, utcMs) {
    const parts = getWallClockParts(timezone, utcMs);
    const zonedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return zonedAsUtc - utcMs;
}
function getWallClockParts(timezone, utcMs) {
    const formatted = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour12: false,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const value = (type) => {
        const part = formatted.find((item) => item.type === type)?.value;
        if (!part)
            throw new Error(`Missing ${type} while formatting timezone ${timezone}`);
        return Number(part);
    };
    return {
        year: value('year'),
        month: value('month'),
        day: value('day'),
        hour: value('hour'),
        minute: value('minute'),
        second: value('second'),
    };
}
const DURATION_UNIT_MS = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
};
function parseDurationMs(input) {
    const raw = input.trim().toLowerCase();
    // Consume one anchored `<number><unit>` token at a time: a start-anchored pattern cannot be
    // retried from every offset, so long digit runs fail in linear rather than quadratic time.
    // `ms` must precede `m` so millisecond tokens are not split into minutes plus a stray `s`.
    const token = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/;
    let total = 0;
    let rest = raw;
    while (rest) {
        const match = token.exec(rest);
        if (!match)
            break;
        const value = Number(match[1]);
        const unit = match[2];
        total += value * DURATION_UNIT_MS[unit];
        rest = rest.slice(match[0].length);
    }
    if (!total || rest) {
        throw Object.assign(new Error(`Invalid cron once after duration: ${JSON.stringify(input)}`), {
            status: 400,
            statusCode: 400,
            code: 'VALIDATION_ERROR',
        });
    }
    return Math.floor(total);
}
//# sourceMappingURL=once-time.js.map