/** Read-only discovery. One chart per turn, behind already queued document work. */
export class PptChartReadiness {
    constructor(editSessionId, openEpoch, check, publish) {
        this.editSessionId = editSessionId;
        this.check = check;
        this.publish = publish;
        this.checking = false;
        this.closed = false;
        this.priority = [];
        this.slides = new Map();
        this.slideIds = [];
        this.snapshot = { openEpoch, statusSeq: 0, documentRevision: 0, basic: 'ready', chartData: {} };
    }
    read() {
        return structuredClone(this.snapshot);
    }
    update(state) {
        this.snapshot.documentRevision = state.revision;
        const chartData = {};
        this.slides.clear();
        this.slideIds = state.slides.map((slide) => slide.id);
        for (const object of state.objects) {
            if (!object.chart)
                continue;
            const prior = this.snapshot.chartData[object.id];
            chartData[object.id] = {
                objectVersion: object.version,
                state: prior?.objectVersion === object.version && prior.state !== 'pending'
                    ? prior.state
                    : (object.chart.readiness ?? (object.chart.supported ? 'ready' : 'unsupported')),
            };
            this.slides.set(object.id, object.slideId);
        }
        this.snapshot.chartData = chartData;
        this.schedule();
    }
    prioritize(objectId, slideIndex) {
        const slideId = slideIndex === undefined ? undefined : this.slideIds[slideIndex];
        this.priority = [
            ...(objectId ? [objectId] : []),
            ...[...this.slides].filter(([, id]) => id === slideId).map(([id]) => id),
        ];
    }
    schedule() {
        if (this.closed ||
            this.checking ||
            this.timer ||
            !Object.values(this.snapshot.chartData).some((c) => c.state === 'pending'))
            return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.next();
        }, 0);
    }
    async next() {
        if (this.closed)
            return;
        const pending = Object.keys(this.snapshot.chartData).filter((id) => this.snapshot.chartData[id].state === 'pending');
        const objectId = this.priority.find((id) => pending.includes(id)) ?? pending[0];
        if (!objectId)
            return;
        const version = this.snapshot.chartData[objectId].objectVersion;
        this.checking = true;
        try {
            const result = await this.check(objectId, version);
            const current = this.snapshot.chartData[objectId];
            if (this.closed ||
                !current ||
                current.objectVersion !== result.objectVersion ||
                result.objectId !== objectId)
                return;
            current.state = result.state;
            this.snapshot.documentRevision = Math.max(this.snapshot.documentRevision, result.documentRevision);
            this.publish({
                kind: 'capability',
                editSessionId: this.editSessionId,
                openEpoch: this.snapshot.openEpoch,
                statusSeq: ++this.snapshot.statusSeq,
                documentRevision: result.documentRevision,
                objectId,
                objectVersion: version,
                capability: 'chart-data',
                state: result.state,
            });
        }
        catch (error) {
            // A stale version will be rescheduled by the next authoritative state.
            // Transport/host failures must not loop or claim an unsupported workbook.
            if (!(error instanceof Error &&
                ['conflict', 'scope_violation'].includes(error.message) &&
                this.snapshot.chartData[objectId]?.objectVersion !== version))
                this.closed = true;
        }
        finally {
            this.checking = false;
            this.schedule();
        }
    }
    dispose() {
        this.closed = true;
        clearTimeout(this.timer);
    }
}

