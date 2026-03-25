import { Agent } from "../core/agent.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

const CODER_OUTPUT_FORMAT = `
## Output format
Return JSON:
{
  "files": [
    {
      "path": "src/App.tsx",
      "content": "full file content here",
      "description": "Root application component"
    }
  ],
  "dependencies": {
    "production": { "react": "^19.0.0", ... },
    "dev": { "typescript": "^5.7.0", ... }
  },
  "summary": "Brief description of what was generated"
}

## When fixing issues
If you receive QA feedback, fix ONLY the specific issues mentioned. Return only the files that changed.

## File generation strategy
1. Start with config files: package.json, tsconfig.json, vite.config.ts / next.config.ts
2. App shell: App.tsx / layout.tsx, main.tsx, router setup
3. Shared: types, api client, stores, design tokens integration
4. Features: pages, components per feature
5. API: routes, controllers, services, middleware`;

/** Build the full system prompt for the coder using the resolved tech stack */
function buildCoderSystemPrompt(stackId?: string): string {
  const stack = getTechStack(stackId);
  return stack.coderSystemPrompt + CODER_OUTPUT_FORMAT;
}

// Default prompt for backward compatibility
const SYSTEM_PROMPT = buildCoderSystemPrompt();

export class CoderAgent extends Agent {
  readonly role: AgentRole = "coder";
  readonly stage: Stage = "code";

  // ── Multi-phase execution override ─────────────────────

  /**
   * Override execute() to do multi-phase code generation:
   * - Fix mode (humanFeedback): incremental patching — reads files from disk, returns only changed files
   * - Initial mode: Phase 1 scaffold + Phase 2 feature batches
   */
  override async execute(input: AgentInput): Promise<AgentResult> {
    const startTime = Date.now();
    logger.info(`[${this.role}] Starting execution...`);

    // Inject memory + lessons onto a copy of the system prompt
    const sysContent = this.buildSystemPrompt(input);

    let result: AgentResult;
    if (input.humanFeedback) {
      result = await this.executeIncrementalFix(input, sysContent);
    } else {
      result = await this.executeMultiPhase(input, sysContent);
    }

    result.agent = this.role;
    result.stage = this.stage;
    result.timestamp = new Date().toISOString();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(
      `[${this.role}] Completed in ${elapsed}s — status: ${result.status}, artifacts: ${result.artifacts.length}`
    );

    return result;
  }

  // ── Phase 1+2: Plan then generate in batches ──────────

  private async executeMultiPhase(input: AgentInput, systemPrompt: string): Promise<AgentResult> {
    const allArtifacts: Artifact[] = [];
    let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    // Phase 1: Plan — file manifest + scaffold (config files, app shell)
    logger.info(`[${this.role}] Phase 1: Planning file structure + scaffold...`);
    const planMessages = this.buildPlanMessages(input, systemPrompt);
    const planResponse = await this.llmClient.chat(planMessages, { maxTokens: 8192, responseFormat: "json" });
    this.addUsage(totalUsage, planResponse.usage);

    const plan = JSON.parse(this.extractJSON(planResponse.content));

    // Collect scaffold files from Phase 1
    if (plan.files && Array.isArray(plan.files)) {
      for (const file of plan.files) {
        allArtifacts.push({ type: "file", path: file.path, content: file.content, description: file.description ?? "" });
      }
    }

    // Generate package.json from dependencies
    this.maybeAddPackageJson(allArtifacts, plan, input.context.projectName);

    // Phase 2: Generate features in batches
    const batches: Array<{ name: string; files: string[] }> = plan.featureBatches ?? [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      logger.info(`[${this.role}] Phase 2 [${i + 1}/${batches.length}]: Generating ${batch.name} (${batch.files.length} files)...`);

      const batchMessages = this.buildBatchMessages(input, systemPrompt, plan, batch, allArtifacts);
      const batchResponse = await this.llmClient.chat(batchMessages, { maxTokens: 16384, responseFormat: "json" });
      this.addUsage(totalUsage, batchResponse.usage);

      const batchJson = JSON.parse(this.extractJSON(batchResponse.content));
      if (batchJson.files && Array.isArray(batchJson.files)) {
        for (const file of batchJson.files) {
          allArtifacts.push({ type: "file", path: file.path, content: file.content, description: file.description ?? "" });
        }
      }
    }

    return {
      agent: this.role, stage: this.stage, status: "success",
      artifacts: allArtifacts,
      summary: plan.summary ?? `Generated ${allArtifacts.length} files in ${batches.length + 1} phases`,
      tokenUsage: totalUsage,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Incremental fix mode ──────────────────────────────

  private async executeIncrementalFix(input: AgentInput, systemPrompt: string): Promise<AgentResult> {
    // Read actual files from disk instead of using stale state artifacts
    const filesToFix = this.extractFilesFromFeedback(input.humanFeedback ?? "");
    const diskContents = await this.readFilesFromDisk(input.context.outputDir, filesToFix);

    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    let userContent = `## Project: ${input.context.projectName}\n\n`;
    userContent += `## Fix Instructions\n${input.humanFeedback}\n\n`;

    if (diskContents.length > 0) {
      userContent += `## Current file contents (from disk — these are the ACTUAL current versions)\n\n`;
      for (const { path, content } of diskContents) {
        const ext = path.split(".").pop() ?? "";
        userContent += `### ${path}\n\`\`\`${ext}\n${content}\n\`\`\`\n\n`;
      }
    }

    userContent += `\n## IMPORTANT\n`;
    userContent += `- Return ONLY the files you changed, not the entire codebase\n`;
    userContent += `- Read the current file content above — apply targeted fixes, do NOT regenerate from scratch\n`;
    userContent += `- Preserve all existing code that doesn't need to change\n`;

    messages.push({ role: "user", content: userContent });

    const response = await this.llmClient.chat(messages, { maxTokens: 16384, responseFormat: "json" });
    const json = JSON.parse(this.extractJSON(response.content));

    const artifacts: Artifact[] = [];
    if (json.files && Array.isArray(json.files)) {
      for (const file of json.files) {
        artifacts.push({ type: "file", path: file.path, content: file.content, description: file.description ?? "" });
      }
    }
    this.maybeAddPackageJson(artifacts, json, input.context.projectName);

    return {
      agent: this.role, stage: this.stage, status: "success",
      artifacts,
      summary: json.summary ?? `Fixed ${artifacts.length} files`,
      tokenUsage: response.usage,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Message builders ──────────────────────────────────

  private buildPlanMessages(input: AgentInput, systemPrompt: string): LLMMessage[] {
    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    let userContent = `## Project: ${input.context.projectName}\n\n`;
    userContent += `## Description\n${input.projectDescription}\n\n`;

    // Include orchestrator + designer artifacts
    userContent += this.buildContextSection(input);

    userContent += `\n## Instructions — Phase 1: Plan + Scaffold\n`;
    userContent += `Generate the project scaffold: config files, app shell, shared types/utils, and router setup.\n`;
    userContent += `Also return a plan of feature batches to generate in subsequent calls.\n\n`;
    userContent += `Return JSON:\n`;
    userContent += `{\n`;
    userContent += `  "files": [\n`;
    userContent += `    { "path": "package.json", "content": "...", "description": "..." },\n`;
    userContent += `    { "path": "tsconfig.json", "content": "...", "description": "..." },\n`;
    userContent += `    { "path": "vite.config.ts", "content": "...", "description": "..." },\n`;
    userContent += `    { "path": "index.html", "content": "...", "description": "..." },\n`;
    userContent += `    { "path": "src/main.tsx", "content": "...", "description": "..." },\n`;
    userContent += `    { "path": "src/App.tsx", "content": "...", "description": "..." },\n`;
    userContent += `    ... other scaffold files (types, api client, stores, router)\n`;
    userContent += `  ],\n`;
    userContent += `  "featureBatches": [\n`;
    userContent += `    { "name": "authentication", "files": ["src/features/auth/LoginPage.tsx", "src/features/auth/hooks/useAuth.ts", ...], "description": "Auth feature" },\n`;
    userContent += `    { "name": "dashboard", "files": ["src/features/dashboard/DashboardPage.tsx", ...], "description": "Dashboard" }\n`;
    userContent += `  ],\n`;
    userContent += `  "dependencies": { "production": {...}, "dev": {...} },\n`;
    userContent += `  "summary": "Brief description"\n`;
    userContent += `}\n`;

    messages.push({ role: "user", content: userContent });
    return messages;
  }

  private buildBatchMessages(
    input: AgentInput,
    systemPrompt: string,
    _plan: Record<string, unknown>,
    batch: { name: string; files: string[] },
    alreadyGenerated: Artifact[]
  ): LLMMessage[] {
    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    let userContent = `## Project: ${input.context.projectName}\n\n`;

    // Give batch context about what exists
    const scaffoldPaths = alreadyGenerated.map((a) => a.path);
    userContent += `## Already Generated Files\n`;
    userContent += `These files already exist (do NOT regenerate them):\n`;
    userContent += scaffoldPaths.map((p) => `- ${p}`).join("\n") + "\n\n";

    // Include key scaffold files as reference (types, router, App.tsx)
    const referenceFiles = alreadyGenerated.filter((a) =>
      a.path.includes("types") || a.path.includes("App.tsx") || a.path.includes("router") || a.path.includes("store")
    );
    if (referenceFiles.length > 0) {
      userContent += `## Reference Files (for imports and type consistency)\n\n`;
      for (const ref of referenceFiles.slice(0, 5)) {
        if (ref.content) {
          const ext = ref.path.split(".").pop() ?? "";
          userContent += `### ${ref.path}\n\`\`\`${ext}\n${ref.content}\n\`\`\`\n\n`;
        }
      }
    }

    userContent += `## Generate: ${batch.name}\n`;
    userContent += `Generate these files:\n`;
    userContent += batch.files.map((f) => `- ${f}`).join("\n") + "\n\n";

    // Include design context for component details
    const designerResult = input.previousResults.find((r) => r.agent === "designer");
    if (designerResult) {
      const componentTree = designerResult.artifacts.find((a) => a.path === "design/component-tree.json");
      if (componentTree?.content) {
        userContent += `## Component Tree\n\`\`\`json\n${componentTree.content}\n\`\`\`\n\n`;
      }
    }

    userContent += `Return JSON: { "files": [{ "path": "...", "content": "...", "description": "..." }] }\n`;

    messages.push({ role: "user", content: userContent });
    return messages;
  }

  private buildContextSection(input: AgentInput): string {
    let content = "";

    const orchestratorResult = input.previousResults.find((r) => r.agent === "orchestrator");
    if (orchestratorResult) {
      for (const artifact of orchestratorResult.artifacts) {
        if (artifact.content && artifact.path.endsWith(".md")) {
          content += `### ${artifact.path}\n${artifact.content}\n\n`;
        }
      }
    }

    const designerResult = input.previousResults.find((r) => r.agent === "designer");
    if (designerResult) {
      for (const artifact of designerResult.artifacts) {
        if (artifact.content && artifact.path.endsWith(".json")) {
          content += `### ${artifact.path}\n\`\`\`json\n${artifact.content}\n\`\`\`\n\n`;
        }
      }
    }

    if (input.context.tasks.length > 0) {
      const coderTasks = input.context.tasks.filter((t) => t.assignee === "coder");
      content += `## Implementation Tasks\n`;
      for (const task of coderTasks) {
        content += `- **${task.title}** (${task.priority}): ${task.description}\n`;
        if (task.acceptanceCriteria.length > 0) {
          content += `  Acceptance: ${task.acceptanceCriteria.join("; ")}\n`;
        }
      }
    }

    return content;
  }

  // ── Helpers ───────────────────────────────────────────

  private buildSystemPrompt(input: AgentInput): string {
    let prompt = buildCoderSystemPrompt(input.context.techStackId);
    if (input.memoryContext) prompt += input.memoryContext;
    if (input.lessons) prompt += input.lessons;
    return prompt;
  }

  /**
   * Extract file paths mentioned in QA feedback (e.g., "[src/App.tsx]")
   */
  private extractFilesFromFeedback(feedback: string): string[] {
    const paths = new Set<string>();
    const regex = /\[([^\]]+\.\w+)\]/g;
    let match;
    while ((match = regex.exec(feedback)) !== null) {
      paths.add(match[1]);
    }
    return Array.from(paths);
  }

  /**
   * Read actual files from the project directory on disk.
   */
  private async readFilesFromDisk(
    outputDir: string,
    relativePaths: string[]
  ): Promise<Array<{ path: string; content: string }>> {
    const results: Array<{ path: string; content: string }> = [];
    for (const relPath of relativePaths) {
      const fullPath = join(outputDir, relPath);
      if (existsSync(fullPath)) {
        try {
          const content = await readFile(fullPath, "utf-8");
          results.push({ path: relPath, content });
        } catch {
          // skip unreadable files
        }
      }
    }
    return results;
  }

  private maybeAddPackageJson(artifacts: Artifact[], json: Record<string, unknown>, projectName: string): void {
    if (!json.dependencies) return;
    const deps = json.dependencies as Record<string, Record<string, string>>;
    const existing = artifacts.find((a) => a.path === "package.json");
    if (existing) return;

    const packageJson = {
      name: projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      version: "0.1.0",
      type: "module",
      scripts: {
        dev: "vite",
        build: "tsc -b && vite build",
        preview: "vite preview",
        test: "vitest run",
        "test:watch": "vitest",
        "test:e2e": "playwright test",
        lint: "eslint src/",
      },
      dependencies: deps.production ?? {},
      devDependencies: deps.dev ?? {},
    };
    artifacts.push({
      type: "file", path: "package.json",
      content: JSON.stringify(packageJson, null, 2),
      description: "Project package.json with dependencies",
    });
  }

  private addUsage(
    total: { promptTokens: number; completionTokens: number; totalTokens: number },
    usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  ): void {
    total.promptTokens += usage.promptTokens;
    total.completionTokens += usage.completionTokens;
    total.totalTokens += usage.totalTokens;
  }

  // ── Base class overrides (used only as fallback) ──────

  protected buildMessages(input: AgentInput): LLMMessage[] {
    // Not used in multi-phase execution, but kept for compatibility
    return [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: input.projectDescription },
    ];
  }

  protected getLLMOptions(): LLMOptions {
    return { maxTokens: 16384, responseFormat: "json" };
  }

  protected async parseResponse(
    raw: string,
    _input: AgentInput
  ): Promise<AgentResult> {
    const json = JSON.parse(this.extractJSON(raw));
    const artifacts: Artifact[] = [];
    if (json.files && Array.isArray(json.files)) {
      for (const file of json.files) {
        artifacts.push({ type: "file", path: file.path, content: file.content, description: file.description ?? "" });
      }
    }
    this.maybeAddPackageJson(artifacts, json, _input.context.projectName);
    return {
      agent: this.role, stage: this.stage, status: "success", artifacts,
      summary: json.summary ?? `Generated ${artifacts.length} files`,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      timestamp: new Date().toISOString(),
    };
  }
}
