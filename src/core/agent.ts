import type {
  AgentInput,
  AgentResult,
  AgentRole,
  LLMClient,
  LLMMessage,
  LLMOptions,
  Stage,
} from "./types.js";
import { logger } from "../utils/logger.js";

/**
 * Base class for all agents in the pipeline.
 * Each agent has a role, a system prompt, and an LLM client.
 * Subclasses implement `buildMessages()` and `parseResponse()`.
 */
export abstract class Agent {
  abstract readonly role: AgentRole;
  abstract readonly stage: Stage;

  constructor(protected llmClient: LLMClient) {}

  /**
   * Main execution method. Builds messages, calls LLM, parses result.
   */
  async execute(input: AgentInput): Promise<AgentResult> {
    const startTime = Date.now();
    logger.info(`[${this.role}] Starting execution...`);

    const messages = this.buildMessages(input);

    // Inject memory context and lessons into system prompt with token budget
    if (messages.length > 0 && messages[0].role === "system") {
      const options = this.getLLMOptions();
      const maxOutputTokens = options.maxTokens ?? 4096;
      // Reserve ~80% of a 128k context window for content, minus output tokens
      const TOKEN_BUDGET = 100_000 - maxOutputTokens;
      const baseTokens = this.estimateTokens(messages[0].content);
      const userTokens = messages.slice(1).reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      let remaining = TOKEN_BUDGET - baseTokens - userTokens;

      if (input.memoryContext && remaining > 0) {
        const memoryTokens = this.estimateTokens(input.memoryContext);
        if (memoryTokens <= remaining) {
          messages[0] = { ...messages[0], content: messages[0].content + input.memoryContext };
          remaining -= memoryTokens;
        } else {
          // Truncate memory context to fit budget
          const truncated = input.memoryContext.slice(0, remaining * 4);
          messages[0] = { ...messages[0], content: messages[0].content + truncated + "\n[memory truncated]" };
          remaining = 0;
          logger.debug(`[${this.role}] Memory context truncated to fit token budget`);
        }
      }

      if (input.lessons && remaining > 0) {
        const lessonTokens = this.estimateTokens(input.lessons);
        if (lessonTokens <= remaining) {
          messages[0] = { ...messages[0], content: messages[0].content + input.lessons };
        } else {
          const truncated = input.lessons.slice(0, remaining * 4);
          messages[0] = { ...messages[0], content: messages[0].content + truncated + "\n[lessons truncated]" };
          logger.debug(`[${this.role}] Lessons truncated to fit token budget`);
        }
      }
    }

    const llmOptions = this.getLLMOptions();

    const response = await this.llmClient.chat(messages, llmOptions);
    logger.info(
      `[${this.role}] LLM responded (${response.usage.totalTokens} tokens)`
    );

    const result = await this.parseResponse(response.content, input);

    result.tokenUsage = response.usage;
    result.timestamp = new Date().toISOString();
    result.agent = this.role;
    result.stage = this.stage;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(
      `[${this.role}] Completed in ${elapsed}s — status: ${result.status}, artifacts: ${result.artifacts.length}`
    );

    return result;
  }

  /**
   * Build the messages array (system + user) for the LLM call.
   */
  protected abstract buildMessages(input: AgentInput): LLMMessage[];

  /**
   * Parse the raw LLM response into a structured AgentResult.
   */
  protected abstract parseResponse(
    raw: string,
    input: AgentInput
  ): Promise<AgentResult>;

  /**
   * Override to customize LLM options per agent.
   */
  protected getLLMOptions(): LLMOptions {
    return { temperature: 0.7, maxTokens: 4096 };
  }

  /**
   * Rough token estimate: ~4 characters per token on average.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Extract and parse JSON from an LLM response in one step.
   * Wraps extractJSON + JSON.parse with a descriptive error on failure.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected parseJSONFromLLM(raw: string, context?: string): Record<string, any> {
    const jsonStr = this.extractJSON(raw);
    try {
      return JSON.parse(jsonStr);
    } catch (err) {
      const snippet = jsonStr.slice(0, 300);
      const ctx = context ? ` (${context})` : "";
      throw new Error(
        `[${this.role}] Failed to parse LLM JSON response${ctx}: ${(err as Error).message}\n` +
        `Response snippet: ${snippet}...`
      );
    }
  }

  /**
   * Helper to extract JSON from LLM response that may include markdown fencing.
   * Also attempts to repair truncated JSON by closing open structures.
   */
  protected extractJSON(raw: string): string {
    // Strip ```json ... ``` blocks
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return this.repairJSON(match[1].trim());

    // Try to find raw JSON object/array
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1) {
      return this.repairJSON(raw.slice(jsonStart, jsonEnd + 1));
    }

    return this.repairJSON(raw.trim());
  }

  /**
   * Attempt to repair truncated JSON by closing any unclosed structures.
   */
  private repairJSON(raw: string): string {
    // First try as-is
    try { JSON.parse(raw); return raw; } catch {}

    // Truncate at the last complete top-level value before the truncation point
    // by counting open braces/brackets and closing them
    let depth = 0;
    let inString = false;
    let escape = false;
    let lastSafeEnd = -1;

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === '"' && !escape) { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) lastSafeEnd = i;
      }
    }

    // If we have a safe end point, truncate there
    if (lastSafeEnd > 0) {
      const truncated = raw.slice(0, lastSafeEnd + 1);
      try { JSON.parse(truncated); return truncated; } catch {}
    }

    // Last resort: close all open structures
    const stack: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === '"' && !escape) { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") stack.pop();
    }

    // If we ended mid-string, close it
    let repaired = raw;
    if (inString) repaired += '"';
    // Close all open structures in reverse
    repaired += stack.reverse().join("");

    try { JSON.parse(repaired); return repaired; } catch {}

    // Give up and return original
    return raw;
  }
}
