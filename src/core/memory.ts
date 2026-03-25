import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRole, AgentResult, Stage } from "./types.js";

// ── Memory Types ──────────────────────────────────────────

export interface MemoryBlock {
  id: string;
  agent: AgentRole;
  stage: Stage;
  timestamp: string;
  summary: string;
  keyDecisions: string[];
  artifactPaths: string[];
  techStack: string[];
  status: "success" | "needs_revision" | "failed";
}

export interface MemoryState {
  projectName: string;
  description: string;
  techStack: string[];
  blocks: MemoryBlock[];
  finalSummary?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Known tech keywords to detect from summaries ─────────

const KNOWN_TECH = [
  "React", "Vue", "Angular", "TypeScript", "JavaScript",
  "Node.js", "Express", "Fastify", "NestJS", "Hono",
  "PostgreSQL", "MySQL", "MongoDB", "SQLite", "Redis",
  "Docker", "Kubernetes", "Prisma", "Drizzle",
  "Tailwind", "Material-UI", "shadcn", "Chakra",
  "Next.js", "Remix", "Vite", "Webpack",
  "GraphQL", "REST", "tRPC", "JWT", "OAuth", "Zod",
];

// ── MemoryStore ───────────────────────────────────────────

/**
 * Persistent, compact memory for the agent pipeline.
 *
 * Each time an agent completes, its result is condensed into a MemoryBlock
 * (summary + decisions + artifact paths — no full content). The next agent
 * receives this compact block via its system prompt instead of receiving the
 * full artifact content, which keeps token usage low and context clean.
 *
 * At the end of the pipeline run, finalize() compacts all blocks into a
 * single summary document and clears the per-stage entries.
 */
export class MemoryStore {
  private state: MemoryState = {
    projectName: "",
    description: "",
    techStack: [],
    blocks: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  constructor(private outputDir: string) {}

  get filePath(): string {
    return join(this.outputDir, ".agent-state", "memory.json");
  }

  /**
   * Initialize a fresh memory store for a new project.
   */
  init(projectName: string, description: string): void {
    this.state = {
      projectName,
      description,
      techStack: [],
      blocks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Load memory from disk (used when resuming a project).
   */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.state = JSON.parse(raw) as MemoryState;
    } catch {
      // No memory file yet — fresh state
    }
  }

  /**
   * Persist current memory to disk.
   */
  async save(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    await mkdir(join(this.outputDir, ".agent-state"), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
  }

  /**
   * Record what an agent accomplished into a compact MemoryBlock.
   * Replaces any previous block from the same agent (idempotent on retry).
   */
  record(result: AgentResult): void {
    const techKeywords = extractTechKeywords(result.summary);

    // Merge newly found tech into global stack
    for (const tech of techKeywords) {
      if (!this.state.techStack.includes(tech)) {
        this.state.techStack.push(tech);
      }
    }

    const block: MemoryBlock = {
      id: `${result.agent}-${Date.now()}`,
      agent: result.agent,
      stage: result.stage,
      timestamp: result.timestamp ?? new Date().toISOString(),
      summary: truncate(result.summary, 200),
      keyDecisions: extractKeyDecisions(result),
      artifactPaths: result.artifacts.map((a) => a.path),
      techStack: techKeywords,
      status: result.status,
    };

    // Keep only the latest block per agent (replace on retry)
    this.state.blocks = this.state.blocks.filter((b) => b.agent !== result.agent);
    this.state.blocks.push(block);
  }

  /**
   * Build a compact context string to inject into the next agent's system prompt.
   * Intentionally kept small — target: < 400 tokens.
   */
  buildContextSummary(): string {
    if (this.state.blocks.length === 0) return "";

    const lines: string[] = [
      "\n\n---\n## Project Memory — What Has Been Done\n",
      `**Project:** ${this.state.projectName}`,
    ];

    if (this.state.techStack.length > 0) {
      lines.push(`**Tech Stack:** ${this.state.techStack.join(", ")}`);
    }

    lines.push("\n### Completed Stages");

    for (const block of this.state.blocks) {
      const icon = block.status === "success" ? "✅" : "⚠️";
      lines.push(`\n${icon} **${block.stage.toUpperCase()}**`);
      lines.push(`   ${block.summary}`);

      if (block.keyDecisions.length > 0) {
        lines.push(`   Decisions: ${block.keyDecisions.join("; ")}`);
      }

      if (block.artifactPaths.length > 0) {
        lines.push(`   Artifacts: ${block.artifactPaths.join(", ")}`);
      }
    }

    lines.push("\n---\n");
    return lines.join("\n");
  }

  /**
   * Finalize memory: collapse all blocks into one permanent summary,
   * write it to docs/memory-summary.md, and clear the per-block entries.
   * Called at the end of a successful pipeline run.
   */
  async finalize(): Promise<string> {
    const summary = this.buildContextSummary();
    this.state.finalSummary = summary;
    // Clear per-stage blocks — only the summary is kept
    this.state.blocks = [];
    await this.save();
    return summary;
  }

  /** Returns the accumulated final summary (available after finalize()). */
  getFinalSummary(): string | undefined {
    return this.state.finalSummary;
  }
}

// ── Helpers ───────────────────────────────────────────────

/** Truncate a string to maxLen characters. */
function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}

/** Extract concise key decisions from an agent result's artifact descriptions. */
function extractKeyDecisions(result: AgentResult): string[] {
  const decisions: string[] = [];

  for (const artifact of result.artifacts) {
    if (artifact.description && artifact.description.length <= 80) {
      decisions.push(artifact.description);
    }
  }

  return decisions.slice(0, 4);
}

/** Detect tech keywords mentioned in a string. */
function extractTechKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  return KNOWN_TECH.filter((tech) => lower.includes(tech.toLowerCase()));
}
