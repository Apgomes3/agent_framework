import { Agent } from "../core/agent.js";
import { TaskBreakdownSchema } from "../core/types.js";
import inquirer from "inquirer";
import chalk from "chalk";
import type {
  AgentInput,
  AgentResult,
  AgentRole,
  Artifact,
  LLMMessage,
  LLMOptions,
  Stage,
} from "../core/types.js";
import { logger } from "../utils/logger.js";
import { getTechStack } from "../core/tech-stacks.js";

const SYSTEM_PROMPT = `You are a senior technical project manager and software architect. Your job is to take a high-level app description and produce:

1. **project-spec.md** — A refined requirements document with clear functional and non-functional requirements.
2. **task-breakdown** — A structured JSON task list with priorities, dependencies, and agent assignments.
3. **architecture-decision.md** — Tech stack choices, API structure, data model, component architecture.
4. **risk-assessment.md** — Identified risks and mitigations.

## Tech Stack
The tech stack for this project will be resolved at runtime. The user has selected a specific stack.
Plan tasks and architecture using the stack identified in the user message.
When the user doesn't specify, use the default.

## Task assignment rules
- "designer" — UI/UX tasks: wireframes, component tree, design tokens, page layouts
- "coder" — Implementation tasks: scaffolding, components, routes, API endpoints, state management, forms
- "qa" — Quality tasks: test writing, code review, security audit, accessibility check

## Output format
Return a **single** JSON object. Keep markdown string values concise (no excessive headings or bullet padding). The entire response must be valid, complete JSON:
{
  "projectName": "string",
  "projectSpec": "markdown string — key requirements only, max ~400 words",
  "architectureDecision": "markdown string — tech decisions, max ~300 words",
  "riskAssessment": "markdown string — top 5 risks with mitigations, max ~200 words",
  "taskBreakdown": {
    "projectName": "string",
    "tasks": [
      {
        "id": "task-001",
        "title": "string",
        "description": "brief description",
        "assignee": "designer" | "coder" | "qa",
        "priority": "critical" | "high" | "medium" | "low",
        "status": "pending",
        "dependencies": ["task-id"],
        "acceptanceCriteria": ["criterion"]
      }
    ]
  }
}`;

const INTERVIEW_PROMPT = `You are a senior technical project manager. Given a brief app description, generate 3-5 clarifying questions to ask the user BEFORE starting project planning.

Focus on questions that would significantly change the architecture or scope:
- Authentication/authorization requirements
- Data model assumptions (what entities, what relationships)
- Tech preference overrides (e.g., "use Next.js instead of Vite")
- Deployment target (SPA, SSR, desktop)
- Integration points (third-party APIs, databases)
- Scale expectations

Return JSON:
{
  "questions": [
    { "id": "q1", "question": "Do you need user authentication? If so, what type (email/password, OAuth, SSO)?", "default": "Email/password with JWT" },
    { "id": "q2", "question": "...", "default": "..." }
  ]
}

Do NOT ask trivial questions. Skip questions whose answers are obvious from the description.`;

export class OrchestratorAgent extends Agent {
  readonly role: AgentRole = "orchestrator";
  readonly stage: Stage = "orchestrate";
  private interviewEnabled = true;
  private cachedEnrichedDescription: string | null = null;

  /** Enable or disable the interactive interview phase */
  setInterviewMode(enabled: boolean): void {
    this.interviewEnabled = enabled;
  }

  /**
   * Override execute to optionally run an interview phase first.
   * Caches the enriched description so retries don't re-ask interview questions.
   */
  override async execute(input: AgentInput): Promise<AgentResult> {
    // Only interview on first run (no humanFeedback = not a retry)
    if (this.interviewEnabled && !input.humanFeedback) {
      if (this.cachedEnrichedDescription) {
        // Reuse answers from a previous interview (retry scenario)
        logger.info(`[${this.role}] Reusing cached interview answers from previous attempt`);
        const reusedInput = { ...input, projectDescription: this.cachedEnrichedDescription };
        return super.execute(reusedInput);
      }
      const enrichedInput = await this.runInterview(input);
      // Cache the enriched description for retries
      this.cachedEnrichedDescription = enrichedInput.projectDescription;
      return super.execute(enrichedInput);
    }
    return super.execute(input);
  }

  private async runInterview(input: AgentInput): Promise<AgentInput> {
    logger.info(`[${this.role}] Running user interview...`);

    const messages: LLMMessage[] = [
      { role: "system", content: INTERVIEW_PROMPT },
      { role: "user", content: `App description: ${input.projectDescription}` },
    ];

    let questions: Array<{ id: string; question: string; default: string }> = [];
    try {
      const response = await this.llmClient.chat(messages, {
        temperature: 0.5,
        maxTokens: 2048,
        responseFormat: "json",
      });
      const parsed = this.parseJSONFromLLM(response.content, "interview questions");
      questions = (parsed.questions as Array<{ id: string; question: string; default: string }>) ?? [];
    } catch (err) {
      logger.warn(`Interview question generation failed: ${err}`);
      return input;
    }

    if (questions.length === 0) return input;

    console.log(chalk.bold.cyan("\n━━━ Project Clarification Questions ━━━\n"));
    console.log(chalk.gray("Answer to refine the project plan. Press Enter to accept defaults.\n"));

    const answers: string[] = [];
    for (const q of questions) {
      const { answer } = await inquirer.prompt<{ answer: string }>([
        {
          type: "input",
          name: "answer",
          message: q.question,
          default: q.default,
        },
      ]);
      answers.push(`Q: ${q.question}\nA: ${answer}`);
    }

    // Enrich the project description with interview answers
    const enrichedDescription =
      input.projectDescription +
      "\n\n## User Clarifications\n" +
      answers.join("\n\n");

    console.log(chalk.green("\n✓ Interview complete — proceeding with planning\n"));

    return { ...input, projectDescription: enrichedDescription };
  }

  protected buildMessages(input: AgentInput): LLMMessage[] {
    const messages: LLMMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    const stack = getTechStack(input.context.techStackId);
    let userContent = `## Tech Stack: ${stack.name}\n\n`;
    userContent += `## App Description\n\n${input.projectDescription}`;

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
    return { temperature: 0.7, maxTokens: 16000, responseFormat: "json" };
  }

  protected async parseResponse(
    raw: string,
    _input: AgentInput
  ): Promise<AgentResult> {
    const json = this.parseJSONFromLLM(raw, "orchestrator plan");

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
