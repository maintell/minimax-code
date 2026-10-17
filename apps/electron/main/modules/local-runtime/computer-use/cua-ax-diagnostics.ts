// The runtime owns the table; terminating the utility releases it. Reserve before
// awaiting probes so concurrent failures for the same target cannot duplicate work.
const diagnosticTimes = new WeakMap();
function admitDiagnostic(input, code) {
    if (input.signal.aborted)
        return false;
    let times = diagnosticTimes.get(input.runtime);
    if (!times) {
        times = new Map();
        diagnosticTimes.set(input.runtime, times);
    }
    const target = record(input.payload.target) ?? input.payload;
    const key = JSON.stringify([target.pid, target.window_id, code]);
    const now = Date.now();
    const previous = times.get(key);
    if (previous !== undefined && now - previous < 30000)
        return false;
    times.delete(key);
    times.set(key, now);
    const oldest = times.keys().next().value;
    if (times.size > 64 && oldest !== undefined)
        times.delete(oldest);
    return true;
}
export async function logAxWindowDiagnostics(input) {
    const result = structured(input.result);
    const reason = result?.degraded_reason;
    if (typeof reason !== 'string' || !reason.startsWith('ax_window_unresolved'))
        return;
    if (!admitDiagnostic(input, 'ax_window_unresolved'))
        return;
    const context = {
        requestId: input.request.requestId,
        sessionId: input.request.sessionId,
        turnId: input.request.turnId,
        generation: input.request.generation,
        pid: input.payload.pid,
        windowId: input.payload.window_id,
        observerPid: process.pid,
        observerUptimeMs: Math.round(process.uptime() * 1000),
        observerExecutable: process.execPath,
        platform: process.platform,
        arch: process.arch,
    };
    input.logger.warn('ax_diagnostics', {
        ...context,
        stage: 'observation',
        axWindowCount: reason.match(/none of the (\d+) AXWindow/u)?.[1] ?? null,
        elementCount: result?.element_count,
        screenshotFrameValid: result?.screenshot_frame_valid,
        onCurrentSpace: result?.on_current_space,
    });
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(2500)]);
    const probes = [
        {
            tool: 'health_report',
            args: {
                include: [
                    'binary_version',
                    'platform_supported',
                    'bundle_identity',
                    'tcc_accessibility',
                    'tcc_screen_recording',
                    'ax_capability',
                ],
            },
        },
        { tool: 'list_windows', args: { pid: input.payload.pid } },
    ];
    for (const probe of probes) {
        if (signal.aborted)
            break;
        try {
            const value = structured(await input.runtime.callTool(probe.tool, { ...probe.args, session: input.request.sessionId }, signal));
            input.logger.warn('ax_diagnostics', {
                ...context,
                stage: probe.tool,
                ...(probe.tool === 'health_report'
                    ? summarizeHealth(value)
                    : summarizeWindows(value, input.payload.window_id)),
            });
        }
        catch (error) {
            // Diagnostic failure must not turn the original observation into a tool error.
            input.logger.warn('ax_diagnostics', {
                ...context,
                stage: probe.tool,
                outcome: signal.aborted ? 'aborted' : 'failed',
                errorCode: error instanceof Error ? error.name : 'unknown',
            });
        }
    }
}
/** Inventory is diagnostic evidence, not a replacement for the native AX eligibility gate. */
export async function logBackgroundKeyboardDiagnostics(input) {
    if (structured(input.result)?.code !== 'same_pid_keyboard_ambiguity' || input.signal.aborted)
        return;
    const target = record(input.payload.target) ?? input.payload;
    if (typeof target.pid !== 'number' || !Number.isInteger(target.pid) || target.pid <= 0)
        return;
    if (!admitDiagnostic(input, 'same_pid_keyboard_ambiguity'))
        return;
    const context = {
        requestId: input.request.requestId,
        sessionId: input.request.sessionId,
        turnId: input.request.turnId,
        generation: input.request.generation,
        pid: target.pid,
        windowId: target.window_id,
        stage: 'keyboard_ambiguity',
    };
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(2500)]);
    try {
        const value = structured(await input.runtime.callTool('list_windows', {
            pid: target.pid,
            session: input.request.sessionId,
        }, signal));
        const rows = Array.isArray(value?.windows) ? value.windows : undefined;
        input.logger.warn('ax_diagnostics', {
            ...context,
            outcome: rows ? 'observed' : 'unavailable',
            windowCount: rows?.length,
            // Raw CG rows can include compositor surfaces. Do not label them eligible siblings.
            inventoryWindows: rows?.slice(0, 32).map((item) => {
                const window = record(item);
                return {
                    ...pick(window, ['window_id', 'pid', 'is_on_screen', 'on_current_space', 'layer']),
                    bounds: numericBounds(record(window?.bounds)),
                };
            }),
        });
    }
    catch {
        input.logger.warn('ax_diagnostics', {
            ...context,
            outcome: signal.aborted ? 'aborted' : 'failed',
        });
    }
}
function summarizeHealth(value) {
    return {
        schemaVersion: value?.schema_version,
        driverVersion: value?.driver_version,
        overall: value?.overall,
        checks: Array.isArray(value?.checks)
            ? value.checks.slice(0, 12).map((check) => {
                const row = record(check);
                // SDK-owned fixed diagnostics only; omit free-form messages, paths and AX content.
                return { name: row?.name, status: row?.status, data: safeHealthData(record(row?.data)) };
            })
            : [],
    };
}
function safeHealthData(value) {
    return pick(value, [
        'accessibility',
        'screen_recording',
        'trusted',
        'ax_trusted',
        'bundle_id',
        'bundle_identifier',
        'executable_path',
        'pid',
        'responsible_pid',
        'error_code',
        'ax_error',
    ]);
}
function summarizeWindows(value, windowId) {
    if (!Array.isArray(value?.windows))
        return { outcome: 'unavailable', targetFound: null };
    const windows = value.windows;
    const target = windows.map(record).find((window) => window?.window_id === windowId);
    return {
        windowCount: windows.length,
        inventoryCurrentSpaceId: finiteNumber(value.current_space_id),
        targetFound: target !== undefined,
        target: {
            ...pick(target, [
                'window_id',
                'pid',
                'is_on_screen',
                'on_current_space',
                'current_space_id',
                'z_index',
                'layer',
            ]),
            bounds: numericBounds(record(target?.bounds)),
            spaceIds: Array.isArray(target?.space_ids)
                ? target.space_ids
                    .filter((id) => typeof id === 'number' && Number.isFinite(id))
                    .slice(0, 16)
                : null,
        },
    };
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function numericBounds(value) {
    if (!value)
        return null;
    return Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, finiteNumber(value[key])]));
}
function pick(value, keys) {
    return Object.fromEntries(keys.flatMap((key) => {
        const item = value?.[key];
        return item === null || ['string', 'number', 'boolean'].includes(typeof item)
            ? [[key, typeof item === 'string' ? item.slice(0, 256) : item]]
            : [];
    }));
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function structured(value) {
    const outer = record(value);
    const raw = outer?.structuredJson ?? outer?.rawJson;
    if (typeof raw !== 'string')
        return record(raw);
    try {
        return record(JSON.parse(raw));
    }
    catch {
        return undefined;
    }
}
