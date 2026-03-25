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
import { getTechStack } from "../core/tech-stacks.js";

const SYSTEM_PROMPT = `You are a senior UI/UX designer specializing in React enterprise applications with Fluent UI. Your job is to produce design artifacts from a project spec and task breakdown.

## Your outputs

1. **wireframes/** — Structured layout specs (JSON) for each main page/view. Describe the layout as regions and components — NOT HTML. Each wireframe is a JSON object like:
{
  "page": "POList",
  "route": "/po",
  "layout": "sidebar-main",
  "regions": {
    "header": { "components": ["PageTitle", "CreateButton", "SearchBar"] },
    "main": { "components": ["DataTable:POTable", "Pagination"] },
    "sidebar": { "components": ["FilterPanel"] }
  },
  "dataFields": ["id", "vendor", "amount", "status", "createdAt"],
  "actions": ["create", "approve", "reject", "view"],
  "notes": "Table has sortable columns. Status uses badge colors."
}

2. **component-tree.json** — Hierarchical component structure:
{ "name": "App", "type": "layout", "description": "Root layout", "props": {}, "children": [...] }
Types: "page", "layout", "component", "hook", "store", "util"

3. **design-tokens.json** — Theme:
{ "colors": { "primary": "#...", "surface": "#...", "text": {...}, "status": {...} }, "typography": { "fontFamily": "...", "size": {...} }, "spacing": {...}, "borderRadius": {...} }

4. **architecture-diagram.md** — One Mermaid diagram showing top-level component and page relationships.

## Output format
Return a single complete valid JSON object. All values must be concise:
{
  "wireframes": [
    { "filename": "po-list.json", "content": "<JSON string of layout spec>", "description": "PO list page" }
  ],
  "componentTree": { ... },
  "designTokens": { ... },
  "architectureDiagram": "mermaid block"
}

## Design principles
- Fluent UI component library (DataGrid, CommandBar, Panel, Dialog, Pivot, MessageBar)
- Role-based views (approver vs requester)
- Accessible and consistent spacing`;

export class DesignerAgent extends Agent {
  readonly role: AgentRole = "designer";
  readonly stage: Stage = "design";

  protected buildMessages(input: AgentInput): LLMMessage[] {
    // Append stack-specific design hints
    const stack = getTechStack(input.context.techStackId);
    const systemContent = SYSTEM_PROMPT + `\n\n## Tech-Specific Design Guidance\n${stack.designerHints}`;

    const messages: LLMMessage[] = [
      { role: "system", content: systemContent },
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
    return { temperature: 0.6, maxTokens: 16000, responseFormat: "json" };
  }

  protected async parseResponse(
    raw: string,
    _input: AgentInput
  ): Promise<AgentResult> {
    const json = this.parseJSONFromLLM(raw, "designer artifacts");

    const artifacts: Artifact[] = [];

    // Wireframes (structured layout specs)
    if (json.wireframes && Array.isArray(json.wireframes)) {
      for (const wireframe of json.wireframes) {
        // Content may be a string (JSON) or an object — normalise to string
        const content =
          typeof wireframe.content === "string"
            ? wireframe.content
            : JSON.stringify(wireframe.content, null, 2);
        artifacts.push({
          type: "file",
          path: `design/wireframes/${wireframe.filename}`,
          content,
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
