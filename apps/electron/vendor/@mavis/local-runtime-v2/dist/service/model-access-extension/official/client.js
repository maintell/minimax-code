const BASE = '/minimax-cloud/api/v1/model-access';
class ModelAccessRemoteClientError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'ModelAccessRemoteClientError';
    }
}
function invalid() {
    throw new ModelAccessRemoteClientError('response_invalid');
}
function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        invalid();
    return value;
}
function field(item, snake, camel) {
    return item[snake] ?? item[camel];
}
function string(item, snake, camel = snake) {
    const value = field(item, snake, camel);
    if (typeof value !== 'string')
        invalid();
    return value;
}
/** Thrift i64 may arrive as a JSON number or a decimal string. */
function int(item, snake, camel = snake) {
    const raw = field(item, snake, camel);
    const value = typeof raw === 'string' && /^\d{1,16}$/u.test(raw) ? Number(raw) : raw;
    if (!Number.isSafeInteger(value) || value < 0)
        invalid();
    return value;
}
function readCatalog(value) {
    const item = record(value);
    const packages = field(item, 'packages', 'packages');
    if (!Array.isArray(packages) || packages.length > 64)
        invalid();
    return {
        sequence: int(item, 'sequence'),
        catalogJson: string(item, 'catalog_json', 'catalogJson'),
        packages: packages.map((entry) => {
            const pkg = record(entry);
            return {
                name: string(pkg, 'name'),
                version: string(pkg, 'version'),
                attestationJson: string(pkg, 'attestation_json', 'attestationJson'),
            };
        }),
    };
}
/** Authenticated delivery client (Electron, CLI, TUI) over the signed archon_biz transport. */
export class ModelAccessRemoteClient {
    transport;
    info;
    constructor(transport, info) {
        this.transport = transport;
        this.info = info;
    }
    async desktopState(localSequence, signal) {
        const payload = record(await this.transport.request({
            method: 'GET',
            path: `${BASE}/desktop-state`,
            query: {
                client_kind: this.info.clientKind,
                platform: this.info.platform,
                arch: this.info.arch,
                sdk_version: this.info.sdkVersion,
                ...(localSequence ? { local_sequence: localSequence } : {}),
            },
            auth: 'required',
            signal,
        }));
        const enabled = field(payload, 'delivery_enabled', 'deliveryEnabled');
        if (typeof enabled !== 'boolean')
            invalid();
        const catalog = field(payload, 'catalog', 'catalog');
        const interval = field(payload, 'poll_interval_seconds', 'pollIntervalSeconds');
        return {
            deliveryEnabled: enabled,
            ...(enabled && catalog !== undefined && catalog !== null
                ? { catalog: readCatalog(catalog) }
                : {}),
            pollIntervalSeconds: Number.isSafeInteger(interval) && interval > 0 ? interval : 900,
        };
    }
    async authorizeDownload(input, signal) {
        const payload = record(await this.transport.request({
            method: 'POST',
            path: `${BASE}/download-authorization`,
            body: {
                name: input.name,
                version: input.version,
                content_digest: input.contentDigest,
                client_kind: this.info.clientKind,
                platform: this.info.platform,
                sdk_version: this.info.sdkVersion,
            },
            auth: 'required',
            signal,
        }));
        const authorization = record(field(payload, 'authorization', 'authorization'));
        const result = {
            name: string(authorization, 'name'),
            version: string(authorization, 'version'),
            archiveSha256: string(authorization, 'archive_sha256', 'archiveSha256'),
            contentDigest: string(authorization, 'content_digest', 'contentDigest'),
            packageSizeBytes: int(authorization, 'package_size_bytes', 'packageSizeBytes'),
            downloadUrl: string(authorization, 'download_url', 'downloadUrl'),
            expiresAtMs: int(authorization, 'expires_at_ms', 'expiresAtMs'),
        };
        // A presign for another build under the same name/version is never accepted.
        if (result.name !== input.name ||
            result.version !== input.version ||
            result.contentDigest !== input.contentDigest)
            invalid();
        return result;
    }
    downloadToFile(url, targetPath, signal) {
        return this.transport.downloadToFile(url, targetPath, signal);
    }
}
//# sourceMappingURL=client.js.map