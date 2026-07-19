import type { Octokit, RestEndpointMethodTypes } from "@octokit/rest";
import type { FetchedDocument } from "../../contract.ts";
import { writeDocumentBody } from "../../shared.ts";
import { listWithCap } from "./pagination.ts";
import { escapeTableCell, requestOptions } from "./shared.ts";
import type { ActionRunTarget, GitHubRepo } from "./urls.ts";

const ACTION_RUN_LIMIT = 100;
const JOB_LIMIT = 200;
const ARTIFACT_LIMIT = 100;

type WorkflowRun = RestEndpointMethodTypes["actions"]["getWorkflowRun"]["response"]["data"];
type WorkflowRunListItem =
  RestEndpointMethodTypes["actions"]["listWorkflowRunsForRepo"]["response"]["data"]["workflow_runs"][number];
type WorkflowJob =
  RestEndpointMethodTypes["actions"]["listJobsForWorkflowRun"]["response"]["data"]["jobs"][number];
type WorkflowArtifact =
  RestEndpointMethodTypes["actions"]["listWorkflowRunArtifacts"]["response"]["data"]["artifacts"][number];

export async function fetchActionRunList(
  octokit: Octokit,
  target: GitHubRepo & { url: string },
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  const response = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner: target.owner,
    repo: target.repo,
    per_page: ACTION_RUN_LIMIT,
    ...requestOptions(signal),
  });
  const runs = response.data.workflow_runs;
  const total = response.data.total_count;
  const truncated = total > runs.length;
  return {
    kind: "github.action_run_list",
    source: "github",
    url: target.url,
    title: `${target.owner}/${target.repo} Actions runs`,
    facts: [truncated ? `${total} runs, showing first ${runs.length}` : `${total} runs`],
    excerpt:
      runs.map((run) => `#${run.run_number} ${run.display_title || run.name}`).join("\n") ||
      undefined,
    bodies: [
      await writeDocumentBody(
        artifactDir,
        target.url,
        "listing.md",
        renderActionRunList(target, runs, truncated),
      ),
    ],
  };
}

export async function fetchActionRun(
  octokit: Octokit,
  target: ActionRunTarget,
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  const [runResponse, jobs, artifacts] = await Promise.all([
    octokit.rest.actions.getWorkflowRun({
      owner: target.owner,
      repo: target.repo,
      run_id: target.runId,
      ...requestOptions(signal),
    }),
    listWithCap(JOB_LIMIT, async (page, perPage) => {
      const response = await octokit.rest.actions.listJobsForWorkflowRun({
        owner: target.owner,
        repo: target.repo,
        run_id: target.runId,
        page,
        per_page: perPage,
        ...requestOptions(signal),
      });
      return response.data.jobs;
    }),
    listWithCap(ARTIFACT_LIMIT, async (page, perPage) => {
      const response = await octokit.rest.actions.listWorkflowRunArtifacts({
        owner: target.owner,
        repo: target.repo,
        run_id: target.runId,
        page,
        per_page: perPage,
        ...requestOptions(signal),
      });
      return response.data.artifacts;
    }),
  ]);
  const run = runResponse.data;
  const title = run.display_title || run.name || `Actions run ${run.id}`;

  return {
    kind: "github.action_run",
    source: "github",
    url: target.url,
    link: run.html_url,
    title: `${target.owner}/${target.repo} run #${run.run_number}: ${title}`,
    facts: [
      `${run.status}${run.conclusion ? ` (${run.conclusion})` : ""}`,
      ...(run.name ? [`workflow ${run.name}`] : []),
      `event ${run.event}`,
      ...(run.head_branch ? [`branch ${run.head_branch}`] : []),
      `${jobs.items.length} job${jobs.items.length === 1 ? "" : "s"}`,
      `${artifacts.items.length} artifact${artifacts.items.length === 1 ? "" : "s"}`,
      ...(jobs.truncated || artifacts.truncated ? ["some lists capped; see run.md"] : []),
    ],
    excerpt: run.head_commit?.message ?? run.display_title,
    bodies: [
      await writeDocumentBody(
        artifactDir,
        target.url,
        "run.md",
        renderActionRunMarkdown(
          run,
          jobs.items,
          jobs.truncated,
          artifacts.items,
          artifacts.truncated,
        ),
      ),
    ],
  };
}

function renderActionRunList(
  target: GitHubRepo,
  runs: WorkflowRunListItem[],
  truncated: boolean,
): string {
  const lines = [
    `# ${target.owner}/${target.repo} Actions runs`,
    "",
    "| Run | Title | Workflow | Status | Event | Branch | Actor | Started | URL |",
    "| ---: | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const run of runs) {
    lines.push(
      `| ${run.run_number} | ${escapeTableCell(run.display_title || "")} | ${escapeTableCell(run.name ?? "")} | ${run.status}${run.conclusion ? ` (${run.conclusion})` : ""} | ${run.event} | ${escapeTableCell(run.head_branch ?? "")} | ${escapeTableCell(run.actor?.login ?? "")} | ${run.run_started_at ?? run.created_at} | ${escapeTableCell(run.html_url)} |`,
    );
  }
  if (truncated) lines.push("", `[listing capped at ${ACTION_RUN_LIMIT} runs]`);
  return `${lines.join("\n")}\n`;
}

function renderActionRunMarkdown(
  run: WorkflowRun,
  jobs: WorkflowJob[],
  jobsTruncated: boolean,
  artifacts: WorkflowArtifact[],
  artifactsTruncated: boolean,
): string {
  const lines = [
    `# ${run.display_title || run.name || `Actions run ${run.id}`}`,
    "",
    `- Workflow: ${run.name ?? "unknown"}`,
    `- Run: #${run.run_number}, attempt ${run.run_attempt ?? 1}`,
    `- Status: ${run.status}${run.conclusion ? ` (${run.conclusion})` : ""}`,
    `- Event: ${run.event}`,
    `- Actor: ${run.actor?.login ?? "unknown"}`,
    `- Branch: ${run.head_branch ?? "unknown"}`,
    `- Commit: ${run.head_sha}`,
    `- Started: ${run.run_started_at ?? run.created_at}`,
    `- Updated: ${run.updated_at}`,
    `- URL: ${run.html_url}`,
    "",
    "## Jobs",
  ];

  if (jobs.length === 0) lines.push("", "(none)");
  for (const job of jobs) {
    lines.push(
      "",
      `### ${job.name}`,
      "",
      `- Status: ${job.status}${job.conclusion ? ` (${job.conclusion})` : ""}`,
      `- Runner: ${job.runner_name ?? "unknown"}`,
      `- Started: ${job.started_at}`,
      `- Completed: ${job.completed_at ?? "not completed"}`,
      `- URL: ${job.html_url ?? "unavailable"}`,
    );
    if (job.steps && job.steps.length > 0) {
      lines.push(
        "",
        "| Step | Status | Conclusion | Started | Completed |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const step of job.steps) {
        lines.push(
          `| ${escapeTableCell(step.name)} | ${step.status} | ${step.conclusion ?? ""} | ${step.started_at ?? ""} | ${step.completed_at ?? ""} |`,
        );
      }
    }
  }
  if (jobsTruncated) lines.push("", `[jobs capped at ${JOB_LIMIT}]`);

  lines.push("", "## Artifacts", "");
  if (artifacts.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(
      "| Name | Size | Expired | Created | Expires | Archive API URL |",
      "| --- | ---: | --- | --- | --- | --- |",
    );
    for (const artifact of artifacts) {
      lines.push(
        `| ${escapeTableCell(artifact.name)} | ${artifact.size_in_bytes} | ${artifact.expired ? "yes" : "no"} | ${artifact.created_at ?? ""} | ${artifact.expires_at ?? ""} | ${escapeTableCell(artifact.archive_download_url)} |`,
      );
    }
  }
  if (artifactsTruncated) lines.push("", `[artifacts capped at ${ARTIFACT_LIMIT}]`);
  return `${lines.join("\n")}\n`;
}
