/**
 * Prompt builders for the Team Engine — pure string-building functions.
 *
 * These functions have no side effects and no access to stores or sessions.
 */
/** Build the prompt sent to a producing agent. */
export function buildTaskPrompt(task, ctx) {
    const p = [`## Task: ${task.title}`];
    if (task.description)
        p.push(task.description);
    // Include reject context for retries so the producer knows what to fix
    if (ctx.lastResult && ctx.lastResult.attempt > 0 && ctx.lastResult.verdict_summary) {
        p.push('', `## Previous Attempt Rejected (Attempt ${ctx.lastResult.attempt})`, '', 'Your previous submission was rejected. Reason:', ctx.lastResult.verdict_summary, '', 'You MUST address these issues. Do NOT resubmit the same work.', `If you need to redo work, remove ONLY this single file: ${ctx.deliverablePath}`, 'Never delete anything outside your task output directory.', `In particular, NEVER run \`rm -rf\`, \`rm -rf /*\`, or any shell glob that targets the workspace, repo root, home directory, or any sibling task's output.`);
    }
    p.push('', '## Instructions', task.prompt);
    if (task.output) {
        p.push('', '## Expected Output');
        if (task.output.description)
            p.push(task.output.description);
        if (task.output.files?.length)
            p.push('Files:', ...task.output.files.map((f) => `  - ${f}`));
    }
    p.push('', '## Plan Workspace', `All team members share this artifacts directory for intermediate files, reports, and handoffs:`, `  ${ctx.workspaceDir}`, '', `Your task output directory (for task-specific files):`, `  ${ctx.outputDir}`, '', '## Delivery Protocol', `When you have completed the task, you MUST write a deliverable file to:`, `  ${ctx.deliverablePath}`, '', 'The deliverable.md must contain:', '1. **Summary** — what you did in 2-3 sentences', '2. **Changed files** — list every file you created or modified', '3. **Notes** — anything the verifier should know', '', 'The engine uses this file to confirm your task is complete.', 'If this file does not exist when your session ends, the task will be marked incomplete and retried.');
    // Board contract — teach worker to write progress entries
    if (ctx.boardPath) {
        p.push('', '## Progress Board', '', 'You MUST append a progress entry to the board file after each meaningful sub-step.', '', 'How to update:', '1. Read the current board file content', '2. Append your new entry at the end', '3. Write the entire file back', '', `File path: ${ctx.boardPath}`, '', 'Entry format (append at end of file, separated by ---):', '```', '---', `[YYYY-MM-DD HH:mm:ss] ${ctx.agentName ?? '<your-agent-name>'} | ${ctx.taskId ?? '<task-id>'} | <status: in_progress|done|blocked>`, '<one or two sentences describing what you just completed and what you plan to do next>', '```', '', "You can also read the board file to see your teammates' progress.");
    }
    return p.join('\n');
}
/** Build the prompt sent to a verifier agent. */
export function buildVerificationPrompt(task, verifierAgent, ctx) {
    const p = [
        `## Verify: "${task.title}"`,
        '',
        '## File Locations',
        `Plan workspace (shared by all team members):`,
        `  ${ctx.workspaceDir}`,
        `Task output directory:`,
        `  ${ctx.outputDir}`,
        '',
    ];
    // Resolve per-verifier prompt: record lookup > string fallback > none
    let verifyPrompt;
    if (task.verify_prompt) {
        if (typeof task.verify_prompt === 'string') {
            verifyPrompt = task.verify_prompt;
        }
        else {
            verifyPrompt = task.verify_prompt[verifierAgent];
        }
    }
    if (verifyPrompt) {
        p.push('## Verification Instructions', verifyPrompt, '');
    }
    else {
        p.push('## Original Task', task.prompt, '');
    }
    if (task.output?.description)
        p.push('## Expected Output', task.output.description, '');
    if (ctx.deliverable) {
        p.push("## Producer's Deliverable", ctx.deliverable, '');
    }
    p.push('## Your Job', task.verify_prompt
        ? 'Follow the verification instructions above. Also check:'
        : 'The producer claims the above deliverable. Verify:', '1. Do the claimed changes actually exist in the workspace?', '2. Does the work match the task requirements?', '3. Is the quality acceptable?', '', '## Verdict', 'End your response with exactly one of:', '- VERDICT: PASS', '- VERDICT: FAIL', '', 'Alternatively, you may respond with a structured JSON verdict:', '```json', '{ "passed": true, "reason": "explanation", "issues": [] }', '```', 'The VERDICT keyword takes precedence if both are present.');
    return p.join('\n');
}
// ─── Verdict Parser ─────────────────────────────────────────────────
/**
 * Parse a verifier's response for VERDICT: PASS/FAIL.
 * @deprecated Use parseVerifierResponse from structured-response.ts instead.
 * That function uses keyword-first priority: checks VERDICT keyword first,
 * then falls back to structured JSON extraction.
 */
export function parseVerifierVerdict(content) {
    for (const line of content.split('\n').reverse()) {
        const up = line.trim().toUpperCase();
        if (up.includes('VERDICT: PASS') || up.includes('VERDICT:PASS'))
            return { passed: true, summary: content.slice(-500) };
        if (up.includes('VERDICT: FAIL') || up.includes('VERDICT:FAIL'))
            return { passed: false, summary: content.slice(-500) };
    }
    return { passed: false, summary: 'No explicit VERDICT found' };
}
// ─── Cycle Report Formatter ─────────────────────────────────────────
/** Format a CycleReport into a human-readable markdown string. */
export function formatCycleReport(report, isFinal) {
    const p = [
        isFinal
            ? `## Plan "${report.plan_name}" — Final Report`
            : `## Cycle ${report.cycle} — "${report.plan_name}"`,
        '',
        `Progress: ${report.tasks_done}/${report.total_tasks} done, ${report.tasks_remaining} remaining`,
    ];
    // ── Top-level failure warning banner ──────────────────────────────
    const failedProduction = report.failed_production ?? [];
    const verificationFailures = report.awaiting_verdict.filter((t) => t.verifier_results.some((v) => !v.passed));
    if (failedProduction.length > 0 || verificationFailures.length > 0) {
        p.push('', '---', '⚠️ **WARNING: FAILURES DETECTED — DO NOT submit plan_complete=true**', '');
        if (failedProduction.length > 0) {
            p.push(`**${failedProduction.length} task(s) failed production** (pending retry):`);
            for (const f of failedProduction) {
                p.push(`  - ${f.title}: ${f.reason ?? 'unknown'} (attempt ${f.attempt})`);
            }
        }
        if (verificationFailures.length > 0) {
            p.push(`**${verificationFailures.length} task(s) failed verification:**`);
            for (const t of verificationFailures) {
                const failed = t.verifier_results.filter((v) => !v.passed);
                p.push(`  - ${t.title}: ${failed.map((v) => `${v.agent} FAIL`).join(', ')}`);
            }
        }
        p.push('', 'Resolve ALL failures before marking plan complete.', '---');
    }
    if (report.awaiting_verdict.length) {
        p.push('', '### Awaiting Your Verdict');
        for (const a of report.awaiting_verdict) {
            p.push(`- **${a.title}** (${a.producer_agent}, attempt ${a.attempt})`);
            for (const v of a.verifier_results) {
                p.push(`  ${v.passed ? '✓' : '✗'} ${v.agent}: ${v.summary.slice(0, 200)}`);
            }
            if (a.deliverable)
                p.push(`  Deliverable: ${a.deliverable.slice(0, 300)}${a.deliverable.length > 300 ? '...' : ''}`);
        }
    }
    if (report.done.length) {
        p.push('', '### Done');
        for (const d of report.done)
            p.push(`- **${d.title}** (${d.producer_agent})`);
    }
    if (report.newly_ready.length) {
        p.push('', '### Newly Ready');
        for (const n of report.newly_ready)
            p.push(`- ${n.title}`);
    }
    if (report.failed_production.length) {
        p.push('', '### Failed Production (bounced back to ready)');
        for (const f of report.failed_production) {
            p.push(`- **${f.title}** (${f.producer_agent}, attempt ${f.attempt})${f.reason ? `: ${f.reason.slice(0, 200)}` : ''}`);
        }
    }
    if (report.blocked.length) {
        p.push('', '### Blocked');
        for (const b of report.blocked)
            p.push(`- ${b.title} (waiting: ${b.waiting_on.join(', ')})`);
    }
    if (report.board_blockers.length) {
        p.push('', '### Board Blockers');
        for (const b of report.board_blockers) {
            p.push(`- **${b.title}** (${b.task_id})`);
            for (const e of b.entries) {
                p.push(`  - ${e.filename}:`, `    ${e.content.split('\n').join('\n    ')}`);
            }
        }
    }
    if (!isFinal) {
        p.push('', '---', `Submit your decision with the \`team\` tool: command "decision", plan_id "${report.plan_id}".`, '', 'Use the `team` tool description for the full decision schema and examples.');
    }
    return p.join('\n');
}
//# sourceMappingURL=prompt-builder.js.map