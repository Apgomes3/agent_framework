import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import type {
  AgentResult,
  AgentRole,
  Artifact,
  LLMProvider,
  ProjectState,
  Stage,
  StageExecution,
  Task,
} from "./types.js";
import { logger } from "../utils/logger.js";

const STATE_DIR = ".agent-state";
const STATE_FILE = "state.json";

export class StateManager {
  private state: ProjectState;
  private stateFilePath: string;

  constructor(outputDir: string) {
    this.stateFilePath = join(outputDir, STATE_DIR, STATE_FILE);
    this.state = this.defaultState();
  }

  private defaultState(): ProjectState {
    return {
      projectName: "",
      description: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentStage: "orchestrate",
      tasks: [],
      history: [],
      artifacts: { orchestration: [], design: [], code: [], qa: [] },
      settings: { llmProvider: "openai", maxRetries: 3 },
      tokenUsage: {
        total: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        perAgent: {
          orchestrator: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          designer: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          coder: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          qa: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        },
      },
    };
  }

  /** Initialize a new project state */
  init(projectName: string, description: string, provider: LLMProvider, maxRetries: number): void {
    this.state.projectName = projectName;
    this.state.description = description;
    this.state.settings.llmProvider = provider;
    this.state.settings.maxRetries = maxRetries;
  }

  /** Load state from disk. Returns false if no state file exists. */
  async load(): Promise<boolean> {
    if (!existsSync(this.stateFilePath)) {
      return false;
    }
    const raw = await readFile(this.stateFilePath, "utf-8");
    this.state = JSON.parse(raw);
    logger.info(`Loaded project state: stage=${this.state.currentStage}`);
    return true;
  }

  /** Persist state to disk */
  async save(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const dir = dirname(this.stateFilePath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2), "utf-8");
  }

  /** Get current state (readonly) */
  getState(): Readonly<ProjectState> {
    return this.state;
  }

  /** Advance to the next stage */
  setStage(stage: Stage): void {
    this.state.currentStage = stage;
  }

  /** Set tasks (from orchestrator output) */
  setTasks(tasks: Task[]): void {
    this.state.tasks = tasks;
  }

  /** Record a stage execution starting */
  startStageExecution(stage: Stage, agent: AgentRole): StageExecution {
    const execution: StageExecution = {
      stage,
      agent,
      startedAt: new Date().toISOString(),
      status: "running",
      retryCount: 0,
    };
    this.state.history.push(execution);
    return execution;
  }

  /** Mark the latest execution for a stage as completed */
  completeStageExecution(stage: Stage, result: AgentResult): void {
    const execution = this.getLatestExecution(stage);
    if (execution) {
      execution.completedAt = new Date().toISOString();
      execution.status = "completed";
      execution.result = result;
    }
  }

  /** Mark the latest execution for a stage as failed */
  failStageExecution(stage: Stage): void {
    const execution = this.getLatestExecution(stage);
    if (execution) {
      execution.completedAt = new Date().toISOString();
      execution.status = "failed";
    }
  }

  /** Record human approval */
  recordApproval(stage: Stage, approved: boolean, feedback?: string): void {
    const execution = this.getLatestExecution(stage);
    if (execution) {
      execution.humanApproval = {
        approved,
        feedback,
        timestamp: new Date().toISOString(),
      };
      execution.status = approved ? "completed" : "awaiting_approval";
    }
  }

  /** Add artifacts for a stage category */
  addArtifacts(category: keyof ProjectState["artifacts"], artifacts: Artifact[]): void {
    this.state.artifacts[category].push(...artifacts);
  }

  /** Track token usage */
  addTokenUsage(agent: AgentRole, usage: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
    this.state.tokenUsage.total.promptTokens += usage.promptTokens;
    this.state.tokenUsage.total.completionTokens += usage.completionTokens;
    this.state.tokenUsage.total.totalTokens += usage.totalTokens;

    const agentUsage = this.state.tokenUsage.perAgent[agent];
    agentUsage.promptTokens += usage.promptTokens;
    agentUsage.completionTokens += usage.completionTokens;
    agentUsage.totalTokens += usage.totalTokens;
  }

  /** Get retry count for current stage */
  getRetryCount(stage: Stage): number {
    const executions = this.state.history.filter((e) => e.stage === stage);
    return executions.length > 0 ? executions.length - 1 : 0;
  }

  /** Increment retry count for latest stage execution */
  incrementRetry(stage: Stage): void {
    const execution = this.getLatestExecution(stage);
    if (execution) {
      execution.retryCount++;
    }
  }

  private getLatestExecution(stage: Stage): StageExecution | undefined {
    for (let i = this.state.history.length - 1; i >= 0; i--) {
      if (this.state.history[i].stage === stage) {
        return this.state.history[i];
      }
    }
    return undefined;
  }
}
