import { pathToFileURL } from 'node:url';
import { AppError } from '../errors.js';
import { SkillScope, SkillSourceType } from '@mavis/thrift-gen/generated/desktop-service/types';
import { LocalSkillHubInstallError, } from '../../service/skill/index.js';
import { LocalSkillResolutionError } from '@mavis/shared/local-runtime-skills';
export async function listDesktopSkills(service, req) {
    return service.listSkills({
        limit: req.page?.limit,
        cursor: req.page?.cursor,
        scope: req.scope,
        sourceType: req.sourceType,
        keyword: req.keyword,
        excludeBuiltin: req.excludeBuiltin,
        agentName: req.agentName,
    });
}
export async function listDesktopSkillHub(service, req) {
    const resp = await mapHubErrors(() => service.listSkillHub({
        keyword: req.keyword,
        limit: req.page?.limit,
        cursor: req.page?.cursor,
        sourceType: req.sourceType,
        sortType: req.sortType,
    }));
    return {
        skillList: resp.skills.map(toDesktopSkillHubItem),
        hasMore: resp.hasMore,
        nextCursor: resp.nextCursor,
    };
}
export async function installDesktopSkill(service, req) {
    const resp = await mapHubErrors(() => service.installSkill({
        url: req.url,
        agentName: req.agentName,
        isFromGit: req.isFromGit,
        displayName: req.displayName,
        creatorInfo: req.creatorInfo,
        publisherSourceType: req.publisherSourceType,
    }));
    return { ok: readOptionalBoolean(resp.ok), skill: toDesktopSkillInfo(resp.skill) };
}
export async function previewDesktopSkill(service, req) {
    const resp = await mapHubErrors(() => service.previewSkill({ url: req.url, ref: req.ref }));
    return {
        candidates: resp.candidates.map((candidate) => ({
            subPath: candidate.sub_path,
            name: candidate.name,
            description: candidate.description,
            files: candidate.files,
            sizeBytes: candidate.size_bytes,
        })),
        repoInfo: {
            repoUrl: resp.repo_info.repo_url,
            sourceUrl: resp.repo_info.source_url,
            branch: resp.repo_info.branch,
            sha: resp.repo_info.sha,
            hintSubPath: resp.repo_info.hint_sub_path,
        },
    };
}
export async function createDesktopSkill(service, req) {
    const result = await service.createSkill({
        name: req.name,
        description: req.description,
        content: req.content,
        agentName: req.agentName,
    });
    if (!result.ok)
        throw skillHttpError(result.status, result.message, result.code);
    return { ok: true, skill: toDesktopSkillInfo(result.skill) };
}
export async function getDesktopSkill(service, req) {
    return mapSkillErrors(async () => (await service.getSkill({
        skillName: req.skillName,
        locationUri: normalizeNonEmptyString(req.locationUri),
        agentName: req.agentName,
    }, { includeBody: req.includeBody })) ?? {});
}
export async function listDesktopSkillFiles(service, req) {
    return mapSkillErrors(async () => {
        const files = await service.listSkillFiles({
            skillName: req.skillName,
            locationUri: normalizeNonEmptyString(req.locationUri),
            agentName: req.agentName,
        });
        if (!files)
            throw skillHttpError(404, `Skill not found: ${req.skillName}`, 'SKILL_NOT_FOUND');
        return { files };
    });
}
export async function getDesktopSkillFile(service, req) {
    return mapSkillErrors(async () => {
        const content = await service.readSkillFile({
            skillName: req.skillName,
            path: req.path,
            locationUri: normalizeNonEmptyString(req.locationUri),
            agentName: req.agentName,
        });
        if (content === undefined) {
            throw skillHttpError(404, `Skill file not found: ${req.skillName}`, 'SKILL_FILE_NOT_FOUND');
        }
        return { content };
    });
}
export async function deleteDesktopSkill(service, req) {
    const locationUri = normalizeNonEmptyString(req.locationUri);
    return mapSkillErrors(async () => {
        const deleted = await service.deleteSkill({
            skillName: req.skillName,
            ...(locationUri ? { locationUri } : {}),
            agentName: req.agentName,
        });
        if (deleted === 'protected') {
            throw skillHttpError(403, `Skill cannot be deleted: ${req.skillName}`, 'SKILL_PROTECTED');
        }
        if (!deleted) {
            throw skillHttpError(404, `Skill not found: ${req.skillName}`, 'SKILL_NOT_FOUND');
        }
        return deleted;
    });
}
function skillHttpError(status, message, code) {
    return new AppError(status, code, message);
}
async function mapSkillErrors(fn) {
    try {
        return await fn();
    }
    catch (err) {
        if (err instanceof LocalSkillResolutionError) {
            throw skillHttpError(err.status, err.message, err.code);
        }
        throw err;
    }
}
async function mapHubErrors(fn) {
    try {
        return await fn();
    }
    catch (err) {
        if (err instanceof LocalSkillHubInstallError) {
            throw skillHttpError(err.status, err.message, err.code);
        }
        throw err;
    }
}
function toDesktopSkillHubItem(item) {
    return {
        id: item.id,
        name: item.name,
        displayName: item.display_name,
        description: item.description,
        content: item.content,
        sourceUrl: item.source_url,
        sourceType: toSkillSourceType(item.source_type),
        useCount: item.use_count,
        creatorInfo: item.creator_info
            ? {
                userId: item.creator_info.user_id,
                userName: item.creator_info.user_name,
                avatarUrl: item.creator_info.avatar_url,
            }
            : undefined,
        added: item.added,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
    };
}
function toDesktopSkillInfo(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    const name = readOptionalString(record.name);
    if (!name)
        return undefined;
    return {
        name,
        displayName: readOptionalString(record.displayName) ?? readOptionalString(record.display_name),
        description: readOptionalString(record.description),
        scope: toSkillScope(readOptionalNumber(record.scope) ?? readOptionalNumber(record.scope_type)),
        ...readSkillProvenance(record),
        agentName: readOptionalString(record.agentName) ?? readOptionalString(record.agent_name),
        locationUri: readSkillLocationUri(record),
    };
}
function toDesktopCreatorInfo(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    const userId = readOptionalString(record.userId) ?? readOptionalString(record.user_id);
    const userName = readOptionalString(record.userName) ?? readOptionalString(record.user_name);
    const avatarUrl = readOptionalString(record.avatarUrl) ?? readOptionalString(record.avatar_url);
    if (!userId && !userName && !avatarUrl)
        return undefined;
    return { userId, userName, avatarUrl };
}
function toSkillScope(value) {
    if (value === SkillScope.AGENT)
        return SkillScope.AGENT;
    if (value === SkillScope.GLOBAL)
        return SkillScope.GLOBAL;
    return undefined;
}
function toSkillSourceType(value) {
    if (value === SkillSourceType.MINIMAX_OFFICIAL)
        return SkillSourceType.MINIMAX_OFFICIAL;
    if (value === SkillSourceType.USER_CONTRIBUTION)
        return SkillSourceType.USER_CONTRIBUTION;
    return undefined;
}
function locationUriFromPath(path) {
    return path ? pathToFileURL(path).href.replace(/^file:/u, 'files:') : undefined;
}
function readOptionalString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function readOptionalNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function readOptionalBoolean(value) {
    return typeof value === 'boolean' ? value : undefined;
}
function normalizeNonEmptyString(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function readSkillLocationUri(record) {
    return (readOptionalString(record.locationUri) ??
        readOptionalString(record.location_uri) ??
        locationUriFromPath(readOptionalString(record.location)));
}
function readSkillProvenance(record) {
    return {
        sourceType: toSkillSourceType(readOptionalNumber(record.sourceType) ?? readOptionalNumber(record.source_type)),
        publisherSourceType: toSkillSourceType(readOptionalNumber(record.publisherSourceType) ??
            readOptionalNumber(record.publisher_source_type)),
        creatorInfo: toDesktopCreatorInfo(record.creatorInfo ?? record.creator_info),
    };
}
//# sourceMappingURL=skill-management-application.js.map