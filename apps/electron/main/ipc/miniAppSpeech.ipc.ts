import { ipcMain } from "electron";
import { isMiniAppAgentRequestId, isMiniAppSpeechAudioFormat, readMiniAppSpeechAudio } from "@mavis/shared/miniapp-surface";
import { IPC_CHANNELS } from "../config/constants.js";
import { getEmbeddedBrowserManager } from "../modules/browser/embedded-browser-manager.js";
import { createUtilityMiniAppPermissionSwitches } from "../modules/browser/miniapp-permission-switches.js";
import { MiniAppSpeechTranscriber, MiniAppSpeechFailure } from "../modules/browser/miniapp-speech.js";
import { createLocalAsrNativeSession } from "../modules/local-runtime";
import { getCategoryLogger } from "../utils/logger";
import { captureTabCaller } from "./miniAppAgentIpcSupport.js";
const logger = getCategoryLogger('main', 'miniapp-speech');
/**
 * Re-parses the preload's payload: the preload-generated request id, PCM bytes and the fixed
 * format. Returns the failure the page should see when the payload is not that.
 */
function readTranscribeRequest(value) {
    if (!value || typeof value !== 'object')
        return { ok: false, code: 'invalid_request' };
    const { requestId, audio, format } = value;
    if (!isMiniAppAgentRequestId(requestId) || !isMiniAppSpeechAudioFormat(format)) {
        return { ok: false, code: 'invalid_request' };
    }
    const read = readMiniAppSpeechAudio(audio);
    return read.ok ? { ok: true, request: { requestId, audio: read.audio } } : read;
}
/**
 * `window.mcode.miniapp.speech.transcribe`. The calling Mini App is resolved from the IPC sender
 * only; its `device:microphone` switch is read when the transcription starts; partial text goes
 * back on `MINIAPP_SPEECH_PARTIAL` under the page's request id; the page ending drops the run.
 */
export function setupMiniAppSpeechIPC(overrides = {}) {
    const manager = getEmbeddedBrowserManager();
    const transcriber = new MiniAppSpeechTranscriber({
        createSession: (transport) => createLocalAsrNativeSession(transport),
        switches: createUtilityMiniAppPermissionSwitches(),
        ...overrides,
    });
    ipcMain.handle(IPC_CHANNELS.MINIAPP_SPEECH_TRANSCRIBE, async (event, value) => {
        const caller = captureTabCaller(manager, event);
        if (!caller)
            return { ok: false, code: 'not_permitted' };
        const parsed = readTranscribeRequest(value);
        if (!parsed.ok)
            return parsed;
        const { requestId, audio } = parsed.request;
        const page = event.sender;
        const controller = new AbortController();
        const stopWatching = manager.observeMiniAppPageEnd(page, () => controller.abort());
        const startedAt = Date.now();
        const audit = (outcome) => logger.info('miniapp_speech_transcribe', {
            pluginId: caller.pluginId,
            runId: caller.runId,
            audioBytes: audio.byteLength,
            durationMs: Date.now() - startedAt,
            outcome,
        });
        try {
            const result = await transcriber.transcribe({
                pluginId: caller.pluginId,
                audio,
                signal: controller.signal,
                onPartial: (text) => {
                    if (page.isDestroyed())
                        return;
                    try {
                        page.send(IPC_CHANNELS.MINIAPP_SPEECH_PARTIAL, {
                            requestId,
                            text,
                        });
                    }
                    catch {
                        // The page can disappear between the check and delivery.
                    }
                },
            });
            audit('ok');
            return { ok: true, result };
        }
        catch (error) {
            const code = error instanceof MiniAppSpeechFailure ? error.code : 'result_unknown';
            audit(code);
            if (code === 'result_unknown') {
                logger.warn('miniapp_speech_unexpected_failure', {
                    pluginId: caller.pluginId,
                    errorName: error instanceof Error ? error.name : typeof error,
                    message: error instanceof Error ? error.message : undefined,
                });
            }
            return { ok: false, code };
        }
        finally {
            stopWatching();
        }
    });
    return () => {
        ipcMain.removeHandler(IPC_CHANNELS.MINIAPP_SPEECH_TRANSCRIBE);
    };
}
