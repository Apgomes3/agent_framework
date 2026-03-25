import { z } from "zod";

// ── LLM Types ──────────────────────────────────────────────

export type LLMProvider = "openai" | "anthropic" | "gemini";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json";
}

export interface LLMResponse {
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  model: string;
}

export interface LLMClient {
  provider: LLMProvider;
  chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
}

// ── Pipeline Stages ────────────────────────────────────────

export const STAGES = ["orchestrate", "design", "code", "qa", "complete"] as const;
export type Stage = (typeof STAGES)[number];

// ── Tasks ──────────────────────────────────────────────────

export const TaskPrioritySchema = z.enum(["critical", "high", "medium", "low"]);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const TaskStatusSchema = z.enum(["pending", "in-progress", "completed", "failed"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  assignee: z.enum(["orchestrator", "designer", "coder", "qa"]),
  priority: TaskPrioritySchema,
  status: TaskStatusSchema,
  dependencies: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskBreakdownSchema = z.object({
  projectName: z.string(),
  tasks: z.array(TaskSchema),
});
export type TaskBreakdown = z.infer<typeof TaskBreakdownSchema>;

// ── Artifacts ──────────────────────────────────────────────

export interface Artifact {
  type: "file" | "directory" | "document";
  path: string;
  content?: string;
  description: string;
}

// ── Agent Types ────────────────────────────────────────────

export type AgentRole = "orchestrator" | "designer" | "coder" | "qa";

export interface AgentInput {
  task: Task | null;
  projectDescription: string;
  context: ProjectContext;
  previousResults: AgentResult[];
  humanFeedback?: string;
  lessons?: string; // Formatted lessons from the learning system
}

export interface AgentResult {
  agent: AgentRole;
  stage: Stage;
  status: "success" | "needs_revision" | "failed";
  artifacts: Artifact[];
  summary: string;
  tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
  timestamp: string;
}

export interface ProjectContext {
  projectName: string;
  outputDir: string;
  tasks: Task[];
  designArtifacts: Artifact[];
  codeArtifacts: Artifact[];
  qaArtifacts: Artifact[];
}

// ── QA Report ──────────────────────────────────────────────

export const QAIssueSchema = z.object({
  id: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  category: z.enum(["typescript", "lint", "security", "accessibility", "best-practice", "test-failure"]),
  file: z.string(),
  line: z.number().optional(),
  message: z.string(),
  suggestion: z.string().optional(),
});
export type QAIssue = z.infer<typeof QAIssueSchema>;

export const QAReportSchema = z.object({
  passed: z.boolean(),
  issues: z.array(QAIssueSchema),
  testResults: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
  }),
  summary: z.string(),
});
export type QAReport = z.infer<typeof QAReportSchema>;

// ── Design Tokens ──────────────────────────────────────────

export const DesignTokensSchema = z.object({
  colors: z.record(z.string()),
  typography: z.object({
    fontFamily: z.string(),
    fontSize: z.record(z.string()),
    fontWeight: z.record(z.number()),
  }),
  spacing: z.record(z.string()),
  borderRadius: z.record(z.string()),
});
export type DesignTokens = z.infer<typeof DesignTokensSchema>;

export interface ComponentNode {
  name: string;
  type: "page" | "layout" | "component" | "hook" | "store" | "util";
  description: string;
  props?: Record<string, string>;
  children: ComponentNode[];
}

export const ComponentNodeSchema: z.ZodType<ComponentNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.enum(["page", "layout", "component", "hook", "store", "util"]),
    description: z.string(),
    props: z.record(z.string()).optional(),
    children: z.array(ComponentNodeSchema).default([]),
  })
) as z.ZodType<ComponentNode>;

// ── Project State ──────────────────────────────────────────

export interface StageExecution {
  stage: Stage;
  agent: AgentRole;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed" | "awaiting_approval";
  result?: AgentResult;
  humanApproval?: {
    approved: boolean;
    feedback?: string;
    timestamp: string;
  };
  retryCount: number;
}

export interface ProjectState {
  projectName: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  currentStage: Stage;
  tasks: Task[];
  history: StageExecution[];
  artifacts: {
    orchestration: Artifact[];
    design: Artifact[];
    code: Artifact[];
    qa: Artifact[];
  };
  settings: {
    llmProvider: LLMProvider;
    model?: string;
    maxRetries: number;
  };
  tokenUsage: {
    total: { promptTokens: number; completionTokens: number; totalTokens: number };
    perAgent: Record<AgentRole, { promptTokens: number; completionTokens: number; totalTokens: number }>;
  };
}

// ── Config ─────────────────────────────────────────────────

export interface AgentFrameworkConfig {
  providers: {
    openai?: { apiKey: string; defaultModel: string };
    anthropic?: { apiKey: string; defaultModel: string };
    gemini?: { apiKey: string; defaultModel: string };
  };
  agentModels: Partial<Record<AgentRole, { provider: LLMProvider; model: string }>>;
  defaults: {
    provider: LLMProvider;
    maxRetries: number;
    outputDir: string;
  };
}

// ── Human Approval ─────────────────────────────────────────

export type ApprovalDecision = "approve" | "reject" | "skip";

export interface ApprovalResult {
  decision: ApprovalDecision;
  feedback?: string;
}
