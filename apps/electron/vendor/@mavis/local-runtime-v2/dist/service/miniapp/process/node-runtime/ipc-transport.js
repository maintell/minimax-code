const IPC_SEND_TIMEOUT_MS = 30_000;
/** JSON semantics and application-level limits; Node has already parsed incoming IPC messages. */
export function encodeMiniAppIpcMessage(type, payload, maxBytes) {
    const json = boundedJson(payload, maxBytes);
    return { type, payload: JSON.parse(json) };
}
export function bindMiniAppIpcChannel(transport, options) {
    const onMessage = (value) => {
        if (!isRecord(value) || value.type !== options.type)
            return;
        try {
            if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'payload')) {
                throw new Error('Mini App IPC message envelope is invalid');
            }
            boundedJson(value.payload, options.maxBytes);
            options.onMessage(value.payload);
        }
        catch (error) {
            options.onFatal(error instanceof Error ? error : new Error('Mini App IPC message failed'));
        }
    };
    const onDisconnect = () => options.onFatal(new Error('Mini App IPC channel disconnected'));
    const onError = () => options.onFatal(new Error('Mini App IPC channel failed'));
    const detach = () => {
        transport.removeListener('message', onMessage);
        transport.removeListener('disconnect', onDisconnect);
        transport.removeListener('error', onError);
    };
    try {
        transport.on('message', onMessage);
        transport.on('disconnect', onDisconnect);
        transport.on('error', onError);
    }
    catch {
        detach();
        throw new Error('Mini App IPC channel registration failed');
    }
    return detach;
}
/** Bound the IPC callback wait, including backpressure; this does not confirm execution. */
export function sendMiniAppIpcMessage(transport, message, onSend) {
    if (transport.connected === false)
        return Promise.reject(new Error('Mini App IPC is closed'));
    return new Promise((resolve, reject) => {
        let settled = false;
        const complete = (error = null) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(deadline);
            transport.removeListener('disconnect', onDisconnect);
            transport.removeListener('error', onError);
            if (error)
                reject(error);
            else
                resolve();
        };
        const onDisconnect = () => complete(new Error('Mini App IPC disconnected during send'));
        const onError = () => complete(new Error('Mini App IPC send failed'));
        const deadline = setTimeout(() => complete(new Error('Mini App IPC send timed out')), IPC_SEND_TIMEOUT_MS);
        deadline.unref?.();
        try {
            transport.on('disconnect', onDisconnect);
            transport.on('error', onError);
            transport.send(message, complete);
            // Returning from send only proves a transport handoff; callers retain unknown-outcome rules.
            onSend?.();
        }
        catch {
            complete(new Error('Mini App IPC send failed'));
        }
    });
}
function boundedJson(value, maxBytes) {
    let json;
    try {
        json = JSON.stringify(value);
    }
    catch {
        throw new Error('Mini App IPC payload is not valid JSON');
    }
    if (json === undefined)
        throw new Error('Mini App IPC payload is not valid JSON');
    if (Buffer.byteLength(json) > maxBytes)
        throw new Error('Mini App IPC message exceeds its byte limit');
    return json;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=ipc-transport.js.map