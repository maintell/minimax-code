/**
 * Current display work areas, shared by the main-window and MiniApp
 * popup-window position memory. Isolated in its own file because `bounds.ts`
 * deliberately avoids importing `electron` (see that file's header) to stay
 * unit-testable with plain data.
 */
import { screen } from "electron";
import logger from "../../utils/logger";
export function currentWorkAreas() {
    try {
        return screen.getAllDisplays().map((display) => display.workArea);
    }
    catch (error) {
        // screen 仅在 app ready 之后可用；拿不到显示器信息时回落到默认尺寸。
        logger.warn(`[WindowState] Failed to read displays: ${String(error)}`);
        return [];
    }
}
