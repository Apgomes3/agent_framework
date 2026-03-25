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

const SYSTEM_PROMPT = `You are a senior UI/UX designer specializing in React enterprise applications with Fluent UI. Your job is to produce design artifacts from a project spec and task breakdown.

## Your outputs

1. **wireframes/** — HTML/CSS prototype files for each page/view. These should be self-contained HTML files that can be opened in a browser. Use clean, semantic HTML with inline CSS. Include navigation, forms, tables, and other UI elements as described. Use Fluent UI-inspired styling (clean lines, neutral colors, clear typography).

2. **component-tree.json** — Hierarchical component structure:
   { "name": "App", "type": "layout", "description": "Root layout", "props": {}, "children": [...] }
   Types: "page", "layout", "component", "hook", "store", "util"

3. **design-tokens.json** — Theme configuration:
   { "colors": {...}, "typography": { "fontFamily": "...", "fontSize": {...}, "fontWeight": {...} }, "spacing": {...}, "borderRadius": {...} }

4. **architecture-diagram.md** — Mermaid diagrams showing component relationships and data flow.

## Output format
Return JSON:
{
  "wireframes": [
    { "filename": "index.html", "content": "full HTML content", "description": "Home page" }
  ],
  "componentTree": { ... },
  "designTokens": { ... },
  "architectureDiagram": "markdown with mermaid blocks"
}

## Design principles
- Clean, professional enterprise UI
- Responsive layouts (flexbox/grid)
- Accessible (ARIA labels, semantic HTML, color contrast)
- Consistent spacing and typography
- Fluent UI design language: neutral backgrounds, subtle borders, clear hierarchy`;

export class DesignerAgent extends Agent {
  readonly role: AgentRole = "designer";
  readonly stage: Stage = "design";

  protected buildMessages(input: AgentInput): LLMMessage[] {
    const messages: LLMMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    let userContent = `## Project: ${input.context.projectName}\n\n`;
    userContent += `## Description\n${input.projectDescription}\n\n`;

    // Include orchestrator output
    const orchestratorResult = input.previousResults.find(
      (r) => r.agent === "orchestrator"
    );
    if (orchestratorResult) {
      userContent += `## Project Spec & Tasks\n`;
      for (const artifact of orchestratorResult.artifacts) {
        if (artifact.content) {
          userContent += `### ${artifact.path}\n${artifact.content}\n\n`;
        }
      }
    }

    if (input.context.tasks.length > 0) {
      const designTasks = input.context.tasks.filter(
        (t) => t.assignee === "designer"
      );
      userContent += `## Design Tasks\n`;
      for (const task of designTasks) {
        userContent += `- **${task.title}**: ${task.description}\n`;
      }
    }

    if (input.humanFeedback) {
      userContent += `\n## Feedback from Review\nPlease incorporate this feedback:\n${input.humanFeedback}`;
    }

    messages.push({ role: "user", content: userContent });
    return messages;
  }

  protected getLLMOptions(): LLMOptions {
    return { temperature: 0.7, maxTokens: 8192, responseFormat: "json" };
  }

  protected async parseResponse(
    raw: string,
    _input: AgentInput
  ): Promise<AgentResult> {
    const json = JSON.parse(this.extractJSON(raw));

    const artifacts: Artifact[] = [];

    // Wireframes
    if (json.wireframes && Array.isArray(json.wireframes)) {
      for (const wireframe of json.wireframes) {
        artifacts.push({
          type: "file",
          path: `design/wireframes/${wireframe.filename}`,
          content: wireframe.content,
          description: wireframe.description,
        });
      }
    }

    // Component tree
    if (json.componentTree) {
      artifacts.push({
        type: "file",
        path: "design/component-tree.json",
        content: JSON.stringify(json.componentTree, null, 2),
        description: "Component hierarchy",
      });
    }

    // Design tokens
    if (json.designTokens) {
      artifacts.push({
        type: "file",
        path: "design/design-tokens.json",
        content: JSON.stringify(json.designTokens, null, 2),
        description: "Design tokens (colors, typography, spacing)",
      });
    }

    // Architecture diagram
    if (json.architectureDiagram) {
      artifacts.push({
        type: "file",
        path: "design/architecture-diagram.md",
        content: json.architectureDiagram,
        description: "Component architecture diagram",
      });
    }

    return {
      agent: this.role,
      stage: this.stage,
      status: "success",
      artifacts,
      summary: `Produced ${artifacts.length} design artifacts (${json.wireframes?.length ?? 0} wireframes)`,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      timestamp: new Date().toISOString(),
    };
  }
}
