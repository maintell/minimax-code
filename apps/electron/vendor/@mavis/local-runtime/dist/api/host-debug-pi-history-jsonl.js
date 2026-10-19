import { notFound } from './host-helpers.js';
import { logger } from '../common/logger.js';
export async function routeDebugPiHistoryJsonl(context, sessionId) {
    const session = await context.getSessionById(sessionId);
    if (!session)
        return notFound(`/debug/session/${sessionId}/pi-history.jsonl`);
    await context.ensureLegacyPiHistoryMigrated?.(sessionId);
    const history = await context.getPiHistory(sessionId);
    const header = {
        version: 3,
        kind: 'pi-agent-session-history',
        source: 'local-runtime-debug-export',
        sessionId,
        exportedAtMs: context.nowMs(),
        messageCount: history.length,
    };
    const lines = [
        JSON.stringify({ type: 'header', header }),
        ...history.map((message, index) => JSON.stringify({ type: 'message', index, sessionId, message })),
    ];
    const body = `${lines.join('\n')}\n`;
    logger.info({
        sessionId: sessionId.replace(/\s+/g, '_'),
        messages: history.length,
        bytes: Buffer.byteLength(body, 'utf-8'),
    }, 'Legacy opencode debug jsonl exported');
    return new Response(body, {
        headers: {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}
//# sourceMappingURL=host-debug-pi-history-jsonl.js.map