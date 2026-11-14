/**
 * Disk layout of Bunny's memory directory. Code, prompts and the model work
 * directory use logical names (`MEMORY.md`, `forgotten.md`, `daily/YYYY-MM-DD.md`);
 * only the file store maps them to disk names:
 *
 * | logical               | disk                  |
 * |-----------------------|-----------------------|
 * | `MEMORY.md`           | `memory.md`           |
 * | `forgotten.md`        | `forgotten.md`        |
 * | `daily/YYYY-MM-DD.md` | `daily/YYYY/MM/DD.md` |
 *
 * `archived.md` beside them is not a memory file: it keeps the entries the main memory limit
 * moved out. No model, prompt or settings page reads it, and it does not stop a memory from
 * being written again.
 */
export const MAIN_MEMORY_DISK_NAME = 'memory.md';
/** Entries evicted from the main memory, appended with the time they left. */
export const ARCHIVE_DISK_NAME = 'archived.md';
/** The main memory file relative to Bunny's home, as the settings page lists it. */
export const BUNNY_MAIN_MEMORY_PATH = `memory/${MAIN_MEMORY_DISK_NAME}`;
const DISK_DAILY = /^daily\/(\d{4})\/(\d{2})\/(\d{2})\.md$/u;
const LOGICAL_DAILY = /^daily\/(\d{4})-(\d{2})-(\d{2})\.md$/u;
/** Disk name, relative to the memory root, that a logical memory file is written to. */
export function memoryDiskName(logical) {
    if (logical === 'MEMORY.md')
        return MAIN_MEMORY_DISK_NAME;
    const daily = LOGICAL_DAILY.exec(logical);
    if (daily)
        return `daily/${daily[1]}/${daily[2]}/${daily[3]}.md`;
    return logical;
}
/** Logical name of a disk path relative to the memory root, or undefined when it is not memory. */
export function memoryLogicalName(disk) {
    if (disk === MAIN_MEMORY_DISK_NAME)
        return 'MEMORY.md';
    if (disk === 'forgotten.md')
        return disk;
    const daily = DISK_DAILY.exec(disk);
    return daily ? `daily/${daily[1]}-${daily[2]}-${daily[3]}.md` : undefined;
}
/** Directories below the memory root that hold daily files. */
export function isDailyDirectory(disk) {
    return disk === 'daily' || /^daily\/\d{4}(?:\/\d{2})?$/u.test(disk);
}
//# sourceMappingURL=disk-layout.js.map