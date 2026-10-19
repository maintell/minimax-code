const guardedTransports = new WeakSet();
export function isBrokenConsolePipeError(error) {
    return (typeof error === 'object' &&
        error !== null &&
        error.code === 'EPIPE');
}
/**
 * Keep a detached development process alive when its terminal parent closes.
 *
 * electron-log's console transport writes through process stdout/stderr. A
 * vanished electronmon pipe may fail either synchronously from writeFn or as
 * an asynchronous stream `error`. Only EPIPE disables the console transport;
 * categorized file transports remain active and every other error keeps the
 * process' existing uncaught-exception semantics.
 */
export function installConsoleTransportEpipeGuard(transport, streams) {
    if (guardedTransports.has(transport))
        return;
    guardedTransports.add(transport);
    const originalWriteFn = transport.writeFn;
    transport.writeFn = ((...args) => {
        try {
            return originalWriteFn(...args);
        }
        catch (error) {
            if (!isBrokenConsolePipeError(error))
                throw error;
            transport.level = false;
            return undefined;
        }
    });
    const handleStreamError = (error) => {
        if (!isBrokenConsolePipeError(error))
            throw error;
        transport.level = false;
    };
    for (const stream of streams)
        stream.on('error', handleStreamError);
}
