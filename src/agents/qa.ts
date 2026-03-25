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

const SYSTEM_PROMPT = `You are a senior QA engineer specializing in TypeScript/React applications. Your job is to review generated code and produce:

1. **Code Review** — Analyze each file for:
   - TypeScript errors and type safety issues
   - ESLint / code style violations
   - Security vulnerabilities (OWASP Top 10: XSS, injection, auth issues, CSRF)
   - Accessibility problems (missing ARIA, semantic HTML, color contrast)
   - Best practice violations (error handling, loading states, input validation)
   - Performance concerns (unnecessary re-renders, missing memoization)

2. **Unit Tests** — Generate Vitest test files for:
   - Utility functions
   - Custom hooks (with renderHook)
   - Zustand stores
   - API service functions (with mocked fetch)
   - Component rendering (with React Testing Library)

3. **E2E Tests** — Generate Playwright test files for critical user flows

4. **QA Report** — Structured JSON report

## Output format
Return JSON:
{
  "passed": true | false,
  "issues": [
    {
      "id": "issue-001",
      "severity": "error" | "warning" | "info",
      "category": "typescript" | "lint" | "security" | "accessibility" | "best-practice" | "test-failure",
      "file": "src/App.tsx",
      "line": 42,
      "message": "Description of the issue",
      "suggestion": "How to fix it"
    }
  ],
  "testFiles": [
    {
      "path": "src/__tests__/App.test.tsx",
      "content": "full test file content",
      "description": "Tests for App component"
    }
  ],
  "e2eTests": [
    {
      "path": "e2e/navigation.spec.ts",
      "content": "full test file content",
      "description": "Navigation e2e tests"
    }
  ],
  "codeReview": "markdown string — detailed code review",
  "testResults": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0
  },
  "summary": "Brief overall assessment"
}

## Severity guidelines
- **error**: Must fix before shipping (security, crashes, data loss, type errors)
- **warning**: Should fix (accessibility, missing error handling, bad patterns)
- **info**: Nice to fix (style, minor optimizations)

## Assessment
Set "passed" to true if there are no "error" severity issues.`;

export class QAAgent extends Agent {
  readonly role: AgentRole = "qa";
  readonly stage: Stage = "qa";

  protected buildMessages(input: AgentInput): LLMMessage[] {
    const messages: LLMMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    let userContent = `## Project: ${input.context.projectName}\n\n`;
    userContent += `## Description\n${input.projectDescription}\n\n`;

    // Include project spec for context
    const orchestratorResult = input.previousResults.find(
      (r) => r.agent === "orchestrator"
    );
    if (orchestratorResult) {
      const specArtifact = orchestratorResult.artifacts.find(
        (a) => a.path === "docs/project-spec.md"
      );
      if (specArtifact?.content) {
        userContent += `## Requirements\n${specArtifact.content}\n\n`;
      }
    }

    // Include design artifacts for comparison
    const designerResult = input.previousResults.find(
      (r) => r.agent === "designer"
    );
    if (designerResult) {
      const componentTree = designerResult.artifacts.find(
        (a) => a.path === "design/component-tree.json"
      );
      if (componentTree?.content) {
        userContent += `## Expected Component Tree\n\`\`\`json\n${componentTree.content}\n\`\`\`\n\n`;
      }
    }

    // Include ALL generated code for review
    const coderResult = input.previousResults.find(
      (r) => r.agent === "coder"
    );
    if (coderResult) {
      userContent += `## Generated Code (review all files)\n\n`;
      for (const artifact of coderResult.artifacts) {
        if (artifact.content) {
          const ext = artifact.path.split(".").pop() ?? "";
          userContent += `### ${artifact.path}\n\`\`\`${ext}\n${artifact.content}\n\`\`\`\n\n`;
        }
      }
    }

    // Also include any code artifacts written to state (from fix cycles)
    if (input.context.codeArtifacts.length > 0) {
      userContent += `## Additional Code Artifacts\n\n`;
      for (const artifact of input.context.codeArtifacts) {
        if (artifact.content) {
          const ext = artifact.path.split(".").pop() ?? "";
          userContent += `### ${artifact.path}\n\`\`\`${ext}\n${artifact.content}\n\`\`\`\n\n`;
        }
      }
    }

    if (input.humanFeedback) {
      userContent += `\n## Review Feedback\nPlease pay special attention to:\n${input.humanFeedback}`;
    }

    messages.push({ role: "user", content: userContent });
    return messages;
  }

  protected getLLMOptions(): LLMOptions {
    return { temperature: 0.3, maxTokens: 16384, responseFormat: "json" };
  }

  protected async parseResponse(
    raw: string,
    _input: AgentInput
  ): Promise<AgentResult> {
    const json = JSON.parse(this.extractJSON(raw));

    const artifacts: Artifact[] = [];

    // Test files
    if (json.testFiles && Array.isArray(json.testFiles)) {
      for (const testFile of json.testFiles) {
        artifacts.push({
          type: "file",
          path: testFile.path,
          content: testFile.content,
          description: testFile.description,
        });
      }
    }

    // E2E tests
    if (json.e2eTests && Array.isArray(json.e2eTests)) {
      for (const e2eTest of json.e2eTests) {
        artifacts.push({
          type: "file",
          path: e2eTest.path,
          content: e2eTest.content,
          description: e2eTest.description,
        });
      }
    }

    // Code review document
    if (json.codeReview) {
      artifacts.push({
        type: "file",
        path: "docs/code-review.md",
        content: json.codeReview,
        description: "Code review findings",
      });
    }

    // QA report
    const qaReport = {
      passed: json.passed ?? false,
      issues: json.issues ?? [],
      testResults: json.testResults ?? { total: 0, passed: 0, failed: 0, skipped: 0 },
      summary: json.summary ?? "",
    };
    artifacts.push({
      type: "file",
      path: "docs/qa-report.json",
      content: JSON.stringify(qaReport, null, 2),
      description: "QA report",
    });

    // Determine status based on issues
    const errorCount = (json.issues ?? []).filter(
      (i: { severity: string }) => i.severity === "error"
    ).length;
    const status = json.passed && errorCount === 0 ? "success" : "needs_revision";

    // Build a summary of issues for the coder feedback loop
    let summary = json.summary ?? `QA: ${errorCount} errors found`;
    if (status === "needs_revision" && json.issues) {
      const errorIssues = json.issues.filter(
        (i: { severity: string }) => i.severity === "error"
      );
      summary +=
        "\n\nErrors to fix:\n" +
        errorIssues
          .map(
            (i: { file: string; message: string; suggestion?: string }) =>
              `- [${i.file}] ${i.message}${i.suggestion ? ` → ${i.suggestion}` : ""}`
          )
          .join("\n");
    }

    return {
      agent: this.role,
      stage: this.stage,
      status,
      artifacts,
      summary,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      timestamp: new Date().toISOString(),
    };
  }
}
