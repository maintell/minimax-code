import { createTurnVisibleTextMark, } from '@mavis/agent-core/pi-turn-runner';
import { assistantReplyProgress } from '../output/send-to-user-display-projection.js';
/**
 * One Turn's first visible assistant text, for
 * `pi_turn_first_visible_text_ms`. It watches what the Turn delivers after
 * output review and the send_to_user display projection: text that output
 * review held counts when it is released, and a delivered send_to_user
 * counts as the text it shows. The mark goes to every Pi attempt of the Turn,
 * whose metrics recorder reports it. Only a Turn timed from its acceptance
 * has a mark; once marked, the watch stops reading events.
 */
export class TurnVisibleTextWatch {
    mark;
    seen = false;
    constructor(timed) {
        this.mark = timed ? createTurnVisibleTextMark() : undefined;
    }
    /** The Pi runner input of each attempt. */
    runInput() {
        return this.mark ? { turnVisibleText: this.mark } : {};
    }
    /** `inner`, the Turn's delivery after output review, watched for the first visible text. */
    watch(inner) {
        const mark = this.mark;
        if (!mark)
            return inner;
        return {
            pushRuntime: (event) => {
                this.observe(mark, event);
                return inner.pushRuntime(event);
            },
            appendEvents: (events) => {
                for (const event of events)
                    this.observe(mark, event);
                return inner.appendEvents(events);
            },
        };
    }
    observe(mark, event) {
        if (this.seen || assistantReplyProgress(event) !== 'visible_text')
            return;
        this.seen = true;
        mark.mark();
    }
}
//# sourceMappingURL=turn-visible-text.js.map