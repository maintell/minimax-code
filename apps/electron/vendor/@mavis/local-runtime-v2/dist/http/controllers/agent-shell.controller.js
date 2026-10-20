import { AgentShellPreference, AgentShellFamily, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { AppError } from '../errors.js';
import { AgentShellControllerBase } from '../generated/agent-shell-controller-base.gen.js';
const preferences = {
    auto: AgentShellPreference.AUTO,
    powershell: AgentShellPreference.POWERSHELL,
    'git-bash': AgentShellPreference.GIT_BASH,
};
const families = {
    pwsh: AgentShellFamily.PWSH,
    'windows-powershell': AgentShellFamily.WINDOWS_POWERSHELL,
    'git-bash': AgentShellFamily.GIT_BASH,
};
export class AgentShellController extends AgentShellControllerBase {
    service;
    constructor(service) {
        super();
        this.service = service;
    }
    async getAgentShellStatus(_ctx, req) {
        return { status: toWire(await this.service.status(req.refresh)) };
    }
    async putAgentShellPreference(_ctx, req) {
        const preference = Object.entries(preferences).find(([, value]) => value === req.preference)?.[0];
        if (!preference)
            throw new AppError(400, 'AGENT_SHELL_CONFIG_INVALID', 'Unknown shell preference');
        return { status: toWire(await this.service.setPreference(preference)) };
    }
}
function toWire(status) {
    const candidate = (item) => ({
        ...item,
        family: families[item.family],
    });
    return {
        supported: status.supported,
        preference: preferences[status.preference],
        candidates: status.candidates.map(candidate),
        ...(status.effective ? { effective: candidate(status.effective) } : {}),
    };
}
//# sourceMappingURL=agent-shell.controller.js.map