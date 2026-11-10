import { buildHostChannelWireInput, buildNoChannelCapabilityPort, } from '../../service/channel-system/index.js';
import { logger } from '../../infra/logging/logger.js';
/** Host 持有单一 Channel binding，外部 owner 完成装配后才绑定真实能力。 */
export class HostChannelRuntime {
    options;
    mode;
    port;
    constructor(options) {
        this.options = options;
        this.mode = options.channelComposition ?? 'internal';
        if (this.mode === 'internal') {
            this.port = buildNoChannelCapabilityPort({ agentName: options.agentName ?? 'mavis' });
            logger.info({ agentName: options.agentName ?? 'mavis', mode: 'internal' }, 'Channel subsystem not constructed: internal hosts have no IM capability (MR3)');
        }
        else {
            logger.info({ agentName: options.agentName ?? 'mavis', mode: 'external' }, 'Channel subsystem construction skipped: external composition owns it');
        }
    }
    bind(port) {
        if (this.mode !== 'external') {
            throw new Error('ASSEMBLY_ERROR: bindExternalChannelSubsystem requires channelComposition "external"');
        }
        if (this.port) {
            throw new Error('ASSEMBLY_ERROR: the external channel subsystem is already bound');
        }
        this.port = port;
        logger.info({ agentName: this.options.agentName ?? 'mavis', mode: 'external' }, 'External channel subsystem bound to the v1 host facade');
    }
    require(capability) {
        if (!this.port) {
            throw new Error(`ASSEMBLY_ERROR: the channel subsystem port is not bound (needed for ${capability}; mode=${this.mode})`);
        }
        return this.port;
    }
    buildWireInput(host) {
        return buildHostChannelWireInput(host, this.options);
    }
    createHostedCapabilities() {
        return {
            finalReplies: {
                deliver: (input) => this.require('hosted final replies').deliverReplyFromMessages({
                    ctx: input.channelContext,
                    messages: input.messages,
                    sessionId: input.sessionId,
                    ...(input.workspaceDir !== undefined ? { workspaceDir: input.workspaceDir } : {}),
                    ...(input.error !== undefined ? { error: input.error } : {}),
                }),
            },
            typing: {
                start: (input) => this.require('hosted typing').notifyTurnStart(input.channelContext),
                end: (input) => this.require('hosted typing').notifyTurnEnd(input.channelContext),
            },
        };
    }
}
//# sourceMappingURL=host-channel-runtime.js.map