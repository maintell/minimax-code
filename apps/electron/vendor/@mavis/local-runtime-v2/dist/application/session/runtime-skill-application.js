import * as managementApplication from './skill-management-application.js';
/** Cross-domain Desktop application for the existing Runtime Skill roster surface. */
export class RuntimeSkillApplication {
    options;
    nowMs;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    listSkills(req) {
        return managementApplication.listDesktopSkills(this.options.management, req);
    }
    listSkillHub(req) {
        return managementApplication.listDesktopSkillHub(this.options.management, req);
    }
    installSkill(req) {
        return managementApplication.installDesktopSkill(this.options.management, req);
    }
    previewSkill(req) {
        return managementApplication.previewDesktopSkill(this.options.management, req);
    }
    createSkill(req) {
        return managementApplication.createDesktopSkill(this.options.management, req);
    }
    getSkill(req) {
        return managementApplication.getDesktopSkill(this.options.management, req);
    }
    listSkillFiles(req) {
        return managementApplication.listDesktopSkillFiles(this.options.management, req);
    }
    getSkillFile(req) {
        return managementApplication.getDesktopSkillFile(this.options.management, req);
    }
    deleteSkill(req) {
        return managementApplication.deleteDesktopSkill(this.options.management, req);
    }
    setSkillEnabled(input, enabled) {
        return this.options.standalone.setSkillEnabled(input, enabled);
    }
    async listRuntimeSkills(req) {
        const scope = await this.resolveScope(req);
        if (!scope)
            return { skills: [], refreshedAt: this.nowMs() };
        if (req.includePluginSkills !== true) {
            return this.options.standalone.listRuntimeSkills(scope);
        }
        const [standaloneResult, pluginResult] = await Promise.allSettled([
            this.options.standalone.listRuntimeSkills(scope),
            this.options.plugins.listEnabledPluginSkillSummaries(),
        ]);
        if (standaloneResult.status === 'rejected' && pluginResult.status === 'rejected') {
            throw standaloneResult.reason;
        }
        const standalone = standaloneResult.status === 'fulfilled'
            ? standaloneResult.value
            : { skills: [], refreshedAt: this.nowMs() };
        const pluginSkills = pluginResult.status === 'fulfilled' ? pluginResult.value : [];
        return {
            ...standalone,
            skills: mergeRuntimeSkills(standalone.skills, pluginSkills),
        };
    }
    async resolveScope(req) {
        const requestedAgentRef = normalizeNonEmptyString(req.agentName);
        const requestedSessionId = normalizeNonEmptyString(req.sessionId);
        const requestedWorkspaceDir = normalizeNonEmptyString(req.workspaceDir);
        let compatibleAgentNames;
        try {
            compatibleAgentNames = requestedAgentRef
                ? (await this.options.agents.resolveAgentReadScope(requestedAgentRef)).compatibleNames
                : undefined;
        }
        catch {
            return null;
        }
        if (!requestedSessionId) {
            return { agentName: requestedAgentRef, workspaceDir: requestedWorkspaceDir };
        }
        let session;
        try {
            session = await this.options.sessions.find(requestedSessionId);
        }
        catch {
            session = undefined;
        }
        if (!session || (compatibleAgentNames && !compatibleAgentNames.includes(session.agentName))) {
            return null;
        }
        return {
            // Keep explicit agent:<name> reads exact in the Skill resource resolver;
            // bare primary aliases use the same trusted family as ordinary Agent reads.
            agentName: requestedAgentRef ?? session.agentName,
            workspaceDir: normalizeNonEmptyString(session.workspaceDir) ?? requestedWorkspaceDir,
        };
    }
}
export function createRuntimeSkillApplication(pluginSystem, sessions, agents, options) {
    return new RuntimeSkillApplication({
        agents,
        ...options,
        standalone: pluginSystem.skill,
        plugins: pluginSystem.plugin,
        sessions,
    });
}
function mergeRuntimeSkills(standalone, plugins) {
    const seen = new Set(standalone.map((skill) => normalizedName(skill.name)));
    const appended = [...plugins]
        .sort((left, right) => left.runtimeName.localeCompare(right.runtimeName))
        .flatMap((skill) => {
        const name = skill.runtimeName.trim();
        const key = normalizedName(name);
        if (!name || seen.has(key))
            return [];
        seen.add(key);
        const description = skill.description?.trim() ?? '';
        return [
            {
                name,
                displayName: skill.skillDisplayName?.trim() || name,
                description,
                displayDescription: description,
                sourceKind: 'plugin',
                enabled: true,
            },
        ];
    });
    return [...standalone, ...appended];
}
function normalizeNonEmptyString(value) {
    const normalized = value?.trim();
    return normalized || undefined;
}
function normalizedName(value) {
    return value.trim().toLowerCase();
}
//# sourceMappingURL=runtime-skill-application.js.map