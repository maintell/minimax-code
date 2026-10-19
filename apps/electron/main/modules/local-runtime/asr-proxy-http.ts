const SESSION_TOKEN_PATH = '/matrix/api/v1/asr/session_token';
const TRANSCRIBE_PATH = '/matrix/asr/audio/transcribe';
const SESSION_TOKEN_TIMEOUT_MS = 15000;
const TRANSCRIPTION_HEADERS_TIMEOUT_MS = 30000;
function abortReason(signal) {
    return signal.reason ?? new DOMException('ASR request aborted', 'AbortError');
}
async function runWithTimeout(input, task) {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(abortReason(input.signal));
    if (input.signal?.aborted)
        onParentAbort();
    else
        input.signal?.addEventListener('abort', onParentAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new DOMException(input.timeoutMessage, 'TimeoutError')), input.timeoutMs);
    try {
        return await task(controller.signal);
    }
    finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener('abort', onParentAbort);
    }
}
export function resolveAmadeusProxyBaseURL(override, managedBaseURL) {
    return (override?.trim() || managedBaseURL.trim()).replace(/\/+$/, '');
}
export async function issueAmadeusProxySessionToken(input) {
    return runWithTimeout({
        signal: input.signal,
        timeoutMs: input.timeoutMs ?? SESSION_TOKEN_TIMEOUT_MS,
        timeoutMessage: 'ASR token request timed out',
    }, async (signal) => {
        const response = await input.fetchImpl(`${input.baseURL.replace(/\/+$/, '')}${SESSION_TOKEN_PATH}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${input.userToken}`,
                'Content-Type': 'application/json',
                ...input.routingHeaders,
            },
            body: JSON.stringify({ provider: 'amadeus', region: input.region }),
            signal,
        });
        const bodyText = await response.text();
        if (!response.ok) {
            throw new Error(`ASR token service returned HTTP ${response.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
        }
        let body;
        try {
            body = JSON.parse(bodyText);
        }
        catch {
            throw new Error('ASR token service returned an invalid response.');
        }
        if (typeof body.token !== 'string' || !body.token.trim()) {
            throw new Error('ASR token service did not return a token.');
        }
        return {
            token: body.token.trim(),
            ...(typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
                ? { expiresIn: body.expires_in }
                : {}),
        };
    });
}
export async function postAmadeusProxyWav(input) {
    return runWithTimeout({
        signal: input.signal,
        timeoutMs: input.timeoutMs ?? TRANSCRIPTION_HEADERS_TIMEOUT_MS,
        timeoutMessage: 'ASR transcription timed out',
    }, (signal) => input.fetchImpl(`${input.baseURL.replace(/\/+$/, '')}${TRANSCRIBE_PATH}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${input.token}`,
            'Content-Type': 'audio/wav',
            Accept: 'text/event-stream',
            ...input.routingHeaders,
        },
        // Normalize Buffer<ArrayBufferLike> for Node 22's DOM BodyInit type;
        // bytes sent to the ASR proxy remain unchanged.
        body: new Uint8Array(input.wav),
        signal,
    }));
}
