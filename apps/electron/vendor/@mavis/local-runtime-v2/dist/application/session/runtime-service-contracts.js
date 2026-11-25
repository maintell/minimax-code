/**
 * The Runtime service contracts: the assembled surface, its construction options and the
 * owner shapes the composition passes between phases. Types only, so the composition root
 * and the owner initializers can both depend on them without an import cycle.
 */
import {} from './miniapp-launchpad-application.js';
import {} from './runtime-session-applications.js';
import * as ppt from './runtime-ppt-applications.js';
import {} from './runtime-model-access.js';
import {} from '../../service/skill/index.js';
import {} from '../../service/computer-use/index.js';
import {} from '@mavis/config';
import {} from '../conversation/index.js';
import { createRuntimeSkillReceipts, initializeRuntimeSandbox, } from './runtime-services-composition.js';
import { AgentApplication, ModelProviderApplication, } from '../index.js';
import {} from './goal-application.js';
import {} from '../../service/canvas/index.js';
import {} from './runtime-session-clio.js';
import {} from '../../service/channel-system/index.js';
import {} from '../../service/content-safety/index.js';
import {} from '../../service/cron/index.js';
import {} from './bunny-composition.js';
import { AgentFavorites } from '../../service/agent/index.js';
import {} from '../../service/prompt-config/index.js';
import {} from '../../service/llm-context-inspector/index.js';
import {} from '../../service/memory-system/index.js';
import {} from '../memory/memory-desktop-application.js';
import {} from '../../service/session-system/index.js';
import { initializePluginService, } from '../../service/plugin-system/index.js';
import { composeRuntimePluginExtension } from './plugin-extension-composition.js';
import {} from './runtime-miniapp-composition.js';
import {} from '../../service/mcp/index.js';
import {} from '../../service/miniapp/index.js';
import {} from '../../service/plan/index.js';
import {} from '../../service/turn-system/index.js';
import {} from '../../service/sandbox/index.js';
//# sourceMappingURL=runtime-service-contracts.js.map