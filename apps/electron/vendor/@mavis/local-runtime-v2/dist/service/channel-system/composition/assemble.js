/**
 * Full channel-subsystem assembly for the production owner (MR2).
 *
 * `assembleChannelSystemOwner` is the single production entrypoint: it
 * builds every store / adapter / runner via `wireChannelSubsystem`, derives
 * the product transport (typing + terminal replies) from the v2 runner — no
 * v1 transport object is involved — and exposes the host facade port that
 * the composition binds into the v1 shell. The delivery-only
 * `initializeOptionalChannelSystem` stays for focused tests that exercise
 * the turn-lifecycle observers with a fake transport.
 */
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { initializeOptionalChannelSystem } from '../initialize.js';
import { channelContextFromMessageContext } from '../interaction/channel-context.js';
import { buildChannelLegacyHttpSurface, } from '../delivery/legacy-http/surface.js';
import { wireChannelSubsystem } from './wire.js';
import { buildHostChannelFacadePort } from './host-facade.js';
export function assembleChannelSystemOwner(options) {
    if (options.wire.deferChannelStartup !== true) {
        // Loud assembly error: the v2 owner's startup MUST be triggered by the
        // runtime milestone (builtin agent definitions ready), never by
        // construction — a construction-time start would race Session/Agent
        // service readiness (plan §5.3).
        throw new Error('ASSEMBLY_ERROR: the v2 channel owner requires deferChannelStartup=true');
    }
    const wired = wireChannelSubsystem(options.wire);
    logger.info({ agentName: options.wire.agentName, stage: 'channel_assembly' }, 'v2 channel subsystem assembled (construction only; transports deferred)');
    // Single legacy HTTP surface (front-door mount + port delegation share it,
    // so interactive onboarding state exists exactly once).
    const { surface: legacyHttp } = buildChannelLegacyHttpSurface({
        subsystem: wired,
        wire: options.wire,
        ...(options.feishuOnboardFetch ? { feishuOnboardFetch: options.feishuOnboardFetch } : {}),
    });
    const hostFacadePort = buildHostChannelFacadePort({
        subsystem: wired,
        wire: options.wire,
    });
    // Product transport derives from the v2 runner — the same instances the
    // inbound path uses, so permission cards, questionnaires, typing and the
    // terminal reply all land on one owner (§6.4/§6.5 single-instance rule).
    const owner = initializeOptionalChannelSystem(true, {
        messages: options.messages,
        sessions: options.sessions,
        product: {
            typing: {
                start: async (input) => {
                    await wired.channelRunner.notifyTurnStart(channelContextFromMessageContext(input.channelContext));
                },
                end: async (input) => {
                    await wired.channelRunner.notifyTurnEnd(channelContextFromMessageContext(input.channelContext));
                },
            },
            finalReplies: {
                deliver: async (input) => {
                    await wired.channelRunner.deliverReplyFromMessages({
                        ctx: channelContextFromMessageContext(input.channelContext),
                        messages: input.messages,
                        sessionId: input.sessionId,
                        ...(input.workspaceDir !== undefined ? { workspaceDir: input.workspaceDir } : {}),
                        ...(input.error !== undefined ? { error: input.error } : {}),
                    });
                },
            },
        },
    });
    if (!owner)
        throw new Error('ASSEMBLY_ERROR: channel owner initialization returned nothing');
    // §5.4 shutdown race guard: once shutdown begins, a late startup trigger
    // (runtime milestone callback, detached restore, agent-ready waiter) must
    // never start transports again. One profile has exactly one channel owner,
    // and BOTH lifecycle entrances — the runtime milestone via the v1 facade
    // port and the v2 services close path — share this single gate.
    let closed = false;
    const guardedStart = () => {
        if (closed) {
            logger.warn({ agentName: options.wire.agentName, stage: 'channel_startup' }, 'Channel startup ignored: owner already shut down (late milestone/restore callback)');
            return Promise.resolve();
        }
        return wired.startChannelSubsystem();
    };
    const guardedShutdown = async () => {
        if (closed) {
            logger.info({ agentName: options.wire.agentName, stage: 'channel_shutdown' }, 'Channel shutdown repeated: already closed (idempotent no-op)');
            return;
        }
        closed = true;
        await hostFacadePort.shutdownChannelSubsystem();
    };
    const guardedFacadePort = {
        ...hostFacadePort,
        startChannelSubsystem: guardedStart,
        shutdownChannelSubsystem: guardedShutdown,
    };
    return {
        ...owner,
        subsystem: {
            wired,
            hostFacadePort: guardedFacadePort,
            start: guardedStart,
            shutdown: guardedShutdown,
        },
        legacyHttp,
    };
}
//# sourceMappingURL=assemble.js.map