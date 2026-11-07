/** Windows OpenSSH needs a native askpass executable; finish before Node resolves argv[1]. */
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseSshHostKeyPrompt } from "./ssh-host-key-prompt.js";
if (process.env.MAVIS_SSH_ASKPASS_SOCKET && process.env.MAVIS_SSH_ASKPASS_TOKEN) {
    const expected = process.env.MAVIS_SSH_ASKPASS_EXPECTED_PROMPT;
    const argument = process.argv[1] ?? '';
    let prompt = expected && (argument === expected || argument === resolve(expected)) ? expected : undefined;
    const host = process.env.MAVIS_SSH_ASKPASS_HOST;
    if (!prompt && host) {
        // Node expands argv[1] as a path before preloads, collapsing consecutive '/'
        // inside a SHA-256 fingerprint. The report header retains the original argv.
        // Never persist or log the report (it also contains process diagnostics).
        const report = process.report?.getReport();
        const argv = report?.header?.commandLine;
        if (Array.isArray(argv) &&
            argv.length === 2 &&
            typeof argv[1] === 'string' &&
            (argument === argv[1] || argument === resolve(argv[1])))
            prompt = argv[1];
    }
    const isHostKey = host &&
        prompt &&
        parseSshHostKeyPrompt(prompt, host, Number(process.env.MAVIS_SSH_ASKPASS_PORT));
    // A Node-based ProxyCommand may inherit NODE_OPTIONS. Do not intercept its script.
    if (prompt && (prompt === expected || isHostKey)) {
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        const result = spawnSync(process.execPath, [join(__dirname, 'askpass-entry.js'), prompt], {
            env,
            encoding: 'utf8',
            windowsHide: true,
            timeout: isHostKey ? 125000 : 10000,
            maxBuffer: 2048,
        });
        if (result.status === 0 && result.stdout)
            writeSync(1, result.stdout);
        process.exit(result.status === 0 ? 0 : 1);
    }
}
