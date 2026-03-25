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

const SYSTEM_PROMPT = `You are a senior QA engineer specializing in TypeScript/React applications. Review generated code and produce a quality report.

## Your outputs

1. **Issues list** — Flag bugs, security issues (OWASP Top 10), type errors, accessibility violations. Be concise: one line per issue.

2. **Test stubs** — Generate SHORT Vitest test files (describe blocks with it() stubs and one real assertion each). Max 40 lines per test file. Focus on critical paths only.

3. **One E2E test** — Single Playwright spec for the most critical user flow only. Max 50 lines.

4. **Code review** — 3-5 sentences max overall assessment.

## Output format — single complete valid JSON:
{
  "passed": true | false,
  "issues": [
    {
      "id": "issue-001",
      "severity": "error" | "warning" | "info",
      "category": "typescript" | "security" | "accessibility" | "best-practice",
      "file": "src/App.tsx",
      "line": 42,
      "message": "brief description",
      "suggestion": "how to fix"
    }
  ],
  "testFiles": [
    { "path": "src/__tests__/App.test.tsx", "content": "concise test stub", "description": "App tests" }
  ],
  "e2eTests": [
    { "path": "e2e/critical.spec.ts", "content": "concise e2e test", "description": "Critical flow" }
  ],
  "codeReview": "3-5 sentence review",
  "testResults": { "total": 0, "passed": 0, "failed": 0, "skipped": 0 },
  "summary": "one line summary"
}

## Rules
- "passed": false only if there are "error" severity issues
- Keep ALL string values short — this is a report, not a full implementation
- Do not reproduce the entire source code in your response`;

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

    // Include ALL generated code — deduplicated by path (latest wins)
    const allCodeArtifacts = new Map<string, { content: string; path: string }>();
    const coderResult = input.previousResults.find((r) => r.agent === "coder");
    if (coderResult) {
      for (const a of coderResult.artifacts) {
        if (a.content) allCodeArtifacts.set(a.path, { path: a.path, content: a.content });
      }
    }
    for (const a of input.context.codeArtifacts) {
      if (a.content) allCodeArtifacts.set(a.path, { path: a.path, content: a.content });
    }

    if (allCodeArtifacts.size > 0) {
      userContent += `## Code to Review\n\n`;
      for (const artifact of allCodeArtifacts.values()) {
        const ext = artifact.path.split(".").pop() ?? "";
        userContent += `### ${artifact.path}\n\`\`\`${ext}\n${artifact.content}\n\`\`\`\n\n`;
      }
    }

    if (input.humanFeedback) {
      userContent += `\n## Review Feedback\nPlease pay special attention to:\n${input.humanFeedback}`;
    }

    messages.push({ role: "user", content: userContent });
    return messages;
  }

  protected getLLMOptions(): LLMOptions {
    return { temperature: 0.3, maxTokens: 32000, responseFormat: "json" };
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
