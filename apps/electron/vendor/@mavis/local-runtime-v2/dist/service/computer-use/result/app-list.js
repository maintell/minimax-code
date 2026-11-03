import { booleanValue, definedFields, isRecord, stringValue } from './action-data.js';
/**
 * PTC `data` of computer_app_list, matching what its output lists: with a
 * name, every matching app (the facade's filter already narrowed the native
 * list); without one, the counts and running apps of the native summary and
 * the active apps the host reports beside it.
 */
export function appListData({ structured, failed, input, }) {
    if (failed)
        return definedFields({ code: stringValue(structured?.code) });
    const apps = Array.isArray(structured?.apps) ? structured.apps.filter(isRecord) : undefined;
    if (!apps)
        return {};
    if (appNameFilter(input))
        return { apps: apps.flatMap(namedApp) };
    const running = apps.filter(isRunning);
    return {
        counts: {
            total: apps.length,
            running: running.length,
            installedNotRunning: apps.length - running.length,
        },
        running: running.flatMap(appIdentity),
        activeApps: apps.filter((app) => app.active === true).flatMap(appIdentity),
    };
}
/** Same condition as the facade filter (computer-use mapping normalizeCuaResult). */
function appNameFilter(input) {
    return typeof input?.name === 'string' ? input.name.trim().toLowerCase() : '';
}
/** Arguments the host handles itself; the driver call never sees them. */
export const APP_LIST_PAGE_ARGUMENTS = ['scope', 'offset', 'limit'];
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
/**
 * scope installed or all without a name: one page of the native inventory,
 * which already holds every app (the unfiltered native summary lists only
 * running ones). Rows use the native running-list format; an app that is
 * not running has no pid. Anything else keeps the native output unchanged.
 */
export function appListPage(structured, input) {
    const scope = input?.scope;
    if (appNameFilter(input) || (scope !== 'installed' && scope !== 'all'))
        return undefined;
    const apps = Array.isArray(structured?.apps) ? structured.apps.filter(isRecord) : undefined;
    if (!apps)
        return undefined;
    const running = apps.filter(isRunning).length;
    const counts = { total: apps.length, running, installedNotRunning: apps.length - running };
    const inScope = apps.filter((app) => Boolean(stringValue(app.name)) && (scope === 'all' || !isRunning(app)));
    const offset = pageNumber(input?.offset, 0, 0);
    const limit = Math.min(pageNumber(input?.limit, DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
    const summary = `Found ${counts.total} app(s): ${counts.running} running, ${counts.installedNotRunning} installed-not-running.`;
    const scopeName = scope === 'all' ? 'apps' : 'installed apps that are not running';
    if (offset > 0 && offset >= inScope.length) {
        const code = 'computer_app_list_offset_out_of_range';
        return {
            text: `${code}: offset ${offset} is past the last of ${inScope.length} ${scopeName}. ${summary} Use an offset below ${inScope.length}.`,
            failed: true,
            data: { code },
        };
    }
    const page = inScope.slice(offset, offset + limit);
    return {
        text: [summary, ...page.map(appRow), pageFooter(offset, page.length, inScope.length)].join('\n'),
        failed: false,
        data: {
            counts,
            page: { offset, limit, returned: page.length },
            apps: page.map((app) => definedFields({
                name: app.name,
                pid: appPid(app),
                bundleId: bundleId(app),
                running: isRunning(app),
            })),
        },
    };
}
function pageFooter(offset, returned, total) {
    if (returned === 0)
        return `Showing 0 of ${total}.`;
    const end = offset + returned;
    const more = end < total ? `; pass offset=${end} for more` : '';
    return `Showing ${offset + 1}–${end} of ${total}${more}.`;
}
function appRow(app) {
    const pid = appPid(app);
    const id = bundleId(app);
    return `- ${String(app.name)}${pid !== undefined && isRunning(app) ? ` (pid ${pid})` : ''}${id ? ` [${id}]` : ''}`;
}
/** The schema already bounds these; a direct caller gets the defaults instead. */
function pageNumber(value, fallback, minimum) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
        ? value
        : fallback;
}
function isRunning(app) {
    return app.running === true;
}
function appIdentity(app) {
    const name = stringValue(app.name);
    if (!name)
        return [];
    return [definedFields({ name, pid: appPid(app), bundleId: bundleId(app) })];
}
function namedApp(app) {
    const name = stringValue(app.name);
    if (!name)
        return [];
    return [
        definedFields({
            name,
            pid: appPid(app),
            bundleId: bundleId(app),
            launchPath: stringValue(app.launch_path),
            running: booleanValue(app.running),
            active: booleanValue(app.active),
        }),
    ];
}
/** The native list reports pid 0 for an app that is not running. */
function appPid(app) {
    return typeof app.pid === 'number' && Number.isSafeInteger(app.pid) && app.pid > 0
        ? app.pid
        : undefined;
}
function bundleId(app) {
    return stringValue(app.bundle_id) ?? stringValue(app.bundleId);
}
//# sourceMappingURL=app-list.js.map