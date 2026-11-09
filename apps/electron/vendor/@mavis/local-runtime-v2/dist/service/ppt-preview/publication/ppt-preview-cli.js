import { connect } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';
import { decodePptPreviewRequest, PptPreviewError } from '@mavis/shared/ppt-preview';
export async function runPptPreviewCli(connectionFile, input) {
    const request = decodePptPreviewRequest(input);
    const connection = JSON.parse(await readFile(connectionFile, 'utf8'));
    if (connection.schema !== 'minimax.ppt-preview.connection.v1' ||
        connection.host !== '127.0.0.1' ||
        !Number.isSafeInteger(connection.port) ||
        connection.port < 1 ||
        connection.port > 65535 ||
        !/^[a-f0-9]{64}$/u.test(connection.token))
        throw new PptPreviewError('INVALID_REQUEST', 'Invalid current-task PPT connection');
    return new Promise((resolveResponse, reject) => {
        const socket = connect({ host: connection.host, port: connection.port });
        let text = '';
        let receivedBytes = 0;
        const decoder = new StringDecoder('utf8');
        let settled = false;
        const fail = (error) => {
            if (!settled) {
                settled = true;
                socket.destroy();
                reject(error);
            }
        };
        socket.setTimeout(35_000, () => fail(new Error('PPT request timed out; query the same requestId before retrying')));
        socket.on('error', fail);
        socket.on('connect', () => socket.write(`${JSON.stringify({ token: connection.token, request })}\n`));
        socket.on('data', (bytes) => {
            if (settled)
                return;
            receivedBytes += bytes.length;
            text += decoder.write(bytes);
            if (receivedBytes > 16 * 1024 * 1024) {
                fail(new Error('PPT response exceeds limits'));
                return;
            }
            if (!text.includes('\n'))
                return;
            try {
                const result = JSON.parse(text.slice(0, text.indexOf('\n')));
                settled = true;
                socket.destroy();
                if (result.ok)
                    resolveResponse(result.result);
                else
                    reject(new PptPreviewError(result.error?.code ?? 'REQUEST_FAILED', result.error?.message ?? 'PPT request failed'));
            }
            catch (error) {
                fail(error instanceof Error ? error : new Error('Invalid PPT response'));
            }
        });
        socket.on('end', () => {
            if (!settled)
                fail(new Error('PPT connection closed before a response'));
        });
    });
}
export async function readPptPreviewCliInput(raw, cwd = process.cwd()) {
    let text;
    let base = cwd;
    if (raw === '-') {
        const chunks = [];
        let size = 0;
        for await (const chunk of process.stdin) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > 256 * 1024)
                throw new PptPreviewError('LIMIT_EXCEEDED', 'PPT request exceeds limits');
            chunks.push(bytes);
        }
        text = Buffer.concat(chunks).toString('utf8');
    }
    else if (raw.startsWith('@')) {
        const file = resolve(cwd, raw.slice(1));
        base = dirname(file);
        text = await readFile(file, 'utf8');
    }
    else
        text = raw;
    if (Buffer.byteLength(text) > 256 * 1024)
        throw new PptPreviewError('LIMIT_EXCEEDED', 'PPT request exceeds limits');
    const value = decodePptPreviewRequest(JSON.parse(text));
    if (value.pptx && !isAbsolute(value.pptx))
        value.pptx = resolve(base, value.pptx);
    return value;
}
export async function pptPreviewCliMain(args) {
    const connectionIndex = args.indexOf('--connection');
    const requestIndex = args.includes('--request')
        ? args.indexOf('--request')
        : args.indexOf('--input');
    const connection = args[connectionIndex + 1];
    const raw = args[requestIndex + 1];
    if (connectionIndex < 0 || requestIndex < 0 || !connection || !raw || args.length !== 4)
        throw new Error('Usage: mcode ppt preview --connection <current-task.json> --request <JSON|@request.json|->');
    const value = await readPptPreviewCliInput(raw);
    process.stdout.write(`${JSON.stringify(await runPptPreviewCli(connection, value))}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const main = async () => {
        try {
            await pptPreviewCliMain(process.argv.slice(2));
        }
        catch (error) {
            process.stderr.write(`${JSON.stringify({
                ok: false,
                error: {
                    code: error instanceof PptPreviewError ? error.code : 'REQUEST_FAILED',
                    message: error instanceof Error ? error.message : String(error),
                },
            })}\n`);
            process.exitCode = 1;
        }
    };
    await main();
}
//# sourceMappingURL=ppt-preview-cli.js.map