import fs from 'node:fs';
import path from 'node:path';
const PROJECT_INSTRUCTIONS_FILENAME = 'AGENTS.md';
/** Detect the workspace's AGENTS.md instructions file. */
export function detectProjectInstructions(workspaceDir) {
    const agentsPath = path.join(workspaceDir, PROJECT_INSTRUCTIONS_FILENAME);
    try {
        fs.statSync(agentsPath);
        return PROJECT_INSTRUCTIONS_FILENAME;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=instructions.js.map