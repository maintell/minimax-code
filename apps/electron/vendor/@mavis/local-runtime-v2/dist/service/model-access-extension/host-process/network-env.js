import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
/**
 * Network env for the extension host. Node reads *_PROXY and NODE_EXTRA_CA_CERTS once at start,
 * so a host started before the proxy app set the system proxy, or one whose proxy later moved,
 * kept going direct. Vendors behind a TLS-inspecting proxy or VPN also fail
 * when the host trusts only Node's bundled roots. This reads the system proxy (when the env names
 * none) and the roots the user or an admin installed, and says when a running host is stale.
 */
const PROXY_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'];
const LOOPBACK = ['localhost', '127.0.0.1', '::1'];
const TOOL_TIMEOUT_MS = 5_000;
/**
 * Set by the Electron utility when its *_PROXY came from Chromium's one-time system proxy
 * resolution rather than from the user; such a proxy is re-read like the system's.
 */
const SYSTEM_PROXY_INJECTED_ENV = 'MCODE_SYSTEM_PROXY_INJECTED';
function runTool(file, args) {
    return new Promise((resolve, reject) => {
        execFile(file, [...args], { timeout: TOOL_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
    });
}
/** `key : value` of one scutil line, or nothing. */
function scutilPair(line) {
    const at = line.indexOf(' : ');
    return at > 0 ? [line.slice(0, at).trim(), line.slice(at + 3).trim()] : undefined;
}
/** scutil's top-level values and its ExceptionsList items. */
function scutilValues(out) {
    const values = new Map();
    const bypass = [];
    let inList = false;
    for (const raw of out.split('\n')) {
        const line = raw.trim();
        const pair = scutilPair(line);
        if (inList) {
            inList = line !== '}';
            if (inList && pair)
                bypass.push(pair[1]);
        }
        else if (pair?.[0] === 'ExceptionsList')
            inList = true;
        else if (pair)
            values.set(pair[0], pair[1]);
    }
    return { values, bypass };
}
/** `scutil --proxy`: HTTPS wins over HTTP over SOCKS, as CFNetwork reads it. @internal */
export function parseScutilProxy(out) {
    const { values, bypass } = scutilValues(out);
    const entry = (name, scheme) => {
        const host = values.get(`${name}Proxy`);
        if (values.get(`${name}Enable`) !== '1' || !host)
            return undefined;
        const port = values.get(`${name}Port`);
        return `${scheme}://${host.includes(':') ? `[${host}]` : host}${port ? `:${port}` : ''}`;
    };
    const url = entry('HTTPS', 'http') ?? entry('HTTP', 'http') ?? entry('SOCKS', 'socks5');
    if (url)
        return { url, bypass };
    return values.get('ProxyAutoConfigEnable') === '1' ? { bypass: [], pac: true } : { bypass: [] };
}
/** Internet Options' ProxyServer ("host:port" or "http=h:p;https=h:p") and ProxyOverride. @internal */
export function parseWindowsProxy(server, override) {
    const value = server.trim();
    if (!value)
        return { bypass: [] };
    const bypass = override.split(';').map((item) => item.trim());
    if (!value.includes('='))
        return { url: value.includes('://') ? value : `http://${value}`, bypass };
    const byScheme = new Map();
    for (const part of value.split(';')) {
        const at = part.indexOf('=');
        if (at > 0)
            byScheme.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
    }
    const entry = (key, scheme) => {
        const item = byScheme.get(key);
        if (!item)
            return undefined;
        return item.includes('://') ? item : `${scheme}://${item}`;
    };
    const url = entry('https', 'http') ?? entry('http', 'http') ?? entry('socks', 'socks5');
    return url ? { url, bypass } : { bypass: [] };
}
function registryValue(out, name) {
    for (const line of out.split(/\r?\n/u)) {
        const match = line.match(/^\s*(\S+)\s+REG_\w+\s+(.*)$/u);
        if (match && match[1] === name)
            return match[2].trim();
    }
    return undefined;
}
async function readWindowsProxy(run) {
    const out = await run('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ]);
    const pac = !!registryValue(out, 'AutoConfigURL');
    if (!/^0x0*1$/iu.test(registryValue(out, 'ProxyEnable') ?? ''))
        return pac ? { bypass: [], pac } : { bypass: [] };
    return parseWindowsProxy(registryValue(out, 'ProxyServer') ?? '', registryValue(out, 'ProxyOverride') ?? '');
}
/** The system proxy, or none when it can't be read; only macOS and Windows keep one apart. @internal */
export async function readSystemProxy(seams = {}) {
    const platform = seams.platform ?? process.platform;
    const run = seams.run ?? runTool;
    try {
        if (platform === 'darwin')
            return parseScutilProxy(await run('/usr/sbin/scutil', ['--proxy']));
        if (platform === 'win32')
            return await readWindowsProxy(run);
    }
    catch {
        /* An unreadable system proxy is none; the env still applies. */
    }
    return { bypass: [] };
}
function namesAnyProxy(env) {
    return Object.entries(env).some(([key, value]) => ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'].includes(key.toUpperCase()) && !!value?.trim());
}
/** The user's own *_PROXY, which is never replaced by the system's. */
function namesProxy(env) {
    return !env[SYSTEM_PROXY_INJECTED_ENV] && namesAnyProxy(env);
}
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'];
function withNodeProxy(value) {
    return namesAnyProxy(value)
        ? { ...value, NODE_USE_ENV_PROXY: value.NODE_USE_ENV_PROXY ?? '1' }
        : value;
}
/** `env` without the keys whose upper-case name `drop` selects. */
function withoutKeys(env, drop) {
    const result = {};
    for (const [key, value] of Object.entries(env))
        if (!drop(key.toUpperCase()))
            result[key] = value;
    return result;
}
/** Loopback plus the system's bypass list, as NO_PROXY reads it. */
function noProxyList(bypass) {
    const noProxy = [...LOOPBACK];
    for (const raw of bypass) {
        const item = raw.trim().replace(/^\*/u, '');
        if (item && item !== '<local>' && !noProxy.includes(item))
            noProxy.push(item);
    }
    return noProxy.join(',');
}
/**
 * The user's own *_PROXY wins; otherwise the system proxy is used, with loopback and the system's
 * bypass list in NO_PROXY. A proxy Chromium injected is replaced by the system's, dropped when
 * the system names none, and kept when a PAC script decides. Node's fetch only honours *_PROXY
 * with NODE_USE_ENV_PROXY.
 * @internal Exported for focused tests.
 */
export function proxyEnvironment(env, system) {
    if (namesProxy(env) || (system.pac && !system.url))
        return withNodeProxy(env);
    const injected = !!env[SYSTEM_PROXY_INJECTED_ENV];
    if (!system.url && !injected)
        return env;
    const result = withoutKeys(env, (key) => PROXY_ENV_KEYS.includes(key));
    if (!system.url)
        return result;
    const joined = noProxyList(system.bypass);
    return {
        ...withoutKeys(result, (key) => key === 'NO_PROXY'),
        HTTPS_PROXY: system.url,
        HTTP_PROXY: system.url,
        NO_PROXY: joined,
        no_proxy: joined,
        NODE_USE_ENV_PROXY: '1',
    };
}
/** Whether a fingerprint names a proxy, not only NO_PROXY. */
export function fingerprintProxied(fingerprint) {
    return /(?:^|\0)(?:HTTPS|HTTP|ALL)_PROXY=/u.test(fingerprint);
}
/** A comparable fingerprint of the proxy a host is started with. @internal */
export function proxyFingerprint(env) {
    return Object.entries(env)
        .filter(([key, value]) => PROXY_KEYS.includes(key.toUpperCase()) && value)
        .map(([key, value]) => `${key.toUpperCase()}=${value}`)
        .sort()
        .join('\0');
}
/** A small XML plist reader: enough for `security trust-settings-export`. */
function parsePlist(xml) {
    const root = { tag: '#root', children: [] };
    const stack = [root];
    const pattern = /<(\/?)([A-Za-z]+)(\s[^>]*)?(\/?)>|([^<]+)/gu;
    for (const match of xml.matchAll(pattern)) {
        const [, closing, tag, , selfClosing, text] = match;
        const top = stack[stack.length - 1];
        if (text !== undefined) {
            if (text.trim())
                top.text = (top.text ?? '') + text.trim();
            continue;
        }
        if (closing) {
            if (stack.length > 1)
                stack.pop();
            continue;
        }
        const node = { tag: tag, children: [] };
        top.children.push(node);
        if (!selfClosing)
            stack.push(node);
    }
    const value = (node) => {
        switch (node.tag) {
            case 'dict': {
                const out = {};
                for (let i = 0; i + 1 < node.children.length; i += 2)
                    out[node.children[i].text ?? ''] = value(node.children[i + 1]);
                return out;
            }
            case 'array':
                return node.children.map(value);
            case 'integer':
                return Number.parseInt(node.text ?? '', 10);
            case 'true':
                return true;
            case 'false':
                return false;
            default:
                return node.text ?? '';
        }
    };
    const plist = root.children.find((node) => node.tag === 'plist');
    return plist?.children[0] ? value(plist.children[0]) : undefined;
}
/**
 * SHA-1s of certificates an exported trust-settings plist trusts: empty settings (trust as root)
 * or a TrustRoot/TrustAsRoot result, and no Deny; a setting with no result means trust.
 * @internal Exported for focused tests.
 */
export function trustedInPlist(xml) {
    const out = new Map();
    let top;
    try {
        top = parsePlist(xml);
    }
    catch {
        return out;
    }
    const list = top?.trustList;
    if (!list || typeof list !== 'object')
        return out;
    for (const [hash, entry] of Object.entries(list)) {
        const settings = Array.isArray(entry?.trustSettings) ? entry.trustSettings : [];
        out.set(hash.toUpperCase(), settingsTrust(settings));
    }
    return out;
}
/** Empty settings trust as root; otherwise a trust result and no Deny. */
function settingsTrust(settings) {
    let trust = settings.length === 0;
    let deny = false;
    for (const item of settings) {
        const result = item?.kSecTrustSettingsResult;
        if (result === undefined || result === 1 || result === 2)
            trust = true;
        else if (result === 3)
            deny = true;
    }
    return trust && !deny;
}
function pemBlocks(text) {
    return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu) ?? [];
}
/** One domain's exported trust settings; a domain with no settings exports nothing. */
async function exportedTrust(run, read, domain, file) {
    try {
        await run('/usr/bin/security', ['trust-settings-export', ...domain, file]);
        return trustedInPlist(await read(file));
    }
    catch {
        return new Map();
    }
}
/** The admin's then the user's trust settings, by certificate SHA-1. */
async function macTrustSettings(run, read) {
    const trusted = new Map();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mcode-trust-'));
    try {
        // The user's settings win over the admin's, so they are read last.
        for (const domain of [['-d'], []]) {
            const file = path.join(directory, `trust-${domain.length}.plist`);
            for (const [hash, ok] of await exportedTrust(run, read, domain, file))
                trusted.set(hash, ok);
        }
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
    return trusted;
}
/** Every certificate in the system and login keychains, as PEM text. */
async function macKeychainCertificates(run, home) {
    const keychains = ['/Library/Keychains/System.keychain'];
    if (home)
        keychains.push(path.join(home, 'Library', 'Keychains', 'login.keychain-db'));
    try {
        return await run('/usr/bin/security', ['find-certificate', '-a', '-p', ...keychains]);
    }
    catch (error) {
        // A keychain that is missing still lets the other one print.
        return String(error.stdout ?? '');
    }
}
function sha1Fingerprint(pem) {
    try {
        return new X509Certificate(pem).fingerprint.replaceAll(':', '').toUpperCase();
    }
    catch {
        return undefined;
    }
}
async function macTrustedRoots(seams) {
    const run = seams.run ?? runTool;
    const read = seams.readText ?? ((file) => readFile(file, 'utf8'));
    const trusted = await macTrustSettings(run, read);
    if (![...trusted.values()].some(Boolean))
        return [];
    const out = await macKeychainCertificates(run, seams.home ?? os.homedir());
    const roots = [];
    for (const pem of pemBlocks(out)) {
        const hash = sha1Fingerprint(pem);
        if (!hash || !trusted.get(hash))
            continue;
        roots.push(pem);
        trusted.delete(hash);
    }
    return roots;
}
async function windowsRoots(seams) {
    const run = seams.run ?? runTool;
    // CurrentUser\Root also lists the machine's roots.
    const script = "Get-ChildItem Cert:\\CurrentUser\\Root | ForEach-Object { '-----BEGIN CERTIFICATE-----'; [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks'); '-----END CERTIFICATE-----' }";
    try {
        return pemBlocks(await run('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
        ]));
    }
    catch {
        return [];
    }
}
const LINUX_BUNDLES = [
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/pki/tls/certs/ca-bundle.crt',
    '/etc/ssl/ca-bundle.pem',
    '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
    '/etc/pki/tls/cacert.pem',
    '/etc/ssl/cert.pem',
];
/**
 * A PEM file of the roots this machine trusts beyond Node's own, under `directory` and named by
 * its content, or undefined when there is none to add. Only the roots a user or admin marked as
 * trusted are read on macOS (Apple's own ship with Node); the whole store on Windows; the
 * distribution's bundle on Linux.
 * @internal Exported for focused tests.
 */
export async function systemCaFile(directory, env, seams = {}) {
    const platform = seams.platform ?? process.platform;
    if (platform === 'linux')
        return linuxBundle(env);
    let roots;
    try {
        roots = await platformRoots(platform, seams);
    }
    catch {
        return undefined;
    }
    return roots.length === 0 ? undefined : writeCaFile(directory, `${roots.join('\n')}\n`);
}
async function linuxBundle(env) {
    for (const file of [env.SSL_CERT_FILE, ...LINUX_BUNDLES]) {
        if (file && (await isFile(file)))
            return file;
    }
    return undefined;
}
async function isFile(file) {
    try {
        return (await stat(file)).isFile();
    }
    catch {
        return false;
    }
}
function platformRoots(platform, seams) {
    if (platform === 'darwin')
        return macTrustedRoots(seams);
    if (platform === 'win32')
        return windowsRoots(seams);
    return Promise.resolve([]);
}
/** The roots as a PEM file named by its content; reused when it is already there. */
async function writeCaFile(directory, text) {
    const name = `system-ca-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.pem`;
    const file = path.join(directory, name);
    try {
        if ((await readFile(file, 'utf8')) === text)
            return file;
    }
    catch {
        /* Written below. */
    }
    try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.${Date.now()}.pending`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, file);
        return file;
    }
    catch {
        return undefined;
    }
}
const PROXY_LOOK_EVERY_MS = 15_000;
const PROXY_LOOK_NONE_MS = 2_000;
/**
 * The env a host starts with and whether a running host's proxy moved. The system CA file is read
 * once a run; the system proxy at most every 15 s while one is set and every 2 s while none is
 * (a host started at login may come up before the proxy app does).
 */
export class ModelAccessHostNetwork {
    caDirectory;
    base;
    seams;
    now;
    ca;
    lookedAt = 0;
    looking;
    constructor(caDirectory, base = () => process.env, seams = {}, now = Date.now) {
        this.caDirectory = caDirectory;
        this.base = base;
        this.seams = seams;
        this.now = now;
    }
    async environment() {
        const base = this.base();
        const withProxy = proxyEnvironment(base, namesProxy(base) ? { bypass: [] } : await readSystemProxy(this.seams));
        this.lookedAt = this.now();
        const env = { ...withProxy };
        if (!env.NODE_EXTRA_CA_CERTS?.trim()) {
            this.ca ??= systemCaFile(this.caDirectory, base, this.seams);
            const file = await this.ca;
            if (file)
                env.NODE_EXTRA_CA_CERTS = file;
        }
        return { env, proxy: proxyFingerprint(withProxy) };
    }
    /**
     * The current proxy fingerprint when a look is due, else undefined. A look is due every 15 s
     * while a host runs with a proxy, every 2 s while one runs without.
     */
    lookIfDue(anyProxied) {
        const every = anyProxied ? PROXY_LOOK_EVERY_MS : PROXY_LOOK_NONE_MS;
        if (this.now() - this.lookedAt < every)
            return Promise.resolve(undefined);
        this.looking ??= (async () => {
            try {
                this.lookedAt = this.now();
                const base = this.base();
                return proxyFingerprint(proxyEnvironment(base, namesProxy(base) ? { bypass: [] } : await readSystemProxy(this.seams)));
            }
            finally {
                this.looking = undefined;
            }
        })();
        return this.looking;
    }
}
//# sourceMappingURL=network-env.js.map