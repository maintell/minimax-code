import { getCategoryLogger } from "../../utils/logger";
/**
 * Category logger for the bridge. Optional filenamePrefix (for example a
 * binding id) splits files per device: remoteControl-<prefix>-YYYY-MM-DD.log.
 */
export function createRcAuditLogger(filenamePrefix) {
    const logger = getCategoryLogger('remoteControl', filenamePrefix);
    return {
        debug: (message) => logger.debug(message),
        info: (message) => logger.info(message),
        warn: (message) => logger.warn(message),
        error: (message) => logger.error(message),
    };
}
