import { Agent } from "../core/agent.js";
import type {
  AgentInput,
  AgentResult,
  AgentRole,
  Artifact,
  LLMMessage,
  LLMOptions,
  Stage,
} from "../core/types.js";

const SYSTEM_PROMPT = `You are a senior full-stack TypeScript developer. Your job is to generate production-quality source code for a React + Express web application.

## Tech Stack
- Frontend: React 19, TypeScript, Vite, **@vitejs/plugin-react** (always include in devDependencies), Fluent UI (@fluentui/react-components), Zustand, React Hook Form + Zod, TanStack Query, React Router DOM
- Backend: Express.js with TypeScript, Zod request validation
- Testing: Vitest (unit), Playwright (e2e)

## Code quality rules
- Strict TypeScript (no \`any\`)
- Functional components with hooks only
- Every page/component file must have a default export — never use only named exports for components imported in routing or App.tsx
- Proper error boundaries
- Loading and error states for async operations
- Accessible markup (semantic HTML, ARIA)
- Input validation with Zod at API boundaries
- Structured folders: features/, components/, hooks/, stores/, api/, types/
- Barrel exports (index.ts per folder)
- Environment variables via import.meta.env (frontend) and process.env (backend)

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
1. Start with config files: package.json, tsconfig.json, vite.config.ts, .eslintrc
2. App shell: App.tsx, main.tsx, router setup
3. Shared: types, api client, stores, design tokens integration
4. Features: pages, components per feature
5. API: routes, controllers, services, middleware`;

export class CoderAgent extends Agent {
  readonly role: AgentRole = "coder";
  readonly stage: Stage = "code";

  protected buildMessages(input: AgentInput): LLMMessage[] {
    const messages: LLMMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    let userContent = `## Project: ${input.context.projectName}\n\n`;
    userContent += `## Description\n${input.projectDescription}\n\n`;

    // Include orchestrator spec
    const orchestratorResult = input.previousResults.find(
      (r) => r.agent === "orchestrator"
    );
    if (orchestratorResult) {
      for (const artifact of orchestratorResult.artifacts) {
        if (artifact.content && artifact.path.endsWith(".md")) {
          userContent += `### ${artifact.path}\n${artifact.content}\n\n`;
        }
      }
    }

    // Include design artifacts
    const designerResult = input.previousResults.find(
      (r) => r.agent === "designer"
    );
    if (designerResult) {
      for (const artifact of designerResult.artifacts) {
        if (artifact.content && artifact.path.endsWith(".json")) {
          userContent += `### ${artifact.path}\n\`\`\`json\n${artifact.content}\n\`\`\`\n\n`;
        }
      }
    }

    // Include coder tasks
    if (input.context.tasks.length > 0) {
      const coderTasks = input.context.tasks.filter(
        (t) => t.assignee === "coder"
      );
      userContent += `## Implementation Tasks\n`;
      for (const task of coderTasks) {
        userContent += `- **${task.title}** (${task.priority}): ${task.description}\n`;
        if (task.acceptanceCriteria.length > 0) {
          userContent += `  Acceptance: ${task.acceptanceCriteria.join("; ")}\n`;
        }
      }
    }

    if (input.humanFeedback) {
      userContent += `\n## Fix Instructions\nPlease fix these issues:\n${input.humanFeedback}`;
    }

    messages.push({ role: "user", content: userContent });
    return messages;
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

    // Source files
    if (json.files && Array.isArray(json.files)) {
      for (const file of json.files) {
        artifacts.push({
          type: "file",
          path: file.path,
          content: file.content,
          description: file.description ?? "",
        });
      }
    }

    // If dependencies were specified, generate/update package.json
    if (json.dependencies) {
      const packageJson = {
        name: _input.context.projectName
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-"),
        version: "0.1.0",
        type: "module",
        scripts: {
          dev: "vite",
          build: "tsc && vite build",
          preview: "vite preview",
          test: "vitest run",
          "test:watch": "vitest",
          "test:e2e": "playwright test",
          lint: "eslint src/",
        },
        dependencies: json.dependencies.production ?? {},
        devDependencies: json.dependencies.dev ?? {},
      };

      // Check if package.json is already in artifacts
      const existing = artifacts.find((a) => a.path === "package.json");
      if (!existing) {
        artifacts.push({
          type: "file",
          path: "package.json",
          content: JSON.stringify(packageJson, null, 2),
          description: "Project package.json with dependencies",
        });
      }
    }

    return {
      agent: this.role,
      stage: this.stage,
      status: "success",
      artifacts,
      summary: json.summary ?? `Generated ${artifacts.length} files`,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      timestamp: new Date().toISOString(),
    };
  }
}
