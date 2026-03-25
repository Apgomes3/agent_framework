import { Agent } from "../core/agent.js";
import { TaskBreakdownSchema } from "../core/types.js";
import type {
  AgentInput,
  AgentResult,
  AgentRole,
  Artifact,
  LLMMessage,
  LLMOptions,
  Stage,
} from "../core/types.js";

const SYSTEM_PROMPT = `You are a senior technical project manager and software architect. Your job is to take a high-level app description and produce:

1. **project-spec.md** — A refined requirements document with clear functional and non-functional requirements.
2. **task-breakdown** — A structured JSON task list with priorities, dependencies, and agent assignments.
3. **architecture-decision.md** — Tech stack choices, API structure, data model, component architecture.
4. **risk-assessment.md** — Identified risks and mitigations.

## Tech Stack (default for generated apps)
- Frontend: React 19, TypeScript, Vite, Fluent UI (@fluentui/react-components), Zustand (state), React Hook Form + Zod (forms), TanStack Query (data fetching), React Router DOM
- Styling: CSS Modules or Tailwind CSS
- Testing: Vitest (unit), Playwright (e2e)
- API: Express.js or Fastify with TypeScript, Zod validation

## Task assignment rules
- "designer" — UI/UX tasks: wireframes, component tree, design tokens, page layouts
- "coder" — Implementation tasks: scaffolding, components, routes, API endpoints, state management, forms
- "qa" — Quality tasks: test writing, code review, security audit, accessibility check

## Output format
Return a JSON object with this exact structure:
{
  "projectName": "string",
  "projectSpec": "markdown string — full requirements doc",
  "architectureDecision": "markdown string — tech decisions doc",
  "riskAssessment": "markdown string — risks doc",
  "taskBreakdown": {
    "projectName": "string",
    "tasks": [
      {
        "id": "task-001",
        "title": "string",
        "description": "detailed description",
        "assignee": "designer" | "coder" | "qa",
        "priority": "critical" | "high" | "medium" | "low",
        "status": "pending",
        "dependencies": ["task-id"],
        "acceptanceCriteria": ["criterion"]
      }
    ]
  }
}`;

export class OrchestratorAgent extends Agent {
  readonly role: AgentRole = "orchestrator";
  readonly stage: Stage = "orchestrate";

  protected buildMessages(input: AgentInput): LLMMessage[] {
    const messages: LLMMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    let userContent = `## App Description\n\n${input.projectDescription}`;

    if (input.humanFeedback) {
      userContent += `\n\n## Feedback from Review\n\nPlease incorporate this feedback:\n${input.humanFeedback}`;
    }

    if (input.previousResults.length > 0) {
      userContent += `\n\n## Previous Context\n\n`;
      for (const prev of input.previousResults) {
        userContent += `### ${prev.agent} (${prev.stage})\n${prev.summary}\n\n`;
      }
    }

    messages.push({ role: "user", content: userContent });
    return messages;
  }

  protected getLLMOptions(): LLMOptions {
    return { temperature: 0.7, maxTokens: 8192, responseFormat: "json" };
  }

  protected async parseResponse(
    raw: string,
    _input: AgentInput
  ): Promise<AgentResult> {
    const json = JSON.parse(this.extractJSON(raw));

    // Validate task breakdown with Zod
    const taskBreakdown = TaskBreakdownSchema.parse(json.taskBreakdown);

    const artifacts: Artifact[] = [
      {
        type: "file",
        path: "docs/project-spec.md",
        content: json.projectSpec,
        description: "Refined requirements document",
      },
      {
        type: "file",
        path: "docs/architecture-decision.md",
        content: json.architectureDecision,
        description: "Architecture and tech stack decisions",
      },
      {
        type: "file",
        path: "docs/risk-assessment.md",
        content: json.riskAssessment,
        description: "Risk assessment and mitigations",
      },
      {
        type: "file",
        path: "docs/task-breakdown.json",
        content: JSON.stringify(taskBreakdown, null, 2),
        description: "Structured task breakdown",
      },
    ];

    return {
      agent: this.role,
      stage: this.stage,
      status: "success",
      artifacts,
      summary: `Decomposed "${taskBreakdown.projectName}" into ${taskBreakdown.tasks.length} tasks`,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      timestamp: new Date().toISOString(),
    };
  }
}
