import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { SSE_HEADERS, SseWriter } from './host-helpers.js';
export function sessionTurnFramesToRawSse(frames) {
    let iterator;
    let cancelled = false;
    const stream = new ReadableStream({
        start: (controller) => {
            const writer = new SseWriter(controller);
            iterator = frames[Symbol.asyncIterator]();
            void pump(iterator, writer, controller);
        },
        cancel: async () => {
            cancelled = true;
            await iterator?.return?.();
        },
    });
    return new Response(stream, { headers: SSE_HEADERS });
    async function pump(source, writer, controller) {
        try {
            while (!cancelled) {
                const next = await source.next();
                if (next.done)
                    break;
                writeFrame(writer, next.value);
            }
        }
        catch (error) {
            if (!cancelled)
                controller.error(error);
            return;
        }
        writer.close();
    }
}
function writeFrame(writer, frame) {
    if (frame.kind === 'heartbeat') {
        writer.writeJson({ type: RespDataType.Heartbeat });
    }
    else if (frame.kind === 'data') {
        writer.writeEvent(frame.data, frame.cursor ? { id: frame.cursor } : undefined);
    }
    else if (frame.kind === 'resume-overflow') {
        writer.writeJson({ type: 'resume_overflow' });
    }
    else {
        writer.write('[DONE]');
    }
}
//# sourceMappingURL=session-turn-sse.js.map