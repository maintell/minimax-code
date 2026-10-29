import { release } from 'node:os';
import { parse as parsePath } from 'node:path';
export async function callCuaToolWithDeliveryMode(runtime, name, payload, signal) {
    const shortcutRefusal = foregroundShortcutRefusal(runtime.driverVersion, name, payload);
    if (shortcutRefusal)
        return shortcutRefusal;
    if (shouldAvoidNativeBackgroundClick(runtime.driverVersion, name, payload, process.platform)) {
        return {
            isError: true,
            text: 'Background coordinate click was NOT sent: this CUA version has an unsafe background pixel path. The requested background mode was preserved; no foreground retry occurred. Use a fresh accessible element token if supported. Tell the user you will work in the foreground before retrying this action with foreground delivery, unless the user requires background-only. Do not silently retry or bypass target ownership checks.',
            structuredJson: JSON.stringify({
                code: 'computer_background_coordinate_unavailable',
                effect: 'refused',
            }),
        };
    }
    return runtime.callTool(name, payload, signal);
}
/** macOS 14.6 crash dumps identify activate_without_raise -> SLPSPostEventRecordTo. */
export function shouldAvoidNativeBackgroundClick(driverVersion, name, payload, platform = process.platform) {
    if (platform !== 'darwin' || driverVersion !== '0.22.1')
        return false;
    if (name !== 'click' || payload.delivery_mode === 'foreground')
        return false;
    if ((payload.button ?? 'left') !== 'left')
        return false;
    return (isRecord(payload.target) &&
        payload.target.kind === 'window' &&
        typeof payload.x === 'number' &&
        typeof payload.y === 'number');
}
function isUnsafeWindowChord(name, payload) {
    if (name === 'press_key')
        return Array.isArray(payload.modifiers) && payload.modifiers.length > 0;
    if (name !== 'hotkey' || !Array.isArray(payload.keys) || payload.keys.length < 2)
        return false;
    // Token-only hotkeys use the same unsafe foreground keyboard path. Coordinate
    // hotkeys explicitly focus a control and use the separate flagged HID route.
    return typeof payload.x !== 'number' || typeof payload.y !== 'number';
}
/** Refuse the observed modifier-loss path before it can insert a bare letter. */
export function foregroundShortcutRefusal(driverVersion, name, payload, platform = process.platform, osRelease = release()) {
    if (platform !== 'darwin' || !osRelease.startsWith('23.') || driverVersion !== '0.22.1')
        return;
    if (payload.delivery_mode !== 'foreground')
        return;
    if (!isRecord(payload.target) || payload.target.kind !== 'window')
        return;
    if (!isUnsafeWindowChord(name, payload))
        return;
    return {
        isError: true,
        text: 'Window shortcut was NOT sent: CUA 0.22.1 on macOS 14 can drop modifiers in foreground window input and insert the base letter. For window or application commands, first inspect the exact window for the intended button or observed menu path, and use computer_click or computer_secondary_action. Do not click arbitrary list/document content just to focus a window. For a shortcut that needs a particular input control, inspect computer_app_state with include_screenshot:true, then use computer_key with delivery_mode:foreground and x/y inside that intended control; omit element_token. This coordinate path performs a real click BEFORE the guarded hotkey: even if the key is refused, selection, navigation or rename state may already have changed. Re-observe after failure; do not infer that nothing happened. Otherwise inspect computer_desktop_state, locate the intended app/control on the primary display, click it with scope:"desktop", verify focus, then send the shortcut with scope:"desktop" and omit pid/window_ref/element_token. Stop if the target is not visible. For editable values use a fresh element token with computer_set_value.',
        structuredJson: JSON.stringify({
            code: 'computer_foreground_shortcut_unavailable',
            dispatched: false,
        }),
    };
}
function parseStructuredResult(value) {
    if (!isRecord(value))
        return undefined;
    const raw = value.structuredJson ?? value.rawJson;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return isRecord(parsed) ? parsed : undefined;
        }
        catch {
            return undefined;
        }
    }
    return isRecord(raw) ? raw : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseJson(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
export function normalizeCuaResult(request, value) {
    if (request.kind === 'window_list')
        return normalizeWindowListResult(request, value);
    if (request.kind === 'app_launch')
        return normalizeWindowBearingResult(value);
    if (request.kind !== 'app_list')
        return value;
    const filter = typeof request.payload.name === 'string' ? request.payload.name.trim().toLowerCase() : '';
    if (!filter)
        return value;
    const record = value && typeof value === 'object' ? value : undefined;
    const parse = (raw) => {
        if (typeof raw !== 'string')
            return raw;
        try {
            return JSON.parse(raw);
        }
        catch {
            return raw;
        }
    };
    const parsed = parse(record?.structuredJson ?? value);
    if (!parsed || typeof parsed !== 'object')
        return value;
    const apps = Array.isArray(parsed.apps)
        ? parsed.apps
        : undefined;
    if (!apps)
        return value;
    const matches = apps.filter((app) => {
        if (!app || typeof app !== 'object')
            return false;
        const item = app;
        return [item.name, item.bundle_id, item.bundleId, item.path, item.launch_path].some((candidate) => typeof candidate === 'string' && candidate.toLowerCase().includes(filter));
    });
    const next = { ...parsed, apps: matches };
    if (record?.structuredJson !== undefined)
        return { ...record, text: JSON.stringify(next), structuredJson: JSON.stringify(next) };
    return next;
}
/** Resolve a localized display name or exact executable bundle name before launching. */
async function resolveLaunchIdentity(runtime, payload, signal) {
    const launch = pick(payload, ['name', 'bundle_id', 'urls', 'session']);
    if (typeof payload.launch_path === 'string' && payload.launch_path.trim()) {
        if (process.platform !== 'win32')
            throw new Error('computer_launch_path_windows_only');
        return { ...launch, launch_path: payload.launch_path };
    }
    if (typeof payload.bundle_id === 'string' && payload.bundle_id.trim())
        return launch;
    const name = typeof payload.name === 'string' ? payload.name.trim().toLowerCase() : '';
    if (!name)
        return launch;
    const inventory = await runtime.callTool('list_apps', { session: payload.session }, signal);
    const apps = parseStructuredResult(inventory)?.apps;
    if (!Array.isArray(apps))
        return launch;
    const matches = apps.filter((app) => {
        if (!isRecord(app) || typeof app.bundle_id !== 'string' || !app.bundle_id.trim()) {
            return false;
        }
        const executableName = typeof app.launch_path === 'string' ? parsePath(app.launch_path).name : '';
        const bundleName = app.bundle_id.split('.').at(-1);
        return [app.name, app.bundle_id, executableName, bundleName].some((candidate) => typeof candidate === 'string' && candidate.toLowerCase() === name);
    });
    const bundleIds = new Set(matches.map((app) => app.bundle_id));
    if (bundleIds.size > 1) {
        throw new Error('computer_app_name_ambiguous: use computer_app_list and an exact bundle_id');
    }
    if (bundleIds.size === 1)
        launch.bundle_id = [...bundleIds][0];
    return launch;
}
function normalizeWindowListResult(request, value) {
    return normalizeWindowBearingResult(value, requirePositivePid(request.payload.pid));
}
function normalizeWindowBearingResult(value, requestedPid) {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
    const raw = record?.structuredJson ?? record?.rawJson ?? value;
    const parsed = typeof raw === 'string' ? parseJson(raw) : raw;
    if (!parsed || typeof parsed !== 'object')
        return value;
    const parsedPid = parsed.pid;
    const pid = requestedPid ??
        (typeof parsedPid === 'number' && Number.isInteger(parsedPid) && parsedPid > 0
            ? parsedPid
            : undefined);
    if (!pid)
        return value;
    const windows = Array.isArray(parsed.windows)
        ? parsed.windows
        : undefined;
    if (!windows)
        return value;
    const normalized = {
        ...parsed,
        pid,
        windows: windows.map((entry) => {
            if (!entry || typeof entry !== 'object')
                return entry;
            const item = entry;
            const windowId = item.window_id ?? item.windowId;
            if (typeof windowId !== 'number' || !Number.isInteger(windowId) || windowId <= 0)
                return item;
            return { ...item, pid, window_ref: `w:${pid}:${windowId}` };
        }),
    };
    if (!record)
        return normalized;
    const structuredJson = JSON.stringify(normalized);
    return { ...record, text: structuredJson, structuredJson };
}
/**
 * Stable product facade -> CUA's canonical tool inventory.  The product
 * surface intentionally stays small and namespaced as `computer_*`; the
 * native SDK remains the source of truth for tool semantics and schemas.
 */
/** Explicit AX semantics must never degrade into a pixel click or an unrelated default action. */
export function validateClickAction(payload, platform = process.platform) {
    if (payload.action === undefined || payload.action === 'auto')
        return;
    if (platform !== 'darwin' ||
        typeof payload.action !== 'string' ||
        !['press', 'show_menu', 'pick', 'confirm', 'cancel', 'open'].includes(payload.action)) {
        throw new Error('computer_click_action_unsupported');
    }
    if (payload.scope === 'desktop' ||
        typeof payload.element_token !== 'string' ||
        !payload.element_token.trim() ||
        (payload.button ?? 'left') !== 'left' ||
        (payload.click_count ?? 1) !== 1) {
        throw new Error('computer_click_action_requires_single_element_click');
    }
}
export async function mapRequestToCuaTool(runtime, request, signal) {
    // The SDK keeps an implicit transport session when callers omit `session`.
    // Give every session-aware action a stable name so a long-running chat does
    // not lose its driver session after an implicit-session expiry/reconnect.
    const payload = { ...request.payload, session: request.sessionId };
    if (request.kind === 'app_state') {
        for (const field of ['max_depth', 'max_elements']) {
            if (payload[field] === null)
                delete payload[field];
        }
    }
    if (['click', 'type', 'key', 'select_text', 'scroll'].includes(request.kind)) {
        for (const field of ['pid', 'window_ref', 'element_token', 'x', 'y']) {
            if (payload[field] === null)
                delete payload[field];
        }
    }
    if (['click', 'type', 'key', 'select_text', 'scroll'].includes(request.kind) &&
        typeof payload.element_token === 'string' &&
        payload.element_token.trim().length > 0 &&
        (payload.x !== undefined || payload.y !== undefined)) {
        throw new Error('computer_conflicting_input_target: no input was sent. Input contains both element_token and x/y. To use the observed control coordinates, omit element_token or set it to null and keep x/y and window_ref. To use the element route, omit x/y or set both to null. Do not repeat this mixed target.');
    }
    if (payload.scope === 'desktop' && !['click', 'key', 'type'].includes(request.kind)) {
        throw new Error('computer_unsupported_desktop_action');
    }
    if (payload.scope === 'desktop' &&
        ['key', 'type'].includes(request.kind) &&
        (payload.x !== undefined || payload.y !== undefined)) {
        throw new Error('computer_desktop_input_coordinates_unsupported: no input was sent. Desktop key/type act on the current foreground focus; x/y do not target a control. Inspect computer_desktop_state, click the intended visible control separately if necessary, verify focus/selection, then send key/type with x/y omitted or null. Do not assume a click preserves an existing text selection.');
    }
    if (process.platform === 'darwin' &&
        runtime.driverVersion === '0.22.1' &&
        ['key', 'select_text'].includes(request.kind) &&
        payload.scope !== 'desktop' &&
        payload.delivery_mode !== 'foreground') {
        // Coordinates opt into focus only on the explicit foreground rung. Strict
        // model providers may otherwise fill these optional numeric fields with 0.
        // Preserve ordinary background keyboard delivery without a pixel click.
        delete payload.x;
        delete payload.y;
    }
    switch (request.kind) {
        case 'display_list':
            throw new Error('computer_display_observation_is_host_owned');
        case 'app_list':
            return {
                name: 'list_apps',
                // Filtering belongs to this facade; native list_apps accepts no filter.
                payload: pick(payload, ['session']),
            };
        case 'window_list':
            return {
                name: 'list_windows',
                payload: { pid: requirePositivePid(payload.pid), session: payload.session },
            };
        case 'window_set_frame': {
            if (typeof payload.window_ref !== 'string')
                throw new Error('computer_window_ref_required');
            for (const key of ['x', 'y', 'width', 'height']) {
                const value = payload[key];
                if ((key === 'width' || key === 'height') && value === undefined)
                    continue;
                if (typeof value !== 'number' ||
                    !Number.isFinite(value) ||
                    ((key === 'width' || key === 'height') && value < 1)) {
                    throw new Error('computer_invalid_window_frame');
                }
            }
            const target = await withWindowTarget(runtime, payload, signal, false);
            const size = await resolveWindowFrameSize(runtime, target, payload, signal);
            return {
                name: 'set_window_frame',
                payload: {
                    ...pick(target, ['pid', 'window_id', 'session']),
                    ...pick(payload, ['x', 'y']),
                    ...size,
                },
            };
        }
        case 'desktop_state':
            return {
                name: 'get_desktop_state',
                payload: pick(payload, ['session', 'screenshot_out_file']),
            };
        case 'app_launch':
            return {
                name: 'launch_app',
                // session is a registry-level argument, independent of the tool schema.
                payload: await resolveLaunchIdentity(runtime, payload, signal),
            };
        case 'app_activate': {
            const target = payload.window_ref
                ? await resolveWindowTarget(runtime, payload, signal)
                : undefined;
            return {
                name: 'bring_to_front',
                payload: target
                    ? { pid: target.pid, window_id: target.windowId, session: payload.session }
                    : { pid: requirePositivePid(payload.pid), session: payload.session },
            };
        }
        case 'app_state': {
            const target = await resolveWindowTarget(runtime, payload, signal);
            return {
                name: 'get_window_state',
                payload: {
                    ...pick(payload, [
                        'session',
                        'include_screenshot',
                        'max_depth',
                        'max_elements',
                        'screenshot_out_file',
                    ]),
                    // Providers often emit the optional query as "". Native CUA marks any
                    // present string as filtered, which bypasses default menu compaction.
                    ...(payload.query === '' ? {} : pick(payload, ['query'])),
                    include_screenshot: payload.include_screenshot ?? false,
                    pid: target.pid,
                    window_id: target.windowId,
                },
            };
        }
        case 'click': {
            validateClickAction(payload);
            const clickPayload = { ...payload };
            if (clickPayload.action === 'auto')
                delete clickPayload.action;
            if (clickPayload.click_count === 2 &&
                clickPayload.scope !== 'desktop' &&
                (clickPayload.button ?? 'left') === 'left' &&
                typeof clickPayload.element_token === 'string' &&
                clickPayload.element_token.trim()) {
                // Native click(count:2) still selects AX rows. double_click has the
                // distinct AXOpen path needed to open Finder files and applications.
                const mapped = await withWindowTarget(runtime, clickPayload, signal, false);
                return {
                    name: 'double_click',
                    payload: pick(mapped, ['pid', 'window_id', 'element_token', 'session', 'delivery_mode']),
                };
            }
            return {
                name: 'click',
                payload: await withWindowTarget(runtime, clickPayload.click_count !== undefined
                    ? { ...clickPayload, count: clickPayload.click_count }
                    : clickPayload, signal),
            };
        }
        case 'drag':
            return { name: 'drag', payload: await withWindowTarget(runtime, payload, signal) };
        case 'type':
            return { name: 'type_text', payload: await withWindowTarget(runtime, payload, signal) };
        case 'set_value': {
            if (payload.delivery_mode === 'foreground') {
                throw new Error('computer_set_value_foreground_unsupported: native set_value has no foreground mode; inspect the field and use computer_type for input delivery');
            }
            const target = await withWindowTarget(runtime, payload, signal, false);
            return {
                name: 'set_value',
                payload: pick(target, [
                    'pid',
                    'window_id',
                    'session',
                    'element_token',
                    'element_index',
                    'snapshot_id',
                    'value',
                ]),
            };
        }
        case 'select_text':
            return {
                name: 'hotkey',
                payload: await withWindowTarget(runtime, { ...payload, keys: [platformPrimaryModifier(), 'a'] }, signal),
            };
        case 'key': {
            if (typeof payload.key === 'string') {
                const arrows = {
                    arrowup: 'up',
                    arrowdown: 'down',
                    arrowleft: 'left',
                    arrowright: 'right',
                };
                payload.key = arrows[payload.key.toLowerCase()] ?? payload.key;
            }
            const mapped = await withWindowTarget(runtime, payload, signal);
            // The coordinate hotkey route focuses the observed control and uses
            // flagged HID events. The coordinate-free press_key route uses bare
            // modifier transitions, which can lose the chord on macOS 14.
            if (process.platform === 'darwin' &&
                runtime.driverVersion === '0.22.1' &&
                mapped.delivery_mode === 'foreground' &&
                typeof mapped.x === 'number' &&
                typeof mapped.y === 'number' &&
                Array.isArray(mapped.modifiers) &&
                mapped.modifiers.length > 0) {
                const { key, modifiers, ...target } = mapped;
                return { name: 'hotkey', payload: { ...target, keys: [...modifiers, key] } };
            }
            return { name: 'press_key', payload: mapped };
        }
        case 'scroll':
            // The native count is wheel notches/key repetitions, never screenshot pixels.
            if (payload.amount !== undefined &&
                (!Number.isInteger(payload.amount) ||
                    Number(payload.amount) < 1 ||
                    Number(payload.amount) > 50))
                throw new Error('computer_scroll_amount_invalid: amount must be 1-50 wheel notches or key repetitions, not pixels; start with 1-3 and inspect');
            return { name: 'scroll', payload: await withWindowTarget(runtime, payload, signal) };
        case 'secondary_action': {
            const action = typeof payload.action === 'string' ? payload.action : '';
            // CUA exposes one accessibility action in this release: invoke_menu.
            // Do not emulate press/open/pick/confirm/cancel with a coordinate click;
            // that would silently change semantics and violate the fail-closed
            // contract of the product facade.
            if (action !== 'show_menu')
                throw new Error('computer_secondary_action_unsupported');
            const path = payload.path ?? payload.menu_path;
            if (!Array.isArray(path) || path.some((item) => typeof item !== 'string')) {
                throw new Error('computer_menu_path_required');
            }
            const target = await resolveWindowTarget(runtime, payload, signal);
            return {
                name: 'invoke_menu',
                payload: {
                    pid: target.pid,
                    window_id: target.windowId,
                    path,
                    session: payload.session,
                },
            };
        }
        case 'verify_state': {
            if (!Array.isArray(payload.expect) ||
                payload.expect.length < 1 ||
                payload.expect.length > 8 ||
                payload.expect.some((predicate) => {
                    if (!isRecord(predicate))
                        return true;
                    const keys = Object.keys(predicate);
                    return (keys.length !== 1 ||
                        !['window', 'element'].includes(keys[0]) ||
                        !isRecord(predicate[keys[0]]));
                }))
                throw new Error('computer_verify_predicate_invalid: each expect item must contain exactly one window or element object; split independent assertions into separate items');
            const target = await withWindowTarget(runtime, payload, signal, false);
            return {
                name: 'verify_state',
                payload: pick(target, [
                    'pid',
                    'window_id',
                    'session',
                    'expect',
                    'timeout_ms',
                    'stable_samples',
                    'include_screenshot',
                ]),
            };
        }
        default:
            return assertNever(request.kind);
    }
}
/** Move-only requests preserve the live window size, not model-invented defaults. */
async function resolveWindowFrameSize(runtime, target, payload, signal) {
    let bounds;
    if (payload.width === undefined || payload.height === undefined) {
        const result = parseStructuredResult(await runtime.callTool('list_windows', {
            pid: target.pid,
            session: payload.session,
        }, signal));
        const window = Array.isArray(result?.windows)
            ? result.windows.find((item) => isRecord(item) && item.window_id === target.window_id)
            : undefined;
        if (isRecord(window) && isRecord(window.bounds))
            bounds = window.bounds;
    }
    const width = payload.width ?? bounds?.width;
    const height = payload.height ?? bounds?.height;
    if (typeof width !== 'number' ||
        !Number.isFinite(width) ||
        width < 1 ||
        typeof height !== 'number' ||
        !Number.isFinite(height) ||
        height < 1) {
        throw new Error('computer_window_size_unavailable: inspect the exact window before moving it');
    }
    return { width, height };
}
function requirePositivePid(value) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new Error('computer_window_list_pid_required');
    }
    return value;
}
function withWindowTarget(runtime, payload, signal, canonicalTarget = true) {
    if (payload.scope === 'desktop') {
        if (payload.pid ||
            payload.window_ref ||
            payload.element_token ||
            payload.element_index !== undefined) {
            throw new Error('computer_ambiguous_desktop_target: desktop scope cannot include window or element selectors');
        }
        const mapped = {
            ...pick(payload, ['session', 'key', 'modifiers', 'text', 'x', 'y', 'button', 'count']),
            target: { kind: 'desktop', display_id: 'primary' },
        };
        normalizeModifierFields(mapped);
        return Promise.resolve(mapped);
    }
    return resolveWindowTarget(runtime, payload, signal).then((target) => {
        const mapped = {
            ...pick(payload, [
                'session',
                'x',
                'y',
                'element_index',
                'element_token',
                'snapshot_id',
                'scope',
                'delivery_mode',
                'button',
                'count',
                'from_zoom',
                'modifier',
                'from_x',
                'from_y',
                'to_x',
                'to_y',
                'duration_ms',
                'steps',
                'text',
                'value',
                'key',
                'keys',
                'modifiers',
                'direction',
                'amount',
                'by',
                'action',
                'expect',
                'timeout_ms',
                'stable_samples',
                'include_screenshot',
            ]),
            pid: target.pid,
            window_id: target.windowId,
        };
        if (typeof mapped.element_token === 'string' && !mapped.element_token.trim()) {
            delete mapped.element_token;
        }
        // Input actions reject mixed targets before reaching this boundary. Other
        // element-only native operations must not forward unrelated coordinates.
        if (mapped.element_token !== undefined) {
            delete mapped.x;
            delete mapped.y;
        }
        if (requestNeedsCoordinates(mapped) &&
            (typeof mapped.x !== 'number' || typeof mapped.y !== 'number')) {
            throw new Error('computer_invalid_coordinates: coordinate targeting requires both x and y');
        }
        normalizeModifierFields(mapped);
        mapped.delivery_mode ??= 'background';
        if (canonicalTarget) {
            // CUA rejects canonical targets combined with legacy top-level selectors.
            delete mapped.pid;
            delete mapped.window_id;
            delete mapped.scope;
            mapped.target = { kind: 'window', pid: target.pid, window_id: target.windowId };
        }
        return mapped;
    });
}
function requestNeedsCoordinates(payload) {
    return payload.x !== undefined || payload.y !== undefined;
}
/** Align common model spellings with the CUA driver's canonical modifier names. */
function normalizeModifierFields(payload) {
    if (Array.isArray(payload.modifiers))
        payload.modifiers = payload.modifiers.map((value) => normalizeModifier(value));
    if (Array.isArray(payload.modifier))
        payload.modifier = payload.modifier.map((value) => normalizeModifier(value));
    if (Array.isArray(payload.keys))
        payload.keys = payload.keys.map((value) => normalizeModifier(value));
}
function normalizeModifier(value) {
    if (typeof value !== 'string')
        return value;
    const normalized = value.trim().toLowerCase();
    if (['meta', 'command', 'commandleft', 'cmd'].includes(normalized))
        return process.platform === 'darwin' ? 'cmd' : 'win';
    if (['control', 'controlleft', 'ctrl'].includes(normalized))
        return 'ctrl';
    if (['alt', 'altleft', 'altright', 'option', 'optionleft'].includes(normalized))
        return process.platform === 'darwin' ? 'option' : 'alt';
    if (['shift', 'shiftleft'].includes(normalized))
        return 'shift';
    if (['function', 'fn'].includes(normalized))
        return 'fn';
    return value;
}
function platformPrimaryModifier() {
    return process.platform === 'darwin' ? 'cmd' : 'ctrl';
}
async function resolveWindowTarget(runtime, payload, signal) {
    const direct = resolveWindowTargetSync(payload, false);
    if (direct) {
        // Window refs are live capabilities, not durable IDs. Revalidate the
        // caller-provided ref against the driver's current PID-owned inventory so
        // a stale ref cannot be presented as a successful snapshot/action target.
        const listed = await runtime.callTool('list_windows', { pid: direct.pid, session: payload.session }, signal);
        const parsed = parseWindows(listed);
        if (!parsed.includes(direct.windowId))
            throw new Error('computer_window_not_found');
        return direct;
    }
    const pid = payload.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        throw new Error('computer_window_ref_required');
    }
    const listed = await runtime.callTool('list_windows', { pid, session: payload.session }, signal);
    const windows = listed?.structuredJson;
    const parsed = parseWindows(listed, windows);
    if (parsed.length !== 1)
        throw new Error(parsed.length === 0 ? 'computer_window_not_found' : 'computer_ambiguous_window_target');
    return { pid, windowId: parsed[0], windowRef: `w:${pid}:${parsed[0]}` };
}
function resolveWindowTargetSync(payload, required = true) {
    const ref = payload.window_ref ?? payload.windowRef;
    if (typeof ref === 'string') {
        const match = /^w:([1-9][0-9]*):([1-9][0-9]*)$/.exec(ref);
        if (!match)
            throw new Error('computer_invalid_window_ref');
        const pid = Number(match[1]);
        const windowId = Number(match[2]);
        if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(windowId))
            throw new Error('computer_invalid_window_ref');
        // Optional zero PID is a provider placeholder, not a competing target.
        if (payload.pid !== undefined && payload.pid !== 0 && payload.pid !== pid)
            throw new Error('computer_window_target_mismatch: pid does not match window_ref');
        return { pid, windowId, windowRef: ref };
    }
    const pid = payload.pid;
    const windowId = payload.window_id ?? payload.windowId;
    if (typeof pid === 'number' &&
        Number.isInteger(pid) &&
        pid > 0 &&
        typeof windowId === 'number' &&
        Number.isInteger(windowId) &&
        windowId > 0) {
        return { pid, windowId, windowRef: `w:${pid}:${windowId}` };
    }
    if (required)
        throw new Error('computer_window_ref_required');
    return undefined;
}
function parseWindows(value, structuredJson) {
    const candidates = [value];
    if (value && typeof value === 'object') {
        const record = value;
        const embedded = record.structuredJson ?? record.rawJson;
        if (typeof embedded === 'string')
            candidates.push(parseJson(embedded));
        else if (embedded !== undefined)
            candidates.push(embedded);
    }
    if (structuredJson) {
        try {
            candidates.push(JSON.parse(structuredJson));
        }
        catch {
            /* ignore */
        }
    }
    for (const candidate of candidates) {
        const windows = candidate &&
            typeof candidate === 'object' &&
            Array.isArray(candidate.windows)
            ? candidate.windows
            : [];
        const ids = windows.flatMap((entry) => {
            const id = entry && typeof entry === 'object'
                ? entry.window_id
                : undefined;
            return typeof id === 'number' && Number.isInteger(id) && id > 0 ? [id] : [];
        });
        if (ids.length)
            return ids;
    }
    return [];
}
function pick(payload, keys) {
    return Object.fromEntries(keys.flatMap((key) => (payload[key] === undefined ? [] : [[key, payload[key]]])));
}
function assertNever(value) {
    throw new Error(`computer_unsupported_request:${String(value)}`);
}
//# sourceMappingURL=mapping.js.map