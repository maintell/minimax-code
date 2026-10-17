export class LocalSkillResolutionError extends Error {
    status;
    code;
    details;
    constructor(status, message, code, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
        this.name = 'LocalSkillResolutionError';
    }
}
export function createDeferredSkillRuntimeCapability() {
    let current;
    const requireOwner = () => {
        if (!current)
            throw new Error('Skill runtime is not initialized or has been closed');
        return current;
    };
    return {
        capability: {
            registry: {
                listSkills: (...args) => requireOwner().registry.listSkills(...args),
                listRuntimeSkills: (...args) => requireOwner().registry.listRuntimeSkills(...args),
                renderCatalog: (...args) => requireOwner().registry.renderCatalog(...args),
                readSkillByName: (...args) => requireOwner().registry.readSkillByName(...args),
                getSkillDetail: (...args) => requireOwner().registry.getSkillDetail(...args),
                listSkillFiles: (...args) => requireOwner().registry.listSkillFiles(...args),
                readSkillFile: (...args) => requireOwner().registry.readSkillFile(...args),
                deleteSkill: (...args) => requireOwner().registry.deleteSkill(...args),
                setSkillEnabled: (...args) => requireOwner().registry.setSkillEnabled(...args),
                refresh: (...args) => requireOwner().registry.refresh(...args),
            },
            listRuntimeSkills: (...args) => requireOwner().listRuntimeSkills(...args),
            renderCatalog: (...args) => requireOwner().renderCatalog(...args),
            readSkillByName: (...args) => requireOwner().readSkillByName(...args),
            setSkillEnabled: (...args) => requireOwner().setSkillEnabled(...args),
            hasBuiltinSkill: (...args) => requireOwner().hasBuiltinSkill(...args),
            onDidChangeRuntimeSkills: (...args) => requireOwner().onDidChangeRuntimeSkills(...args),
            notifyRuntimeSkillsChanged: (...args) => requireOwner().notifyRuntimeSkillsChanged(...args),
            withRegistry: (action) => requireOwner().withRegistry(action),
            resolveBuiltinSkillNames: (...args) => requireOwner().resolveBuiltinSkillNames(...args),
            readNativeSkill: (...args) => requireOwner().readNativeSkill(...args),
            listHostedRuntimeSkills: (...args) => requireOwner().listHostedRuntimeSkills(...args),
            renderHostedCatalog: (...args) => requireOwner().renderHostedCatalog(...args),
        },
        bind: (value) => {
            if (current)
                throw new Error('Skill runtime is already bound');
            current = value;
            return () => {
                if (current === value)
                    current = undefined;
            };
        },
    };
}
//# sourceMappingURL=local-runtime-skills.js.map