/** Parse only OpenSSH's C-locale first-use prompt for the exact destination. */
export function parseSshHostKeyPrompt(prompt, hostname, port) {
    if (prompt.length > 4096)
        return undefined;
    // OpenSSH 10.2 uses "is: SHA256:..."; older clients use "is SHA256:....".
    const match = /^The authenticity of host '([^'\r\n]+) \(([^)\r\n]+)\)' can't be established\.\r?\n([A-Z0-9-]+) key fingerprint is:? (SHA256:[A-Za-z0-9+/]{43})\.?\r?\n/u.exec(prompt);
    const target = port === 22 ? hostname : `[${hostname}]:${port}`;
    if (!match || match[1] !== target)
        return undefined;
    if (!/Are you sure you want to continue connecting \(yes\/no(?:\/\[fingerprint\])?\)\?\s*$/u.test(prompt))
        return undefined;
    return { hostname, port, keyType: match[3], fingerprint: match[4] };
}
