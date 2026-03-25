import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { LLMClient, LLMMessage, LLMOptions, LLMProvider, LLMResponse } from "./types.js";
import { logger } from "../utils/logger.js";

// ── OpenAI Adapter ─────────────────────────────────────────

export class OpenAIClient implements LLMClient {
  public readonly provider: LLMProvider = "openai";
  private client: OpenAI;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel = "gpt-5.3-codex") {
    this.client = new OpenAI({ apiKey });
    this.defaultModel = defaultModel;
  }

  async chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;
    logger.debug(`OpenAI request: model=${model}, messages=${messages.length}`);

    const response = await this.client.chat.completions.create({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.responseFormat === "json" && {
        response_format: { type: "json_object" },
      }),
    });

    const choice = response.choices[0];
    if (!choice?.message?.content) {
      throw new Error("OpenAI returned empty response");
    }

    const usage = response.usage;
    return {
      content: choice.message.content,
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      },
      model,
    };
  }
}

// ── Anthropic Adapter ──────────────────────────────────────

export class AnthropicClient implements LLMClient {
  public readonly provider: LLMProvider = "anthropic";
  private client: Anthropic;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel = "claude-sonnet-4-20250514") {
    this.client = new Anthropic({ apiKey });
    this.defaultModel = defaultModel;
  }

  async chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;
    logger.debug(`Anthropic request: model=${model}, messages=${messages.length}`);

    // Anthropic uses a separate system parameter
    const systemMessage = messages.find((m) => m.role === "system");
    const chatMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    const response = await this.client.messages.create({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      ...(systemMessage && { system: systemMessage.content }),
      messages: chatMessages,
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Anthropic returned empty response");
    }

    return {
      content: textBlock.text,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      model,
    };
  }
}

// ── Gemini Adapter ─────────────────────────────────────────

export class GeminiClient implements LLMClient {
  public readonly provider: LLMProvider = "gemini";
  private client: GoogleGenerativeAI;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel = "gemini-3.1") {
    this.client = new GoogleGenerativeAI(apiKey);
    this.defaultModel = defaultModel;
  }

  async chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;
    logger.debug(`Gemini request: model=${model}, messages=${messages.length}`);

    const genModel = this.client.getGenerativeModel({
      model,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? 4096,
        ...(options?.responseFormat === "json" && {
          responseMimeType: "application/json",
        }),
      },
    });

    // Gemini uses a system instruction + chat history model
    const systemMessage = messages.find((m) => m.role === "system");
    const chatMessages = messages.filter((m) => m.role !== "system");

    // Build Gemini Content format
    const history = chatMessages.slice(0, -1).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const lastMessage = chatMessages[chatMessages.length - 1];

    const chat = genModel.startChat({
      history,
      ...(systemMessage && {
        systemInstruction: { role: "system", parts: [{ text: systemMessage.content }] },
      }),
    });

    const result = await chat.sendMessage(lastMessage.content);
    const response = result.response;
    const text = response.text();

    if (!text) {
      throw new Error("Gemini returned empty response");
    }

    const usage = response.usageMetadata;
    return {
      content: text,
      usage: {
        promptTokens: usage?.promptTokenCount ?? 0,
        completionTokens: usage?.candidatesTokenCount ?? 0,
        totalTokens: usage?.totalTokenCount ?? 0,
      },
      model,
    };
  }
}

// ── Factory ────────────────────────────────────────────────

export function createLLMClient(
  provider: LLMProvider,
  apiKey: string,
  defaultModel?: string
): LLMClient {
  switch (provider) {
    case "openai":
      return new OpenAIClient(apiKey, defaultModel);
    case "anthropic":
      return new AnthropicClient(apiKey, defaultModel);
    case "gemini":
      return new GeminiClient(apiKey, defaultModel);
    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}
