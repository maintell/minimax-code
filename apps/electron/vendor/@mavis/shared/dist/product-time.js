const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const FOUR_DAYS_MS = 4 * DAY_MS;
const RECENT_CALENDAR_DAYS = 7;
const EN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ZH_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DEFAULT_TIME_ZONE = (() => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    }
    catch {
        return 'UTC';
    }
})();
const formatterCache = new Map();
function getFormatter(timeZone) {
    const cached = formatterCache.get(timeZone);
    if (cached)
        return cached;
    const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
    return formatter;
}
function getZonedDateParts(timestampMs, timeZone) {
    const values = {};
    for (const part of getFormatter(timeZone).formatToParts(timestampMs)) {
        if (part.type !== 'literal')
            values[part.type] = part.value;
    }
    return {
        year: Number(values.year),
        month: Number(values.month),
        day: Number(values.day),
        hour: Number(values.hour),
        minute: Number(values.minute),
    };
}
function resolveLocale(locale) {
    return (locale ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
function padTwo(value) {
    return String(value).padStart(2, '0');
}
function formatTime(parts) {
    return `${padTwo(parts.hour)}:${padTwo(parts.minute)}`;
}
function isSameDay(left, right) {
    return left.year === right.year && left.month === right.month && left.day === right.day;
}
function formatDate(parts, locale, includeYear) {
    const month = padTwo(parts.month);
    const day = padTwo(parts.day);
    if (!includeYear)
        return locale === 'zh' ? `${month}-${day}` : `${month}/${day}`;
    return locale === 'zh' ? `${parts.year}-${month}-${day}` : `${month}/${day}/${parts.year}`;
}
function formatDateTime(parts, locale, includeYear) {
    return `${formatDate(parts, locale, includeYear)} ${formatTime(parts)}`;
}
function calendarDayIndex(parts) {
    return Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS;
}
function formatWeekday(parts, locale) {
    const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    const labels = locale === 'zh' ? ZH_WEEKDAYS : EN_WEEKDAYS;
    return labels[weekday] ?? labels[0];
}
function formatSocialTime(timestampMs, nowMs, timestamp, now, locale, precise) {
    const sameYear = timestamp.year === now.year;
    if (timestampMs > nowMs) {
        return precise
            ? formatDateTime(timestamp, locale, !sameYear)
            : formatDate(timestamp, locale, !sameYear);
    }
    const elapsedMs = nowMs - timestampMs;
    if (elapsedMs < MINUTE_MS)
        return locale === 'zh' ? '刚刚' : 'Now';
    if (isSameDay(timestamp, now))
        return formatTime(timestamp);
    const dayDelta = calendarDayIndex(now) - calendarDayIndex(timestamp);
    if (dayDelta === 1) {
        const yesterday = locale === 'zh' ? '昨天' : 'Yesterday';
        return `${yesterday} ${formatTime(timestamp)}`;
    }
    if (dayDelta > 1 && dayDelta < RECENT_CALENDAR_DAYS) {
        const weekday = formatWeekday(timestamp, locale);
        return precise ? `${weekday} ${formatTime(timestamp)}` : weekday;
    }
    return precise
        ? formatDateTime(timestamp, locale, !sameYear)
        : formatDate(timestamp, locale, !sameYear);
}
function formatCommunityTime(timestampMs, nowMs, timestamp, now, locale) {
    const sameYear = timestamp.year === now.year;
    if (timestampMs > nowMs)
        return formatDate(timestamp, locale, !sameYear);
    const elapsedMs = nowMs - timestampMs;
    if (elapsedMs < MINUTE_MS)
        return locale === 'zh' ? '刚刚' : 'Now';
    if (elapsedMs < HOUR_MS) {
        const minutes = Math.floor(elapsedMs / MINUTE_MS);
        return locale === 'zh' ? `${minutes}分钟前` : `${minutes}m`;
    }
    if (elapsedMs < DAY_MS) {
        const hours = Math.floor(elapsedMs / HOUR_MS);
        return locale === 'zh' ? `${hours}小时前` : `${hours}h`;
    }
    if (elapsedMs < FOUR_DAYS_MS) {
        const days = Math.floor(elapsedMs / DAY_MS);
        return locale === 'zh' ? `${days}天前` : `${days}d`;
    }
    return formatDate(timestamp, locale, !sameYear);
}
/**
 * Project-wide UI timestamp calculator.
 *
 * Input must be Unix milliseconds. Choose a semantic preset instead of assembling date patterns
 * at a call site. See `.harness/docs/design/time-display.md` for preset selection and exclusions.
 */
export function formatProductTime(timestampMs, options) {
    if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs))
        return '';
    const nowMs = options.nowMs ?? Date.now();
    if (!Number.isFinite(nowMs))
        return '';
    const locale = resolveLocale(options.locale);
    const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
    const timestamp = getZonedDateParts(timestampMs, timeZone);
    const now = getZonedDateParts(nowMs, timeZone);
    const sameYear = timestamp.year === now.year;
    switch (options.preset) {
        case 'social-precise':
            return formatSocialTime(timestampMs, nowMs, timestamp, now, locale, true);
        case 'social-compact':
            return formatSocialTime(timestampMs, nowMs, timestamp, now, locale, false);
        case 'community-relative':
            return formatCommunityTime(timestampMs, nowMs, timestamp, now, locale);
        case 'common-precise':
            return isSameDay(timestamp, now)
                ? formatTime(timestamp)
                : formatDateTime(timestamp, locale, !sameYear);
        case 'common-date':
            return isSameDay(timestamp, now)
                ? formatTime(timestamp)
                : formatDate(timestamp, locale, !sameYear);
        case 'audit-datetime':
            return formatDateTime(timestamp, locale, true);
        case 'audit-date':
            return formatDate(timestamp, locale, true);
    }
}
//# sourceMappingURL=product-time.js.map