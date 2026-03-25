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
   */
  protected extractJSON(raw: string): string {
    // Strip ```json ... ``` blocks
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return match[1].trim();

    // Try to find raw JSON object/array
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1) {
      return raw.slice(jsonStart, jsonEnd + 1);
    }

    return raw.trim();
  }
}
