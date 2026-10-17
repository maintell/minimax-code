import { randomUUID } from 'node:crypto';
import { parseArchiveTitleVerdict } from './archived-root-title.js';
import { RootArchiveTitleModelError, } from './root-archive-title-model.js';
import { completeTitleModel, TitleModelCompletionError, } from '../title/title-model-completion.js';
const CONFIG_FIELD_SAFETY_SCENE = 205;
/** Transport-neutral archive-title adapter; production model wiring stays outside the domain. */
export class ArchiveTitleModelAdapter {
    options;
    nowMs;
    makeTurnId;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
        this.makeTurnId = options.makeTurnId ?? (() => `turn_archive_title_${randomUUID()}`);
    }
    async summarize(input) {
        const turnId = this.makeTurnId();
        let raw;
        try {
            raw = await completeTitleModel({
                buildAgentConfig: this.options.buildAgentConfig,
                resolveModel: this.options.resolveModel,
                stream: this.options.stream,
                nowMs: this.nowMs,
            }, { ...input, turnId });
        }
        catch (error) {
            if (!(error instanceof TitleModelCompletionError))
                throw error;
            throw new RootArchiveTitleModelError('model', error.message, error);
        }
        const title = raw ? parseArchiveTitleVerdict(raw) : null;
        if (!title)
            return null;
        return this.reviewTitle(title);
    }
    async reviewTitle(title) {
        let verdict;
        try {
            verdict = await this.options.review(title, CONFIG_FIELD_SAFETY_SCENE);
        }
        catch (error) {
            throw new RootArchiveTitleModelError('review', error instanceof Error ? error.message : String(error), error);
        }
        return !verdict.pass && verdict.errorKind !== 'api_error' ? null : title;
    }
}
//# sourceMappingURL=archive-title-model-adapter.js.map