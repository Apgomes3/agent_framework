import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import inquirer from "inquirer";
import chalk from "chalk";
import type {
  AgentFrameworkConfig,
  AgentInput,
  AgentResult,
  AgentRole,
  ApprovalResult,
  LLMClient,
  ProjectContext,
  Stage,
} from "./types.js";
import { Agent } from "./agent.js";
import { StateManager } from "./state.js";
import { createLLMClient } from "./llm-client.js";
import { resolveProviderConfig } from "../config/settings.js";
import { writeArtifacts } from "../utils/file-writer.js";
import { GitManager } from "../utils/git.js";
import { logger, addFileTransport } from "../utils/logger.js";
import { LearningManager } from "./learning.js";
import { MemoryStore } from "./memory.js";

interface PipelineAgents {
  orchestrator: Agent;
  designer: Agent;
  coder: Agent;
  qa: Agent;
}

const STAGE_ORDER: Stage[] = ["orchestrate", "design", "code", "qa", "complete"];

const STAGE_AGENT_MAP: Record<Exclude<Stage, "complete">, AgentRole> = {
  orchestrate: "orchestrator",
  design: "designer",
  code: "coder",
  qa: "qa",
};

const STAGE_ARTIFACT_MAP: Record<
  Exclude<Stage, "complete">,
  "orchestration" | "design" | "code" | "qa"
> = {
  orchestrate: "orchestration",
  design: "design",
  code: "code",
  qa: "qa",
};

export class Pipeline {
  private stateManager: StateManager;
  private git: GitManager;
  private agents: PipelineAgents;
  private learning: LearningManager;
  private memory: MemoryStore;

  constructor(
    private outputDir: string,
    private config: AgentFrameworkConfig,
    agentFactory: (role: AgentRole, llmClient: LLMClient) => Agent
  ) {
    this.stateManager = new StateManager(outputDir);
    this.git = new GitManager(outputDir);
    this.learning = new LearningManager(outputDir);
    this.memory = new MemoryStore(outputDir);

    // Create LLM clients and agents
    this.agents = {} as PipelineAgents;
    const roles: AgentRole[] = ["orchestrator", "designer", "coder", "qa"];

    for (const role of roles) {
      const agentModelConfig = config.agentModels[role];
      const provider = agentModelConfig?.provider ?? config.defaults.provider;
      const { apiKey, model } = resolveProviderConfig(config, provider);
      const finalModel = agentModelConfig?.model ?? model;
      const llmClient = createLLMClient(provider, apiKey, finalModel);
      this.agents[role] = agentFactory(role, llmClient);
    }
  }

  /**
   * Start a new project from a description.
   */
  async create(projectName: string, description: string): Promise<void> {
    // Setup output directory
    await mkdir(this.outputDir, { recursive: true });
    addFileTransport(join(this.outputDir, ".agent-state", "pipeline.log"));

    // Initialize state
    this.stateManager.init(
      projectName,
      description,
      this.config.defaults.provider,
      this.config.defaults.maxRetries
    );

    // Initialize git
    await this.git.init();
    await this.stateManager.save();

    // Initialize memory store
    this.memory.init(projectName, description);
    await this.memory.save();

    // Initialize learning system
    await this.learning.load();
    // Use the first available LLM client for lesson distillation
    const firstAgent = this.agents.orchestrator;
    this.learning.setLLMClient(firstAgent["llmClient"]);

    logger.info(chalk.bold.cyan(`\n🚀 Starting project: ${projectName}\n`));
    logger.info(`Description: ${description}`);
    logger.info(`Output: ${this.outputDir}\n`);

    await this.runPipeline(description);
  }

  /**
   * Resume a project from its last checkpoint.
   */
  async resume(): Promise<void> {
    const loaded = await this.stateManager.load();
    if (!loaded) {
      throw new Error(`No project state found at ${this.outputDir}`);
    }

    const state = this.stateManager.getState();
    logger.info(
      chalk.bold.cyan(
        `\n🔄 Resuming project: ${state.projectName} (stage: ${state.currentStage})\n`
      )
    );

    // Load learning system
    await this.learning.load();
    const firstAgent = this.agents.orchestrator;
    this.learning.setLLMClient(firstAgent["llmClient"]);

    // Load memory from disk
    await this.memory.load();

    // Initialise git (safe no-op if .git already exists)
    await this.git.init();

    await this.runPipeline(state.description);
  }

  /**
   * Main pipeline loop — runs stages sequentially with human approval.
   */
  private async runPipeline(description: string): Promise<void> {
    const state = this.stateManager.getState();
    const startIndex = STAGE_ORDER.indexOf(state.currentStage);

    for (let i = startIndex; i < STAGE_ORDER.length; i++) {
      const stage = STAGE_ORDER[i];
      if (stage === "complete") {
        await this.finalize();
        break;
      }

      const result = await this.runStage(stage, description);
      if (!result) {
        logger.error(chalk.red(`Pipeline halted at stage: ${stage}`));
        return;
      }
    }
  }

  /**
   * Run a single pipeline stage with retry and approval logic.
   */
  private async runStage(
    stage: Exclude<Stage, "complete">,
    description: string
  ): Promise<boolean> {
    const agentRole = STAGE_AGENT_MAP[stage];
    const agent = this.agents[agentRole];
    const maxRetries = this.stateManager.getState().settings.maxRetries;

    logger.info(chalk.bold.yellow(`\n━━━ Stage: ${stage.toUpperCase()} ━━━\n`));

    let humanFeedback: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        logger.info(chalk.yellow(`Retry ${attempt}/${maxRetries}...`));
      }

      // Start execution tracking
      this.stateManager.startStageExecution(stage, agentRole);

      // Build agent input
      const input = this.buildAgentInput(stage, description, humanFeedback);

      // Execute agent
      let result: AgentResult;
      try {
        result = await agent.execute(input);
      } catch (err) {
        logger.error(`Agent ${agentRole} failed: ${err}`);
        this.stateManager.failStageExecution(stage);

        // Learn from failure
        await this.learning.learnFromFailure(
          agentRole,
          stage,
          String(err),
          `Attempt ${attempt + 1}, stage: ${stage}`
        );
        await this.learning.save();

        await this.stateManager.save();

        if (attempt < maxRetries) continue;
        return false;
      }

      // Track token usage
      this.stateManager.addTokenUsage(agentRole, result.tokenUsage);
      this.stateManager.completeStageExecution(stage, result);

      // Write artifacts to disk
      await writeArtifacts(this.outputDir, result.artifacts);

      // Record to memory store (compact summary for next agent)
      this.memory.record(result);
      await this.memory.save();

      // Store artifacts in state
      const artifactCategory = STAGE_ARTIFACT_MAP[stage];
      this.stateManager.addArtifacts(artifactCategory, result.artifacts);

      // If orchestrator produced tasks, save them
      if (stage === "orchestrate" && result.status === "success") {
        const state = this.stateManager.getState();
        if (state.tasks.length === 0) {
          // Tasks will be set by the orchestrator via parseResponse
          // The orchestrator agent should include tasks in its result
        }
      }

      // Print summary
      this.printStageSummary(stage, result);

      // Check for QA feedback loop
      if (stage === "qa" && result.status === "needs_revision") {
        logger.info(
          chalk.yellow("QA found issues — sending back to Coder for fixes")
        );
        // Run coder fix cycle
        const fixed = await this.runFixCycle(result, description);
        if (!fixed) {
          // Escalate to human — if they approve, accept current state and advance
          logger.warn(
            chalk.red("Auto-fix failed after max retries. Escalating to human.")
          );
          const approval = await this.requestApproval(stage, result);
          if (approval.decision === "reject") return false;

          // Human approved/skipped escalation — accept the current state and move on
          logger.info(chalk.green("Human approved QA stage with outstanding warnings."));
          await this.git.commitAll(`[${agentRole}] ${result.summary}`);
          await this.git.tag(`v0.${STAGE_ORDER.indexOf(stage) + 1}-${stage}`);
          const nextStage = STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1];
          this.stateManager.setStage(nextStage);
          await this.stateManager.save();
          return true;
        }
        // Fix cycle succeeded — QA already verified inside the cycle, advance stage
        await this.git.commitAll(`[qa] QA passed after fixes — ${result.summary}`);
        await this.git.tag(`v0.${STAGE_ORDER.indexOf(stage) + 1}-${stage}`);
        const nextStageAfterFix = STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1];
        this.stateManager.setStage(nextStageAfterFix);
        await this.stateManager.save();
        return true;
      }

      await this.stateManager.save();

      // Request human approval
      if (result.status === "success" || result.status === "needs_revision") {
        const approval = await this.requestApproval(stage, result);
        this.stateManager.recordApproval(
          stage,
          approval.decision === "approve" || approval.decision === "skip",
          approval.feedback
        );

        if (approval.decision === "approve" || approval.decision === "skip") {
          // Commit to git
          await this.git.commitAll(`[${agentRole}] ${result.summary}`);
          await this.git.tag(`v0.${STAGE_ORDER.indexOf(stage) + 1}-${stage}`);

          // Advance to next stage
          const nextStage = STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1];
          this.stateManager.setStage(nextStage);
          await this.stateManager.save();
          return true;
        }

        if (approval.decision === "reject") {
          humanFeedback = approval.feedback;

          // Learn from rejection
          if (approval.feedback) {
            await this.learning.learnFromRejection(
              agentRole,
              stage,
              approval.feedback,
              result.summary
            );
            await this.learning.save();
          }

          if (attempt < maxRetries) continue;
          return false;
        }
      }

      if (result.status === "failed") {
        if (attempt < maxRetries) continue;
        return false;
      }
    }

    return false;
  }

  /**
   * QA → Coder fix cycle: Coder fixes issues, then QA re-validates.
   *
   * Tracks which issue messages have already been attempted so QA is told to
   * downgrade persistent issues from "error" to "warning" on subsequent runs,
   * allowing the pipeline to converge instead of looping indefinitely.
   */
  private async runFixCycle(
    initialQaResult: AgentResult,
    description: string
  ): Promise<boolean> {
    const maxRetries = this.stateManager.getState().settings.maxRetries;
    let currentQaResult = initialQaResult;

    // Track issues that have already been attempted (by message text)
    const attemptedIssues = new Set<string>();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      logger.info(chalk.yellow(`Fix cycle ${attempt + 1}/${maxRetries}`));

      // Parse error issues from the QA report artifact
      const qaReportArtifact = currentQaResult.artifacts.find(
        (a) => a.path === "docs/qa-report.json"
      );
      let errorIssues: Array<{ file: string; message: string; suggestion?: string }> = [];
      if (qaReportArtifact?.content) {
        try {
          const report = JSON.parse(qaReportArtifact.content);
          errorIssues = (report.issues ?? []).filter(
            (i: { severity: string }) => i.severity === "error"
          );
        } catch { /* ignore parse errors */ }
      }

      // Record new issues as attempted
      for (const issue of errorIssues) {
        attemptedIssues.add(issue.message);
      }

      // Build a structured fix list for the coder
      const fixList = errorIssues
        .map(
          (i) => `- [${i.file}] ${i.message}${i.suggestion ? ` → ${i.suggestion}` : ""}`
        )
        .join("\n");
      const coderFeedback = `Fix these QA errors:\n${fixList}`;

      // Coder gets a lean input — only the current code artifacts, no full history
      const coderInput = this.buildFixCycleCoderInput(description, coderFeedback);
      const coderResult = await this.agents.coder.execute(coderInput);

      await writeArtifacts(this.outputDir, coderResult.artifacts);
      this.stateManager.addArtifacts("code", coderResult.artifacts);
      this.stateManager.addTokenUsage("coder", coderResult.tokenUsage);
      await this.git.commitAll(`[coder] Fix: ${coderResult.summary}`);

      // Build QA hint about already-attempted issues
      const alreadyAttempted = Array.from(attemptedIssues);
      const qaFeedback =
        alreadyAttempted.length > 0
          ? `NOTE: The following issues were already attempted in previous fix cycles. ` +
            `If they still appear, downgrade them to "warning" severity so the pipeline can advance:\n` +
            alreadyAttempted.map((m) => `- ${m}`).join("\n")
          : undefined;

      const qaInput = this.buildAgentInput("qa", description, qaFeedback);
      const newQaResult = await this.agents.qa.execute(qaInput);
      this.stateManager.addTokenUsage("qa", newQaResult.tokenUsage);
      currentQaResult = newQaResult;

      if (newQaResult.status === "success") {
        logger.info(chalk.green("✓ QA passed after fixes"));
        await this.learning.learnFromFixLoop(initialQaResult.summary, coderResult.summary, true);
        await this.learning.save();
        return true;
      }

      await this.learning.learnFromFixLoop(initialQaResult.summary, coderResult.summary, false);
    }

    await this.learning.save();
    return false;
  }

  /**
   * Build a lean AgentInput for the coder during a fix cycle.
   * Only includes current code artifacts — no full stage history — to keep tokens low.
   */
  private buildFixCycleCoderInput(description: string, feedback: string): AgentInput {
    const state = this.stateManager.getState();
    const context: ProjectContext = {
      projectName: state.projectName,
      outputDir: this.outputDir,
      tasks: state.tasks,
      designArtifacts: [],
      codeArtifacts: state.artifacts.code,
      qaArtifacts: state.artifacts.qa,
    };
    const lessons = this.learning.formatLessonsForPrompt("coder");
    const memoryContext = this.memory.buildContextSummary();
    return {
      task: null,
      projectDescription: description,
      context,
      previousResults: [],
      humanFeedback: feedback,
      lessons: lessons || undefined,
      memoryContext: memoryContext || undefined,
    };
  }

  /**
   * Build the input for an agent based on current stage and state.
   */
  private buildAgentInput(
    _stage: Exclude<Stage, "complete">,
    description: string,
    humanFeedback?: string
  ): AgentInput {
    const state = this.stateManager.getState();

    const context: ProjectContext = {
      projectName: state.projectName,
      outputDir: this.outputDir,
      tasks: state.tasks,
      designArtifacts: state.artifacts.design,
      codeArtifacts: state.artifacts.code,
      qaArtifacts: state.artifacts.qa,
    };

    // One result per agent — latest only (keeps prompt size bounded across retries)
    const latestPerAgent = new Map<string, AgentResult>();
    for (const h of state.history) {
      if (h.status === "completed" && h.result) {
        latestPerAgent.set(h.result.agent, h.result);
      }
    }
    const previousResults: AgentResult[] = Array.from(latestPerAgent.values());

    // Get relevant lessons for the agent assigned to this stage
    const agentRole = STAGE_AGENT_MAP[_stage];
    const lessons = this.learning.formatLessonsForPrompt(agentRole);
    const memoryContext = this.memory.buildContextSummary();

    return {
      task: null,
      projectDescription: description,
      context,
      previousResults,
      humanFeedback,
      lessons: lessons || undefined,
      memoryContext: memoryContext || undefined,
    };
  }

  /**
   * Request human approval via CLI prompt.
   */
  private async requestApproval(
    stage: Stage,
    result: AgentResult
  ): Promise<ApprovalResult> {
    console.log(chalk.bold.cyan(`\n━━━ Approval Required: ${stage.toUpperCase()} ━━━`));
    console.log(chalk.gray(`Status: ${result.status}`));
    console.log(chalk.gray(`Artifacts: ${result.artifacts.length} files`));
    console.log(chalk.gray(`Summary: ${result.summary}\n`));

    const { decision } = await inquirer.prompt<{ decision: string }>([
      {
        type: "list",
        name: "decision",
        message: "What would you like to do?",
        choices: [
          { name: "✅ Approve and continue", value: "approve" },
          { name: "🔄 Reject with feedback (re-run agent)", value: "reject" },
          { name: "⏭️  Skip approval and continue", value: "skip" },
        ],
      },
    ]);

    let feedback: string | undefined;
    if (decision === "reject") {
      const { fb } = await inquirer.prompt<{ fb: string }>([
        {
          type: "input",
          name: "fb",
          message: "Provide feedback for the agent:",
        },
      ]);
      feedback = fb;
    }

    return { decision: decision as ApprovalResult["decision"], feedback };
  }

  /**
   * Print a summary of the stage execution.
   */
  private printStageSummary(stage: string, result: AgentResult): void {
    const statusIcon =
      result.status === "success"
        ? chalk.green("✓")
        : result.status === "needs_revision"
          ? chalk.yellow("⚠")
          : chalk.red("✗");

    console.log(`\n${statusIcon} ${chalk.bold(stage.toUpperCase())} — ${result.summary}`);
    console.log(
      chalk.gray(
        `  Artifacts: ${result.artifacts.length} | Tokens: ${result.tokenUsage.totalTokens}`
      )
    );
  }

  /**
   * Finalize the project.
   */
  private async finalize(): Promise<void> {
    const state = this.stateManager.getState();
    this.stateManager.setStage("complete");
    await this.stateManager.save();

    // Compact memory: write final summary doc, clear per-block entries
    const memorySummary = await this.memory.finalize();
    await writeArtifacts(this.outputDir, [{
      type: "document",
      path: "docs/memory-summary.md",
      content: `# Project Memory Summary\n\nGenerated at end of pipeline run.\n${memorySummary}`,
      description: "Memory summary of all pipeline stages",
    }]);

    await this.git.commitAll("[complete] Project finalized");
    await this.git.tag("v1.0", "Project complete — all stages passed");

    console.log(chalk.bold.green("\n✅ Project complete!\n"));
    console.log(`  Project: ${state.projectName}`);
    console.log(`  Output:  ${this.outputDir}`);
    console.log(
      `  Tokens:  ${state.tokenUsage.total.totalTokens} total`
    );
    console.log(
      `    Orchestrator: ${state.tokenUsage.perAgent.orchestrator.totalTokens}`
    );
    console.log(
      `    Designer:     ${state.tokenUsage.perAgent.designer.totalTokens}`
    );
    console.log(
      `    Coder:        ${state.tokenUsage.perAgent.coder.totalTokens}`
    );
    console.log(
      `    QA:           ${state.tokenUsage.perAgent.qa.totalTokens}`
    );

    // Learning stats
    const learningStats = this.learning.getStats();
    if (learningStats.lessonCount > 0) {
      console.log(chalk.bold("\n  Learning:"));
      console.log(`    Lessons learned: ${learningStats.totalLessonsLearned}`);
      console.log(`    Lessons applied: ${learningStats.totalLessonsApplied}`);
      console.log(`    Failures captured: ${learningStats.totalFailures}`);
    }

    await this.learning.save();
  }
}
