import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { AgentRole, LLMClient, LLMMessage, Stage } from "./types.js";
import { logger } from "../utils/logger.js";

// ── Types ──────────────────────────────────────────────────

export interface Lesson {
  id: string;
  agent: AgentRole;
  stage: Stage;
  category: "failure" | "rejection" | "fix-loop" | "pattern";
  problem: string;
  resolution: string;
  context: string;
  learnedAt: string;
  appliedCount: number;
  effectiveness: number; // 0-1, updated when the lesson is applied and outcome is measured
}

export interface LearningStore {
  version: number;
  lessons: Lesson[];
  stats: {
    totalFailures: number;
    totalLessonsLearned: number;
    totalLessonsApplied: number;
  };
}

// ── Learning Manager ───────────────────────────────────────

/**
 * Manages a persistent learning store that captures lessons from agent failures,
 * human rejections, and QA fix loops. Lessons are injected into agent prompts
 * so the system avoids repeating mistakes.
 */
export class LearningManager {
  private store: LearningStore;
  private storePath: string;
  private llmClient: LLMClient | null = null;

  constructor(private baseDir: string) {
    this.storePath = join(baseDir, ".agent-state", "learning.json");
    this.store = this.defaultStore();
  }

  /** Optionally set an LLM client for auto-distilling lessons */
  setLLMClient(client: LLMClient): void {
    this.llmClient = client;
  }

  private defaultStore(): LearningStore {
    return {
      version: 1,
      lessons: [],
      stats: { totalFailures: 0, totalLessonsLearned: 0, totalLessonsApplied: 0 },
    };
  }

  /** Load learning store from disk (or from global learning file) */
  async load(): Promise<void> {
    // Load project-local learning
    if (existsSync(this.storePath)) {
      const raw = await readFile(this.storePath, "utf-8");
      this.store = JSON.parse(raw);
      logger.info(`Loaded ${this.store.lessons.length} learned lessons`);
    }

    // Also load global lessons (cross-project learning)
    const globalPath = join(this.baseDir, "..", ".agent-learning", "global-lessons.json");
    if (existsSync(globalPath)) {
      const raw = await readFile(globalPath, "utf-8");
      const globalStore = JSON.parse(raw) as LearningStore;
      // Merge new global lessons not already present
      for (const lesson of globalStore.lessons) {
        if (!this.store.lessons.find((l) => l.id === lesson.id)) {
          this.store.lessons.push(lesson);
        }
      }
      logger.debug(`Merged global lessons (${globalStore.lessons.length} total)`);
    }
  }

  /** Save learning store to disk + sync to global */
  async save(): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify(this.store, null, 2), "utf-8");

    // Also save high-effectiveness lessons to global store
    await this.syncToGlobal();
  }

  // ── Learn from events ────────────────────────────────────

  /**
   * Record a lesson from an agent failure or error.
   */
  async learnFromFailure(
    agent: AgentRole,
    stage: Stage,
    error: string,
    context: string
  ): Promise<void> {
    this.store.stats.totalFailures++;

    const lesson = await this.distillLesson(agent, stage, "failure", error, "", context);
    if (lesson) {
      this.store.lessons.push(lesson);
      this.store.stats.totalLessonsLearned++;
      logger.info(`[learning] New lesson from ${agent} failure: ${lesson.problem.slice(0, 80)}`);
    }
  }

  /**
   * Record a lesson from a human rejection with feedback.
   */
  async learnFromRejection(
    agent: AgentRole,
    stage: Stage,
    feedback: string,
    agentOutput: string
  ): Promise<void> {
    const lesson = await this.distillLesson(
      agent,
      stage,
      "rejection",
      feedback,
      "",
      agentOutput
    );
    if (lesson) {
      this.store.lessons.push(lesson);
      this.store.stats.totalLessonsLearned++;
      logger.info(`[learning] New lesson from ${agent} rejection: ${lesson.problem.slice(0, 80)}`);
    }
  }

  /**
   * Record a lesson from a QA→Coder fix loop.
   * Captures what QA found and how the coder fixed it.
   */
  async learnFromFixLoop(
    qaIssues: string,
    coderFix: string,
    succeeded: boolean
  ): Promise<void> {
    const lesson = await this.distillLesson(
      "coder",
      "code",
      "fix-loop",
      qaIssues,
      succeeded ? coderFix : "",
      `QA found issues. Coder fix ${succeeded ? "succeeded" : "failed"}.`
    );
    if (lesson) {
      if (succeeded) {
        lesson.effectiveness = 0.8; // High confidence since it actually worked
      }
      this.store.lessons.push(lesson);
      this.store.stats.totalLessonsLearned++;
      logger.info(`[learning] New lesson from fix loop: ${lesson.problem.slice(0, 80)}`);
    }
  }

  /**
   * Mark a lesson as applied and update its effectiveness.
   */
  markApplied(lessonId: string, wasEffective: boolean): void {
    const lesson = this.store.lessons.find((l) => l.id === lessonId);
    if (lesson) {
      lesson.appliedCount++;
      // Exponential moving average of effectiveness
      const alpha = 0.3;
      lesson.effectiveness = alpha * (wasEffective ? 1 : 0) + (1 - alpha) * lesson.effectiveness;
      this.store.stats.totalLessonsApplied++;
    }
  }

  // ── Query lessons ────────────────────────────────────────

  /**
   * Get relevant lessons for a specific agent, sorted by effectiveness.
   * Returns top N lessons most likely to be useful.
   */
  getLessonsForAgent(agent: AgentRole, maxLessons = 5): Lesson[] {
    return this.store.lessons
      .filter((l) => l.agent === agent && l.effectiveness >= 0.3)
      .sort((a, b) => {
        // Sort by effectiveness * recency
        const aScore = a.effectiveness * (1 / (1 + a.appliedCount * 0.1));
        const bScore = b.effectiveness * (1 / (1 + b.appliedCount * 0.1));
        return bScore - aScore;
      })
      .slice(0, maxLessons);
  }

  /**
   * Format lessons as a prompt section to inject into agent messages.
   */
  formatLessonsForPrompt(agent: AgentRole): string {
    const lessons = this.getLessonsForAgent(agent);
    if (lessons.length === 0) return "";

    let section = "\n\n## Lessons Learned (from previous runs)\n";
    section += "IMPORTANT: Apply these lessons to avoid repeating past mistakes:\n\n";

    for (const lesson of lessons) {
      section += `- **${lesson.category}** (effectiveness: ${(lesson.effectiveness * 100).toFixed(0)}%): `;
      section += `${lesson.problem}`;
      if (lesson.resolution) {
        section += ` → **Fix:** ${lesson.resolution}`;
      }
      section += "\n";
    }

    return section;
  }

  /** Get stats summary */
  getStats(): LearningStore["stats"] & { lessonCount: number } {
    return {
      ...this.store.stats,
      lessonCount: this.store.lessons.length,
    };
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Use LLM to distill a concise, reusable lesson from raw failure data.
   * Falls back to a simple extraction if no LLM client is available.
   */
  private async distillLesson(
    agent: AgentRole,
    stage: Stage,
    category: Lesson["category"],
    problem: string,
    resolution: string,
    context: string
  ): Promise<Lesson | null> {
    let distilledProblem = problem;
    let distilledResolution = resolution;

    // If we have an LLM client, use it to distill a concise lesson
    if (this.llmClient) {
      try {
        const messages: LLMMessage[] = [
          {
            role: "system",
            content: `You distill software development failures into concise, actionable lessons. Output JSON:
{"problem": "one-sentence description of what went wrong", "resolution": "one-sentence description of how to avoid/fix it"}
Be specific and technical. Focus on the root cause, not symptoms.`,
          },
          {
            role: "user",
            content: `Agent: ${agent} (${stage})\nCategory: ${category}\nProblem: ${problem}\nResolution: ${resolution}\nContext: ${context.slice(0, 2000)}`,
          },
        ];

        const response = await this.llmClient.chat(messages, {
          temperature: 0.3,
          maxTokens: 256,
          responseFormat: "json",
        });

        const parsed = JSON.parse(response.content);
        distilledProblem = parsed.problem ?? problem;
        distilledResolution = parsed.resolution ?? resolution;
      } catch {
        // Fall back to raw text if distillation fails
        logger.debug("[learning] LLM distillation failed, using raw text");
      }
    }

    // Truncate to keep lessons concise
    distilledProblem = distilledProblem.slice(0, 500);
    distilledResolution = distilledResolution.slice(0, 500);

    return {
      id: `lesson-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agent,
      stage,
      category,
      problem: distilledProblem,
      resolution: distilledResolution,
      context: context.slice(0, 200), // Keep minimal context
      learnedAt: new Date().toISOString(),
      appliedCount: 0,
      effectiveness: 0.5, // Start neutral
    };
  }

  /**
   * Sync high-quality lessons to a global store shared across projects.
   */
  private async syncToGlobal(): Promise<void> {
    const globalDir = join(this.baseDir, "..", ".agent-learning");
    const globalPath = join(globalDir, "global-lessons.json");

    // Only sync lessons that have been effective
    const worthyLessons = this.store.lessons.filter(
      (l) => l.effectiveness >= 0.6 && l.appliedCount >= 1
    );

    if (worthyLessons.length === 0) return;

    let globalStore: LearningStore;
    if (existsSync(globalPath)) {
      const raw = await readFile(globalPath, "utf-8");
      globalStore = JSON.parse(raw);
    } else {
      globalStore = this.defaultStore();
    }

    // Merge worthy lessons
    for (const lesson of worthyLessons) {
      if (!globalStore.lessons.find((l) => l.id === lesson.id)) {
        globalStore.lessons.push(lesson);
      }
    }

    // Cap global store at 200 lessons, keeping most effective
    if (globalStore.lessons.length > 200) {
      globalStore.lessons.sort((a, b) => b.effectiveness - a.effectiveness);
      globalStore.lessons = globalStore.lessons.slice(0, 200);
    }

    await mkdir(globalDir, { recursive: true });
    await writeFile(globalPath, JSON.stringify(globalStore, null, 2), "utf-8");
    logger.debug(`Synced ${worthyLessons.length} lessons to global store`);
  }
}
