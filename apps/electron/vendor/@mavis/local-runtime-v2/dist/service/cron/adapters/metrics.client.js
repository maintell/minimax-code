export function createCronMetrics(client) {
    return new ClientCronMetrics(client);
}
class ClientCronMetrics {
    client;
    constructor(client) {
        this.client = client;
    }
    engineStarted() {
        this.report(() => this.client?.counter('cron_engine_started_total'));
    }
    taskCreated(task, source) {
        this.reportMutation('cron_task_created_total', task, source);
    }
    taskUpdated(task, source) {
        this.reportMutation('cron_task_updated_total', task, source);
    }
    taskDeleted(task, source) {
        this.reportMutation('cron_task_deleted_total', task, source);
    }
    taskTriggered(task, source, outcome) {
        this.report(() => this.client?.counter('cron_task_triggered_total', 1, {
            trigger_source: source,
            trigger_outcome: outcome,
            ...taskLabels(task),
        }));
    }
    taskExecuted(agentName, result, durationMs) {
        const labels = { result, agent_name: agentName };
        this.report(() => this.client?.counter('cron_task_executed_total', 1, labels));
        this.report(() => this.client?.histogram('cron_task_execution_duration_ms', Math.max(0, durationMs), {
            agent_name: agentName,
        }));
    }
    taskFailed(agentName, errorCode) {
        this.report(() => this.client?.counter('cron_task_execution_failure_total', 1, {
            error_code: errorCode,
            agent_name: agentName,
        }));
    }
    reportMutation(name, task, source) {
        this.report(() => this.client?.counter(name, 1, {
            mutation_source: source,
            ...taskLabels(task),
        }));
    }
    report(operation) {
        try {
            operation();
        }
        catch {
            // Metrics remain observational and cannot change Cron behavior.
        }
    }
}
function taskLabels(task) {
    return {
        owner_agent: task.agentName,
        schedule_type: task.schedule.kind === 'once' ? 'once' : 'cron',
        delivery_target: task.sessionTarget.mode === 'new' ? 'new' : 'session_id',
    };
}
//# sourceMappingURL=metrics.client.js.map