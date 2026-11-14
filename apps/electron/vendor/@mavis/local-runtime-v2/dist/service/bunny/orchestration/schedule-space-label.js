import { deletedScheduleSpace, scheduleSpacePrefix } from '../../coordinator-text/index.js';
/** First prompt line that ties a Bunny schedule to one of its task spaces (agent-tools writes it). */
const SPACE_MARKER = /^<!-- bunny-space:([A-Za-z0-9_-]+) -->\r?\n/;
/**
 * The text a Bunny schedule wakes the main conversation with: a stored space marker becomes the
 * space's current name. The spaces are read only when the text carries a marker.
 */
export function renderScheduleSpaceLabel(text, spaces) {
    const marker = SPACE_MARKER.exec(text);
    if (!marker)
        return text;
    const space = spaces().find((candidate) => candidate.id === marker[1]);
    // A deleted space must not surface its raw id as if it were a name.
    const label = space ? space.name.replace(/[\r\n]+/g, ' ') : deletedScheduleSpace(marker[1]);
    return `${scheduleSpacePrefix(label)}${text.slice(marker[0].length)}`;
}
//# sourceMappingURL=schedule-space-label.js.map