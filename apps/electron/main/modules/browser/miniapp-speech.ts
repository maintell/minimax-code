import { miniAppPermissionId } from "@mavis/shared/miniapp-surface";
export class MiniAppSpeechFailure extends Error {
    constructor(code, detail) {
        super(detail ? `${code}: ${detail}` : code);
        this.code = code;
        this.name = 'MiniAppSpeechFailure';
    }
}

const MICROPHONE = miniAppPermissionId('device', 'microphone');
const DEFAULT_DEADLINE_MS = 180000;
/**
 * Session error codes with a page-visible meaning; anything else, including the session's own
 * protocol errors, is a failed transcription. `FEATURE_DISABLED` is raised at open and
 * `AUTH_REQUIRED` at stop, both before any upload.
 */
const FAILURE_BY_SESSION_CODE = {
    FEATURE_DISABLED: 'runtime_unavailable',
    AUTH_REQUIRED: 'runtime_unavailable',
    AUDIO_TOO_LONG: 'audio_too_large',
};
/**
 * One `speech.transcribe` at a time per Mini App, each judged by the `device:microphone` switch
 * when it starts. The audio is handed to the Host's own ASR session as one utterance: open,
 * audio, stop, then the result frames until the session closes.
 */
export class MiniAppSpeechTranscriber {
    constructor(options) {
        this.options = options;
        this.inFlight = new Set();
    }
    async transcribe(input) {
        if (this.inFlight.has(input.pluginId))
            throw new MiniAppSpeechFailure('busy');
        this.inFlight.add(input.pluginId);
        try {
            if (!(await this.options.switches.isEnabled(input.pluginId, MICROPHONE))) {
                throw new MiniAppSpeechFailure('not_permitted');
            }
            if (input.signal.aborted)
                throw new MiniAppSpeechFailure('transcription_failed', 'aborted');
            return await this.runSession(input);
        }
        finally {
            this.inFlight.delete(input.pluginId);
        }
    }
    runSession(input) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let lastText = '';
            let finalText;
            let session = null;
            const settle = (outcome) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(deadline);
                input.signal.removeEventListener('abort', onAbort);
                if (outcome instanceof MiniAppSpeechFailure) {
                    session?.close();
                    reject(outcome);
                }
                else
                    resolve(outcome);
            };
            const onAbort = () => settle(new MiniAppSpeechFailure('transcription_failed', 'aborted'));
            const deadline = setTimeout(() => settle(new MiniAppSpeechFailure('transcription_failed', 'deadline exceeded')), this.options.deadlineMs ?? DEFAULT_DEADLINE_MS);
            input.signal.addEventListener('abort', onAbort, { once: true });
            const transport = {
                isOpen: () => !settled,
                sendFrame: (frame) => {
                    if (settled)
                        return;
                    switch (frame.type) {
                        case 'connected':
                            session?.receiveAudio(Buffer.from(input.audio.buffer, input.audio.byteOffset, input.audio.byteLength));
                            session?.receiveFrame({ type: 'stop' });
                            return;
                        case 'result': {
                            if (typeof frame.text !== 'string')
                                return;
                            lastText = frame.text;
                            if (frame.kind === 'final')
                                finalText = frame.text;
                            else
                                input.onPartial?.(frame.text);
                            return;
                        }
                        case 'close':
                            settle({ text: finalText ?? lastText });
                            return;
                        case 'error': {
                            const code = typeof frame.code === 'string' ? frame.code : '';
                            const message = typeof frame.message === 'string' ? frame.message : code;
                            settle(new MiniAppSpeechFailure(FAILURE_BY_SESSION_CODE[code] ?? 'transcription_failed', message));
                            return;
                        }
                        default:
                            return;
                    }
                },
                // The session closes after its `close` or `error` frame; closing without either is a failure.
                close: (reason) => settle(new MiniAppSpeechFailure('transcription_failed', reason)),
            };
            try {
                session = this.options.createSession(transport);
                session.receiveFrame({ type: 'open', mode: 'amadeus' });
            }
            catch (error) {
                settle(new MiniAppSpeechFailure('runtime_unavailable', error instanceof Error ? error.message : String(error)));
            }
        });
    }
}

