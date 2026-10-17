import { PinnedItemType, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { AppError } from '../errors.js';
import { publishBestEffort } from '../events.js';
import { toProjectDetail } from '../project/wire.js';
import { toSessionInfoView } from './wire.js';
import { PinService, PinServiceError } from '../../service/pin/index.js';
export class PinApplication {
    options;
    constructor(options) {
        this.options = options;
    }
    async pinAgent(_context, req) {
        try {
            const result = await this.options.service.pinAgent(req.name, req.pinned, req.insertIndex);
            return {
                success: true,
                ...(result.item ? { item: toPinnedItem(result.item) } : {}),
                items: result.items.map(toPinnedItem),
            };
        }
        catch (error) {
            throw mapPinError(error);
        }
    }
    async pinSession(_context, req) {
        try {
            const result = await this.options.service.pinSession(req.sessionId, req.pinned, req.insertIndex);
            // The mobile RC command reaches this v2 application directly. Publish
            // the committed mutation so the desktop renderer's EventBus can refresh
            // its authoritative pinned-items-order snapshot without a manual reload.
            publishBestEffort(this.options.publishGlobalEvent, {
                type: 'session.pinned_updated',
                payload: {
                    sessionId: req.sessionId,
                    pinned: req.pinned,
                    ...(result.item?.session?.agentName
                        ? { agentName: result.item.session.agentName }
                        : {}),
                },
            });
            return {
                success: true,
                ...(result.item ? { item: toPinnedItem(result.item) } : {}),
                items: result.items.map(toPinnedItem),
            };
        }
        catch (error) {
            throw mapPinError(error);
        }
    }
    async getPinnedItemsOrder(_context, _req) {
        try {
            return { items: (await this.options.service.getOrder()).map(toPinnedItem) };
        }
        catch (error) {
            throw mapPinError(error);
        }
    }
    async putPinnedItemsOrder(_context, req) {
        try {
            return {
                items: (await this.options.service.putOrder((req.items ?? []).map(fromPinnedItemRef))).map(toPinnedItem),
            };
        }
        catch (error) {
            throw mapPinError(error);
        }
    }
}
function fromPinnedItemRef(ref) {
    switch (ref.itemType) {
        case PinnedItemType.Agent:
            return { type: 'agent', id: ref.id };
        case PinnedItemType.Session:
            return { type: 'session', id: ref.id };
        case PinnedItemType.Project:
            return { type: 'project', id: ref.id };
        default:
            throw new PinServiceError('invalid-ref', `Unsupported pinned item type: ${String(ref.itemType)}`);
    }
}
function toPinnedItem(item) {
    const base = {
        itemType: toPinnedItemType(item.ref.type),
        id: item.ref.id,
    };
    if (item.agent) {
        return {
            ...base,
            agent: {
                name: item.agent.agentName,
                ...(item.agent.displayName ? { displayName: item.agent.displayName } : {}),
                ...(item.agent.rootSessionId ? { rootSessionId: item.agent.rootSessionId } : {}),
                ...(item.agent.defaultWorkspaceDir
                    ? { defaultWorkspaceDir: item.agent.defaultWorkspaceDir }
                    : {}),
            },
        };
    }
    if (item.session)
        return { ...base, session: toSessionInfoView(item.session) };
    if (item.project) {
        return { ...base, desktopProject: toProjectDetail(item.project, item.project.sessionCount) };
    }
    return base;
}
function toPinnedItemType(type) {
    switch (type) {
        case 'agent':
            return PinnedItemType.Agent;
        case 'session':
            return PinnedItemType.Session;
        case 'project':
            return PinnedItemType.Project;
    }
}
function mapPinError(error) {
    if (!(error instanceof PinServiceError))
        return error;
    switch (error.reason) {
        case 'agent-not-found':
            return new AppError(404, 'AGENT_NOT_FOUND', error.message);
        case 'session-not-found':
            return new AppError(404, 'SESSION_NOT_FOUND', error.message);
        case 'duplicate-ref':
        case 'invalid-ref':
            return new AppError(400, 'INVALID_PINNED_ITEMS', error.message);
    }
}
//# sourceMappingURL=pin-application.js.map