import { ipcMain, BrowserWindow } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { realpath, readFile } from "node:fs/promises";
import path from "node:path";
import { documentPreviewSourceRegistry } from "../runtime";
import { getPageURL } from "../../../config/routes";
const sourceOwners = new WeakSet();
const versions = new Map();
const requests = new Map();
let installed = false;
let host;
let rendererReady;
function key(sessionId, snapshotId) {
    return JSON.stringify([sessionId, snapshotId]);
}
function setup() {
    if (installed)
        return;
    installed = true;
    ipcMain.handle('ppt-preview-render:ready', (event) => {
        if (rendererReady?.sender === event.sender)
            rendererReady.resolve();
    });
    ipcMain.on('ppt-preview-render:result', (event, result) => {
        const task = requests.get(result?.requestId);
        if (!task || task.sender !== event.sender)
            return;
        requests.delete(result.requestId);
        if (result.error || !Number.isSafeInteger(result.slideCount) || result.slideCount < 1)
            task.reject(new Error(result.error ?? 'Invalid PPT preview result'));
        else
            task.resolve({ slideCount: result.slideCount });
    });
    ipcMain.handle('ppt-preview:open-version', async (event, input) => {
        const version = versions.get(key(input?.sessionId, input?.snapshotId));
        if (!version || version.artifactId !== input.artifactId)
            throw new Error('PPT snapshot is not prepared in this session');
        return openSource(event.sender, version);
    });
}
/** Application lifecycle owns shutdown; the renderer owns no app quit listeners. */
export async function disposePptPreviewRenderHost() {
    versions.clear();
    const window = await host?.catch(() => undefined);
    if (window && !window.isDestroyed())
        window.destroy();
}
async function windowHost() {
    setup();
    if (!host)
        host = (async () => {
            const window = new BrowserWindow({
                show: false,
                width: 1280,
                height: 720,
                webPreferences: {
                    preload: path.resolve(__dirname, '../../../preload.js'),
                    contextIsolation: true,
                    sandbox: true,
                    nodeIntegration: false,
                    backgroundThrottling: false,
                },
            });
            const ready = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('PPT render host did not initialize')), 30000);
                rendererReady = {
                    sender: window.webContents,
                    resolve: () => {
                        clearTimeout(timer);
                        resolve();
                    },
                };
            });
            window.on('closed', () => {
                host = undefined;
            });
            window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            window.webContents.on('will-navigate', (event) => event.preventDefault());
            const contents = window.webContents;
            const senderId = contents.id;
            contents.once('destroyed', () => {
                for (const [id, task] of requests)
                    if (task.sender === contents) {
                        requests.delete(id);
                        task.reject(new Error('PPT render host closed'));
                    }
                void documentPreviewSourceRegistry.releaseSender(senderId, contents);
            });
            try {
                await window.loadURL(getPageURL('/ppt-preview-renderer'));
                await ready;
                return window;
            }
            catch (error) {
                window.destroy();
                host = undefined;
                throw error;
            }
        })();
    return host;
}
async function openSource(sender, input) {
    const opened = await documentPreviewSourceRegistry.open(sender.id, {
        readOnly: true,
        workspaceDir: path.dirname(input.snapshot.sourcePath),
        filePath: path.basename(input.snapshot.sourcePath),
        fileName: `${input.snapshot.snapshotId}.pptx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        sessionId: input.sessionId,
    }, sender);
    if (!opened.ok)
        throw new Error(`PPT_SOURCE_OPEN_FAILED:${opened.error.code}`);
    if (!sourceOwners.has(sender)) {
        sourceOwners.add(sender);
        const senderId = sender.id;
        sender.once('destroyed', () => {
            void documentPreviewSourceRegistry.releaseSender(senderId, sender);
        });
    }
    return opened.value;
}
export async function preparePptPreview(input, dataDir, signal) {
    const root = await realpath(path.join(dataDir, 'v2', 'ppt-preview'));
    const source = await realpath(input.snapshot.sourcePath);
    const relative = path.relative(root, source);
    if (!relative ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        path.extname(source) !== '.pptx')
        throw new Error('PPT snapshot is outside the profile publication store');
    const bytes = await readFile(source);
    if (bytes.length !== input.snapshot.sizeBytes ||
        `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== input.snapshot.contentHash)
        throw new Error('PPT snapshot integrity check failed');
    if (signal.aborted)
        throw new Error('PPT preparation canceled');
    const window = await windowHost();
    if (signal.aborted)
        throw new Error('PPT preparation canceled');
    const opened = await openSource(window.webContents, input);
    if (signal.aborted) {
        await documentPreviewSourceRegistry.release(window.webContents.id, opened.sourceId, window.webContents);
        throw new Error('PPT preparation canceled');
    }
    const result = await new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const cleanup = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
            requests.delete(requestId);
        };
        const cancel = () => {
            cleanup();
            if (!window.isDestroyed())
                window.webContents.send('ppt-preview-render:cancel', requestId);
            reject(new Error('PPT preparation canceled or timed out'));
        };
        const timer = setTimeout(cancel, 180000);
        requests.set(requestId, {
            sender: window.webContents,
            resolve: (value) => {
                cleanup();
                resolve(value);
            },
            reject: (error) => {
                cleanup();
                reject(error);
            },
        });
        signal.addEventListener('abort', cancel, { once: true });
        window.webContents.send('ppt-preview-render:prepare', {
            requestId,
            sourceId: opened.sourceId,
            contentHash: input.snapshot.contentHash,
            pages: input.snapshot.pages,
        });
    });
    versions.set(key(input.sessionId, input.snapshot.snapshotId), input);
    return result;
}
export function handlePptPreviewBrokerMessage(target, raw, dataDir) {
    if (!raw || typeof raw !== 'object' || !('type' in raw))
        return false;
    const message = raw;
    if (message.type === 'ppt-preview-render-cancel') {
        const job = operations.get(message.requestId);
        if (job?.target === target)
            job.controller.abort();
        return true;
    }
    if (message.type !== 'ppt-preview-render-request')
        return false;
    if (operations.has(message.requestId))
        return true;
    const controller = new AbortController();
    operations.set(message.requestId, { target, controller });
    void (async () => {
        if (!message.input || message.input.sessionId !== message.sessionId)
            throw new Error('Invalid PPT preparation session');
        return preparePptPreview(message.input, dataDir, controller.signal);
    })()
        .then((value) => target.postMessage({
        type: 'ppt-preview-render-result',
        requestId: message.requestId,
        value,
    }), (error) => {
        console.warn('[ppt-preview-render] preparation failed', {
            snapshotId: message.input?.snapshot.snapshotId,
            reason: error instanceof Error ? error.message : 'PPT preparation failed',
        });
        return target.postMessage({
            type: 'ppt-preview-render-result',
            requestId: message.requestId,
            error: error instanceof Error ? error.message : 'PPT preparation failed',
        });
    })
        .catch(() => { })
        .finally(() => operations.delete(message.requestId));
    return true;
}
const operations = new Map();
