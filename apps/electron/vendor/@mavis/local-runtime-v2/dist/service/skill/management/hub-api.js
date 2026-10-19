import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getRuntimeBuildEnv, getRuntimeRegion, isManagedRuntime, } from '@mavis/config';
import { LocalSkillHubInstallError } from './hub-errors.js';
import { writeInstalledSkill } from './hub-install.js';
import { deriveSkillName, resolveInstallSkillName } from './skill-name-utils.js';
import { scanRemoteSkillArchiveSource, selectRemoteSkillInstall, toLocalSkillPreviewResp, } from './remote/archive.js';
import { remoteSkillArchiveCacheKeys, remoteSkillInstallHint, remoteSkillUrlCacheKey, RemoteSkillPreviewCache, } from './remote/cache.js';
import { managedBackendRoutingHeaders, } from '@mavis/agent-tools/desktop';
export { LocalSkillHubInstallError } from './hub-errors.js';
const USER_SOURCE_TYPE = 2;
const OFFICIAL_SOURCE_TYPE = 1;
const SOURCE_TYPE_ALL = 0;
const REMOTE_SKILL_SORT_TYPE_USE_COUNT = 1;
const REMOTE_SKILL_HUB_TIMEOUT_MS = 10_000;
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const SKILL_HUB_BASE = {
    cn: {
        dev: 'https://agent.minimax.cn/minimax-cloud/api/v1/skill-hub',
        test: 'https://agent.minimax.cn/minimax-cloud/api/v1/skill-hub',
        staging: 'https://agent.minimax.cn/minimax-cloud/api/v1/skill-hub',
        prod: 'https://agent.minimax.cn/minimax-cloud/api/v1/skill-hub',
    },
    en: {
        dev: 'https://agent.minimax.io/minimax-cloud/api/v1/skill-hub',
        test: 'https://agent.minimax.io/minimax-cloud/api/v1/skill-hub',
        staging: 'https://agent.minimax.io/minimax-cloud/api/v1/skill-hub',
        prod: 'https://agent.minimax.io/minimax-cloud/api/v1/skill-hub',
    },
};
export class LocalSkillHubStore {
    options;
    remoteSkillPreviewCache;
    constructor(options) {
        this.options = options;
        this.remoteSkillPreviewCache = new RemoteSkillPreviewCache(() => this.nowMs());
    }
    async list(input) {
        const file = await this.readFile();
        const sourceType = readOptionalNumber(input.sourceType);
        const sortType = readOptionalNumber(input.sortType);
        const remote = await this.queryRemote({ ...input, sourceType, sortType }, file);
        if (remote)
            return remote;
        const keyword = input.keyword?.trim().toLowerCase();
        const filtered = file.skills.filter((skill) => {
            if (sourceType !== undefined &&
                sourceType !== SOURCE_TYPE_ALL &&
                skill.publisher_source_type !== sourceType) {
                return false;
            }
            if (!keyword)
                return true;
            return (skill.name.toLowerCase().includes(keyword) ||
                skill.description.toLowerCase().includes(keyword) ||
                // Match display_name so hub-installed skills whose internal SKILL.md
                // name differs from the localized display name the user saw during
                // install remain discoverable by that name.
                (skill.display_name?.toLowerCase().includes(keyword) ?? false));
        });
        const start = Math.max(0, Number.parseInt(input.nextToken ?? '0', 10) || 0);
        const limit = input.limit && input.limit > 0 ? input.limit : filtered.length;
        const page = filtered.slice(start, start + limit);
        const next = start + page.length;
        return {
            skill_list: page.map((skill) => ({
                // skill-hub.json is an install ledger, not a cached Marketplace
                // catalog. Even added=false rows are previously installed local
                // copies, whose legacy source_type=2 only means "editable".
                id: skill.id,
                name: skill.name,
                ...(skill.display_name ? { display_name: skill.display_name } : {}),
                description: skill.description,
                content: skill.content,
                source_url: skill.source_url,
                ...(skill.publisher_source_type !== undefined
                    ? {
                        source_type: skill.publisher_source_type,
                        publisher_source_type: skill.publisher_source_type,
                    }
                    : {}),
                ...(skill.use_count !== undefined ? { use_count: skill.use_count } : {}),
                ...(skill.creator_info ? { creator_info: skill.creator_info } : {}),
                added: file.installed[skill.name] !== undefined || skill.added,
                created_at: skill.created_at,
                updated_at: skill.updated_at,
            })),
            has_more: next < filtered.length,
            next_token: next < filtered.length ? String(next) : '',
        };
    }
    async install(body) {
        const file = await this.readFile();
        const { sourceUrl, displayName, explicitName, agentName, existing, publisherSourceType, resolvedCreatorInfo, } = readInstallIdentity(body, file.skills);
        let explicitContent = readString(body['content']);
        let installFiles;
        const now = this.nowMs();
        if (!explicitContent && isHttpUrl(sourceUrl)) {
            const remoteInstall = await this.fetchRemoteSkillInstall(sourceUrl);
            explicitContent = remoteInstall.content;
            installFiles = remoteInstall.files;
        }
        if (!explicitContent && !existing?.content) {
            throw new LocalSkillHubInstallError('Local skill-hub install requires inline skill content or an existing local hub item.', 'LOCAL_SKILL_HUB_REMOTE_INSTALL_UNAVAILABLE', 422);
        }
        // Derive a stable, collision-free identity used as the on-disk directory,
        // the hub dedup key, and the `installed` detection key — never a shared
        // constant. Prefer an explicit name, then the matched hub item's own name,
        // then the skill's frontmatter name, then the source-URL slug.
        const name = resolveInstallSkillName({
            explicitName,
            existingName: existing?.name,
            content: explicitContent ?? existing?.content,
            displayName,
            sourceUrl,
        });
        const item = createInstalledItem({
            body,
            file,
            existing,
            name,
            displayName,
            explicitContent,
            sourceUrl,
            publisherSourceType,
            resolvedCreatorInfo,
            now,
        });
        // Replace any prior record for this identity or source URL (also migrates a
        // legacy colliding `local-skill` row onto its real per-skill identity).
        file.skills = [
            ...file.skills.filter((skill) => skill.name !== name && skill.source_url !== sourceUrl),
            item,
        ];
        file.installed[name] = now;
        await this.writeFile(file);
        const skill = await writeInstalledSkill({
            dataDir: this.options.dataDir(),
            item,
            agentName,
            sourceType: USER_SOURCE_TYPE,
            files: installFiles,
        });
        return {
            ok: true,
            skill: {
                ...skill,
                ...(publisherSourceType !== undefined
                    ? { publisher_source_type: publisherSourceType }
                    : {}),
                ...(resolvedCreatorInfo ? { creator_info: resolvedCreatorInfo } : {}),
            },
        };
    }
    async preview(input) {
        return toLocalSkillPreviewResp(await this.scanRemoteSkill(input.url, { ref: input.ref, promoteRepoKeys: true }));
    }
    async uninstall(name) {
        const file = await this.readFile();
        const hadInstalled = file.installed[name] !== undefined;
        const now = this.nowMs();
        let changed = false;
        if (hadInstalled) {
            delete file.installed[name];
            changed = true;
        }
        file.skills = file.skills.map((skill) => {
            if (skill.name !== name || !skill.added)
                return skill;
            changed = true;
            return { ...skill, added: false, updated_at: now };
        });
        if (changed)
            await this.writeFile(file);
        return changed;
    }
    // Market installs are global. Key their identity and presentation metadata
    // by the exact global SKILL.md URI so a same-name agent/workspace winner
    // never inherits either the Market source marker or card metadata.
    async getInstalledGlobalMetadataByLocation() {
        const file = await this.readFile();
        let dataDir;
        try {
            dataDir = await realpath(this.options.dataDir());
        }
        catch {
            dataDir = this.options.dataDir();
        }
        return new Map(file.skills.flatMap((skill) => {
            if (!(file.installed[skill.name] !== undefined || skill.added)) {
                return [];
            }
            return [
                [
                    skillLocationUri(join(dataDir, 'skills', skill.name, 'SKILL.md')),
                    {
                        ...(skill.display_name ? { displayName: skill.display_name } : {}),
                        ...(skill.creator_info
                            ? {
                                creatorInfo: {
                                    userId: skill.creator_info.user_id,
                                    userName: skill.creator_info.user_name,
                                    avatarUrl: skill.creator_info.avatar_url,
                                },
                            }
                            : {}),
                        ...(skill.publisher_source_type !== undefined
                            ? { publisherSourceType: skill.publisher_source_type }
                            : {}),
                    },
                ],
            ];
        }));
    }
    async getInstalledIdentities() {
        const file = await this.readFile();
        const installed = file.skills.filter((skill) => file.installed[skill.name] !== undefined || skill.added);
        return {
            names: new Set(installed.map((skill) => normalizeIdentity(skill.name))),
            sourceUrls: new Set(installed.map((skill) => skill.source_url.trim()).filter((value) => value.length > 0)),
        };
    }
    async fetchRemoteSkillInstall(sourceUrl) {
        return selectRemoteSkillInstall(await this.scanRemoteSkill(sourceUrl, { promoteRepoKeys: false }), remoteSkillInstallHint(sourceUrl));
    }
    async scanRemoteSkill(sourceUrl, options) {
        const lookupKeys = remoteSkillArchiveCacheKeys(sourceUrl, undefined, options.ref);
        const cached = this.remoteSkillPreviewCache.read(lookupKeys);
        if (cached)
            return cached;
        const promise = scanRemoteSkillArchiveSource(sourceUrl, {
            fetch: this.options.fetch ?? fetch,
            ref: options.ref,
        });
        const writeKeys = options.promoteRepoKeys
            ? lookupKeys
            : [remoteSkillUrlCacheKey(sourceUrl, options.ref)];
        const initialEntry = this.remoteSkillPreviewCache.write(writeKeys, promise);
        let result;
        try {
            result = await promise;
        }
        catch (error) {
            this.remoteSkillPreviewCache.deleteEntry(initialEntry);
            throw error;
        }
        try {
            if (options.promoteRepoKeys) {
                this.remoteSkillPreviewCache.write(remoteSkillArchiveCacheKeys(sourceUrl, result.repoInfo, options.ref), Promise.resolve(result));
            }
        }
        catch {
            // Cache promotion is best-effort; the successfully downloaded archive remains usable.
            this.remoteSkillPreviewCache.deleteEntry(initialEntry);
        }
        return result;
    }
    nowMs() {
        return this.options.nowMs?.() ?? Date.now();
    }
    filePath() {
        return join(this.options.dataDir(), 'skill-hub.json');
    }
    async readFile() {
        try {
            const parsed = JSON.parse(await readFile(this.filePath(), 'utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return { skills: [], installed: {} };
            }
            const record = parsed;
            return {
                skills: normalizeItems(record.skills),
                installed: readNumberRecord(record.installed),
            };
        }
        catch {
            return { skills: [], installed: {} };
        }
    }
    async writeFile(file) {
        await mkdir(dirname(this.filePath()), { recursive: true });
        await writeFile(this.filePath(), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    }
    async queryRemote(input, file) {
        if (!(this.options.remoteEnabled ?? isManagedRuntime)())
            return undefined;
        const { requestUrl, accessToken, buildEnv } = this.remoteRequest(input);
        let response;
        try {
            response = await (this.options.fetch ?? fetch)(requestUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'MiniMaxAgent',
                    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
                    ...managedBackendRoutingHeaders(this.options.routingContextGetter?.(), this.options.buildEnv ? buildEnv : process.env.MAVIS_BUILD_ENV),
                },
                signal: AbortSignal.timeout(REMOTE_SKILL_HUB_TIMEOUT_MS),
            });
        }
        catch {
            return undefined;
        }
        if (!response.ok)
            return undefined;
        let payload;
        try {
            payload = (await response.json());
        }
        catch {
            return undefined;
        }
        if (remoteHubRequestFailed(payload))
            return undefined;
        return projectRemoteHubResponse(payload, file);
    }
    remoteRequest(input) {
        const buildEnv = (this.options.buildEnv ?? getRuntimeBuildEnv)();
        const requestUrl = buildRemoteQuery(this.remoteUrl(undefined, buildEnv), input);
        const authContext = this.options.authContextGetter?.();
        const accessToken = authContext?.accessToken?.trim();
        const realUserID = authContext?.realUserID?.trim();
        if (accessToken && realUserID)
            requestUrl.searchParams.set('user_id', realUserID);
        return { requestUrl, accessToken, buildEnv };
    }
    remoteUrl(region, buildEnv) {
        const resolvedRegion = region ?? (this.options.region ?? getRuntimeRegion)();
        const resolvedBuildEnv = buildEnv ?? (this.options.buildEnv ?? getRuntimeBuildEnv)();
        return SKILL_HUB_BASE[resolvedRegion][resolvedBuildEnv];
    }
}
function normalizeItems(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return [];
        const record = raw;
        const name = readString(record['name']);
        if (!name)
            return [];
        const now = Date.now();
        return [
            {
                id: readOptionalNumber(record['id']) ?? 0,
                name,
                ...readLocalHubPresentation(record),
                description: readString(record['description']) ?? '',
                content: readString(record['content']) ?? '',
                source_url: readString(record['source_url']) ?? '',
                source_type: readOptionalNumber(record['source_type']) ?? USER_SOURCE_TYPE,
                added: record['added'] === true,
                ...readLocalTimes(record, now),
            },
        ];
    });
}
function normalizePublisherSourceType(value) {
    const sourceType = readOptionalNumber(value);
    return sourceType === OFFICIAL_SOURCE_TYPE || sourceType === USER_SOURCE_TYPE
        ? sourceType
        : undefined;
}
function normalizeRemoteSkillSortType(value) {
    if (value === 2 || value === 3)
        return value;
    return REMOTE_SKILL_SORT_TYPE_USE_COUNT;
}
function resolveRemotePublisherSourceType(remote) {
    if (remote.source_type !== undefined) {
        return normalizePublisherSourceType(remote.source_type);
    }
    return readOptionalNumber(remote.type) === 1 ? OFFICIAL_SOURCE_TYPE : USER_SOURCE_TYPE;
}
function mapRemoteSkillHubItem(remote) {
    const name = readString(remote.name);
    if (!name)
        return undefined;
    const now = Date.now();
    return {
        id: readOptionalNumber(remote.id) ?? 0,
        name,
        ...readRemoteHubPresentation(remote),
        description: readString(remote.description) ?? '',
        content: readString(remote.content) ?? readString(remote.prompt) ?? '',
        source_url: readString(remote.source_url) ?? readString(remote.additional_content_url) ?? '',
        // The cloud response is personalized for Web installs. Desktop owns a
        // separate local install state and computes it in queryRemote().
        added: false,
        ...readRemoteTimes(remote, now),
    };
}
function normalizeCreatorInfo(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    const userId = readFirstString(record, ['user_id', 'userId']);
    const userName = readFirstString(record, ['user_name', 'userName']);
    const avatarUrl = readFirstString(record, ['avatar_url', 'avatarUrl']);
    if (!userId && !userName && !avatarUrl)
        return undefined;
    return {
        ...(userId ? { user_id: userId } : {}),
        ...(userName ? { user_name: userName } : {}),
        ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
    };
}
function readString(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function readOptionalNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value !== 'string')
        return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function readNumberRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    return Object.fromEntries(Object.entries(value).filter((entry) => typeof entry[1] === 'number'));
}
function isHttpUrl(value) {
    return /^https?:\/\//iu.test(value);
}
function skillLocationUri(filePath) {
    return pathToFileURL(filePath).href.replace(/^file:/u, 'files:');
}
function validateAgentName(agentName) {
    if (agentName === undefined || AGENT_NAME_PATTERN.test(agentName))
        return;
    throw new LocalSkillHubInstallError(`Invalid agent name "${agentName}": must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens`, 'LOCAL_SKILL_HUB_INVALID_AGENT_NAME', 400);
}
function nextId(items) {
    return items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
}
function normalizeIdentity(value) {
    return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
function readFirstString(record, keys) {
    for (const key of keys) {
        const value = readString(record[key]);
        if (value !== undefined)
            return value;
    }
    return undefined;
}
function readInstallIdentity(body, skills) {
    const sourceUrl = readFirstString(body, ['url', 'skillRef', 'skill_ref', 'source_url']) ??
        'local-skill-hub://manual';
    const displayName = readFirstString(body, ['display_name', 'displayName', 'name']) ?? deriveSkillName(sourceUrl);
    const explicitName = readString(body.name);
    const agentName = readFirstString(body, ['agent_name', 'agentName']);
    validateAgentName(agentName);
    // Prefer the stable source URL before falling back to an explicitly requested name.
    const existing = skills.find((skill) => skill.source_url === sourceUrl) ??
        (explicitName ? skills.find((skill) => skill.name === explicitName) : undefined);
    return {
        sourceUrl,
        displayName,
        explicitName,
        agentName,
        existing,
        ...readInstallMetadata(body, existing),
    };
}
function readInstallMetadata(body, existing) {
    const creatorInfo = normalizeCreatorInfo(body.creator_info);
    const publisherSourceType = normalizePublisherSourceType(body.publisher_source_type ?? body.publisherSourceType) ??
        existing?.publisher_source_type;
    const resolvedCreatorInfo = creatorInfo && existing?.creator_info
        ? { ...existing.creator_info, ...creatorInfo }
        : (creatorInfo ?? existing?.creator_info);
    return { publisherSourceType, resolvedCreatorInfo };
}
function createInstalledItem(input) {
    const { body, file, existing, name, displayName, explicitContent, sourceUrl, publisherSourceType, resolvedCreatorInfo, now, } = input;
    return {
        id: existing?.id ?? nextId(file.skills),
        name,
        display_name: displayName,
        description: readString(body['description']) ??
            existing?.description ??
            `Installed local skill ${displayName}`,
        content: explicitContent ?? existing?.content ?? '',
        source_url: sourceUrl,
        source_type: USER_SOURCE_TYPE,
        ...(publisherSourceType !== undefined ? { publisher_source_type: publisherSourceType } : {}),
        ...(resolvedCreatorInfo ? { creator_info: resolvedCreatorInfo } : {}),
        added: true,
        created_at: existing?.created_at ?? now,
        updated_at: now,
    };
}
function projectRemoteHubResponse(payload, file) {
    // Detect "already added" by the installed identity OR the source URL. The
    // source-URL match keeps the market badge correct even if the remote hub's
    // `name` differs from the slug the skill was installed under (Meego
    // 7034556857).
    const installedSourceUrls = new Set(file.skills
        .filter((skill) => file.installed[skill.name] !== undefined)
        .map((skill) => skill.source_url)
        .filter((url) => url.length > 0));
    const skillList = (payload.skill_list ?? []).flatMap((item) => {
        const mapped = mapRemoteSkillHubItem(item);
        if (!mapped)
            return [];
        const added = file.installed[mapped.name] !== undefined ||
            (mapped.source_url ? installedSourceUrls.has(mapped.source_url) : false);
        return [{ ...mapped, added }];
    });
    return {
        skill_list: skillList,
        has_more: payload.has_more ?? false,
        next_token: readString(payload.next_cursor) ?? '',
    };
}
function buildRemoteQuery(baseUrl, input) {
    const requestUrl = new URL(baseUrl);
    requestUrl.searchParams.set('limit', String(input.limit && input.limit > 0 ? input.limit : 50));
    if (input.nextToken)
        requestUrl.searchParams.set('cursor', input.nextToken);
    requestUrl.searchParams.set('sort_type', String(normalizeRemoteSkillSortType(input.sortType)));
    if (input.sourceType !== undefined && input.sourceType !== SOURCE_TYPE_ALL) {
        requestUrl.searchParams.set('source_type', String(input.sourceType));
    }
    if (input.keyword?.trim())
        requestUrl.searchParams.set('keyword', input.keyword.trim());
    return requestUrl;
}
function readLocalHubPresentation(record) {
    const displayName = readString(record.display_name);
    const publisherSourceType = normalizePublisherSourceType(record.publisher_source_type);
    const useCount = readOptionalNumber(record.use_count);
    const creatorInfo = normalizeCreatorInfo(record.creator_info);
    return {
        ...(displayName ? { display_name: displayName } : {}),
        ...(publisherSourceType !== undefined ? { publisher_source_type: publisherSourceType } : {}),
        ...(useCount !== undefined ? { use_count: useCount } : {}),
        ...(creatorInfo ? { creator_info: creatorInfo } : {}),
    };
}
function readRemoteHubPresentation(remote) {
    const displayName = readString(remote.display_name);
    const useCount = readOptionalNumber(remote.use_count);
    const creatorInfo = normalizeCreatorInfo(remote.creator_info);
    const publisherSourceType = resolveRemotePublisherSourceType(remote);
    return {
        ...(displayName ? { display_name: displayName } : {}),
        ...(publisherSourceType !== undefined ? { source_type: publisherSourceType } : {}),
        ...(useCount !== undefined ? { use_count: useCount } : {}),
        ...(creatorInfo ? { creator_info: creatorInfo } : {}),
    };
}
function readRemoteTimes(remote, now) {
    return {
        created_at: readOptionalNumber(remote.created_at) ?? readOptionalNumber(remote.create_at) ?? now,
        updated_at: readOptionalNumber(remote.updated_at) ?? readOptionalNumber(remote.update_at) ?? now,
    };
}
function remoteHubRequestFailed(payload) {
    return Boolean(payload.base_resp && payload.base_resp.status_code !== 0);
}
function readLocalTimes(record, now) {
    return {
        created_at: readOptionalNumber(record.created_at) ?? now,
        updated_at: readOptionalNumber(record.updated_at) ?? now,
    };
}
//# sourceMappingURL=hub-api.js.map