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

    // Inject memory context (compact prior-stage summary) into the system prompt
    if (input.memoryContext && messages.length > 0 && messages[0].role === "system") {
      messages[0] = {
        ...messages[0],
        content: messages[0].content + input.memoryContext,
      };
    }

    // Inject lessons learned into the system prompt
    if (input.lessons && messages.length > 0 && messages[0].role === "system") {
      messages[0] = {
        ...messages[0],
        content: messages[0].content + input.lessons,
      };
    }

    const options = this.getLLMOptions();

    const response = await this.llmClient.chat(messages, options);
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
