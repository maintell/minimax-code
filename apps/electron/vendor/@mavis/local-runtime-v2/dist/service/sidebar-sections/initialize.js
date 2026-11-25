import { SidebarSectionsService } from './sidebar-sections.service.js';
/**
 * One sections owner per data directory. It is created once by the sidebar
 * tools owner so every Turn shares the same serialized write lane.
 */
export function initializeSidebarSections(options) {
    return new SidebarSectionsService(options);
}
//# sourceMappingURL=initialize.js.map