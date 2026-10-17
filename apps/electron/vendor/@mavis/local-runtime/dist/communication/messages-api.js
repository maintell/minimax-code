import { json } from '../api/host-helpers.js';
export async function routeLocalCommunicationMessagesApi(input) {
    const fromSession = input.url.searchParams.get('fromSession') ??
        input.url.searchParams.get('from_session') ??
        undefined;
    const toSession = input.url.searchParams.get('toSession') ??
        input.url.searchParams.get('to_session') ??
        undefined;
    const status = readCommunicationStatus(input.url.searchParams.get('status'));
    const limit = normalizeLimit(input.url.searchParams.get('limit'), 50);
    const records = await input.store.list({
        fromSession,
        toSession,
        ...(status ? { status } : {}),
        limit,
    });
    return json({
        messages: records.map((record) => ({
            id: record.messageId,
            messageId: record.messageId,
            fromSession: record.fromSession,
            toSession: record.toSession,
            command: record.command,
            status: record.status,
            content: record.content,
            ...(record.error ? { error: record.error } : {}),
            createdAt: record.createdAtMs,
            createdAtMs: record.createdAtMs,
        })),
        count: records.length,
    });
}
function readCommunicationStatus(value) {
    if (!value || value === 'all')
        return undefined;
    if (value === 'done' || value === 'delivered')
        return 'delivered';
    if (value === 'failed')
        return 'failed';
    return undefined;
}
function normalizeLimit(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.min(Math.floor(parsed), 500);
}
//# sourceMappingURL=messages-api.js.map