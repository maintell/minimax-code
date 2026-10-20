import { randomBytes } from "node:crypto";
import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshCredentials } from "./credentials";
import { SshRuntimeError } from "./errors";
import { sshPasswordUser, quoteRemoteShellArg } from "./ssh-command";
import { parseSshHostKeyPrompt } from "./ssh-host-key-prompt.js";
/** Grant one password response to one SSH process and exactly its destination prompt. */
export async function prepareSshAuthentication(endpoint, dependencies = {}) {
    if (endpoint.kind !== 'manual' || !endpoint.credentialId)
        return undefined;
    const credentialId = endpoint.credentialId;
    const getPassword = dependencies.getPassword ?? ((id) => sshCredentials.get(id));
    if (!getPassword(credentialId)) {
        throw new SshRuntimeError('credential_unavailable', 'SSH password must be entered again.');
    }
    const token = randomBytes(32).toString('hex');
    const directory = process.platform === 'win32' ? undefined : await mkdtemp(join(tmpdir(), 'mvs-ap-'));
    if (directory)
        await chmod(directory, 0o700);
    const executable = dependencies.executable ?? process.execPath;
    const helperDirectory = dependencies.helperDirectory ?? __dirname;
    const askpassPath = directory ? join(directory, 'askpass.sh') : executable;
    const socketPath = directory ? join(directory, 's') : `\\\\.\\pipe\\mavis-ssh-${token}`;
    // OpenSSH uses these bounded fields in its password prompt (sshconnect2.c).
    const prompt = `${sshPasswordUser(endpoint).slice(0, 30)}@${endpoint.hostname.slice(0, 128)}'s password: `;
    const sockets = new Set();
    let disposed = false;
    let consumed = false;
    let hostKeyRequested = false;
    let hostKeyAccepted = false;
    const abort = new AbortController();
    const signal = dependencies.signal
        ? AbortSignal.any([abort.signal, dependencies.signal])
        : abort.signal;
    let timer;
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => socket.destroy());
        socket.setTimeout(3000, () => socket.destroy());
        let input = '';
        let handled = false;
        socket.on('data', (chunk) => {
            if (handled)
                return;
            input += chunk.toString('utf8');
            if (input.length > 8192)
                return void socket.destroy();
            if (!input.includes('\n'))
                return;
            handled = true;
            try {
                const request = JSON.parse(input);
                if (!request ||
                    typeof request !== 'object' ||
                    !('token' in request) ||
                    request.token !== token ||
                    !('prompt' in request) ||
                    typeof request.prompt !== 'string' ||
                    consumed ||
                    disposed) {
                    socket.destroy();
                    return;
                }
                if (dependencies.confirmHostKey && request.prompt !== prompt && !hostKeyRequested) {
                    const challenge = parseSshHostKeyPrompt(request.prompt, endpoint.hostname, endpoint.port ?? 22);
                    if (!challenge)
                        return void socket.destroy();
                    hostKeyRequested = true;
                    socket.setTimeout(dependencies.timeoutMs ?? 45000);
                    void dependencies
                        .confirmHostKey(challenge, signal)
                        .then((accepted) => {
                        if (disposed || signal.aborted || socket.destroyed || !getPassword(credentialId))
                            return dispose();
                        hostKeyAccepted = accepted;
                        socket.end(accepted ? `${challenge.fingerprint}\n` : 'no\n', () => {
                            if (!accepted)
                                dispose();
                        });
                    })
                        .catch(dispose);
                    return;
                }
                // Confirmation, jump-host and keyboard-interactive prompts never get a password.
                if (request.prompt !== prompt ||
                    ('hint' in request && request.hint) ||
                    (hostKeyRequested && !hostKeyAccepted)) {
                    socket.destroy();
                    return;
                }
                consumed = true;
                // Re-read so deleting a connection revokes even an already-issued grant.
                const password = getPassword(credentialId);
                if (!password)
                    return dispose();
                const bytes = Buffer.from(password + '\n');
                socket.end(bytes, () => {
                    bytes.fill(0);
                    dispose();
                });
            }
            catch {
                socket.destroy();
            }
        });
    });
    function dispose() {
        if (disposed)
            return;
        disposed = true;
        abort.abort();
        dependencies.signal?.removeEventListener('abort', dispose);
        clearTimeout(timer);
        server.close();
        for (const socket of sockets)
            socket.destroy();
        if (directory)
            void rm(directory, { recursive: true, force: true }).catch(() => { });
    }
    try {
        if (directory) {
            // OpenSSH executes this file directly. Only fixed local paths enter the
            // script; its prompt stays a separate argument, including newlines/slashes.
            await writeFile(askpassPath, `#!/bin/sh\nexec ${quoteRemoteShellArg(executable)} ${quoteRemoteShellArg(join(helperDirectory, 'askpass-entry.js'))} "$@"\n`, { mode: 0o700, flag: 'wx' });
        }
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => {
                server.removeListener('error', reject);
                server.on('error', dispose);
                resolve();
            });
        });
        server.unref();
        timer = setTimeout(dispose, dependencies.timeoutMs ?? 45000);
        timer.unref();
        dependencies.signal?.addEventListener('abort', dispose, { once: true });
        if (dependencies.signal?.aborted)
            dispose();
    }
    catch (error) {
        dispose();
        throw error;
    }
    return {
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            // macOS Electron discards NODE_OPTIONS when OpenSSH launches it. Windows
            // OpenSSH needs a native executable, so retain its fixed-preload entry.
            // Neither path inherits arbitrary Node options from the parent process.
            NODE_OPTIONS: directory
                ? undefined
                : `--require ${JSON.stringify(join(helperDirectory, 'askpass-preload.js'))}`,
            SSH_ASKPASS: askpassPath,
            SSH_ASKPASS_REQUIRE: 'force',
            SSH_ASKPASS_PROMPT: undefined,
            LC_ALL: 'C',
            MAVIS_SSH_ASKPASS_SOCKET: socketPath,
            MAVIS_SSH_ASKPASS_TOKEN: token,
            MAVIS_SSH_ASKPASS_EXPECTED_PROMPT: prompt,
            MAVIS_SSH_ASKPASS_HOST: dependencies.confirmHostKey ? endpoint.hostname : undefined,
            MAVIS_SSH_ASKPASS_PORT: dependencies.confirmHostKey ? String(endpoint.port ?? 22) : undefined,
        },
        dispose,
    };
}
