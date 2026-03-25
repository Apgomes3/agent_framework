import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AgentFrameworkConfig, LLMProvider } from "../core/types.js";

const CONFIG_FILE = "agent-framework.config.json";

const DEFAULT_CONFIG: AgentFrameworkConfig = {
  providers: {},
  agentModels: {},
  defaults: {
    provider: "openai",
    maxRetries: 3,
    outputDir: "./output",
  },
};

/**
 * Load config from file, environment variables, or defaults.
 * Priority: env vars > config file > defaults
 */
export async function loadConfig(
  configPath?: string
): Promise<AgentFrameworkConfig> {
  let config = { ...DEFAULT_CONFIG };

  // Try loading config file
  const filePath = configPath ?? CONFIG_FILE;
  if (existsSync(filePath)) {
    const raw = await readFile(filePath, "utf-8");
    const fileConfig = JSON.parse(raw) as Partial<AgentFrameworkConfig>;
    config = mergeConfig(config, fileConfig);
  }

  // Override with env vars
  const openaiKey = process.env["OPENAI_API_KEY"];
  if (openaiKey) {
    config.providers.openai = {
      apiKey: openaiKey,
      defaultModel: config.providers.openai?.defaultModel ?? "gpt-5.3-codex",
    };
  }

  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  if (anthropicKey) {
    config.providers.anthropic = {
      apiKey: anthropicKey,
      defaultModel:
        config.providers.anthropic?.defaultModel ?? "claude-sonnet-4-20250514",
    };
  }

  const geminiKey = process.env["GOOGLE_API_KEY"];
  if (geminiKey) {
    config.providers.gemini = {
      apiKey: geminiKey,
      defaultModel:
        config.providers.gemini?.defaultModel ?? "gemini-3.1",
    };
  }

  const defaultProvider = process.env["DEFAULT_LLM_PROVIDER"] as LLMProvider | undefined;
  if (defaultProvider) {
    config.defaults.provider = defaultProvider;
  }

  return config;
}

function mergeConfig(
  base: AgentFrameworkConfig,
  override: Partial<AgentFrameworkConfig>
): AgentFrameworkConfig {
  return {
    providers: { ...base.providers, ...override.providers },
    agentModels: { ...base.agentModels, ...override.agentModels },
    defaults: { ...base.defaults, ...override.defaults },
  };
}

/**
 * Resolve the API key and model for a specific provider.
 */
export function resolveProviderConfig(
  config: AgentFrameworkConfig,
  provider: LLMProvider
): { apiKey: string; model: string } {
  const providerConfig = config.providers[provider];
  if (!providerConfig?.apiKey) {
    const envVarMap: Record<LLMProvider, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      gemini: "GOOGLE_API_KEY",
    };
    throw new Error(
      `No API key configured for ${provider}. Set ${envVarMap[provider]} env var or add it to ${CONFIG_FILE}`
    );
  }
  return { apiKey: providerConfig.apiKey, model: providerConfig.defaultModel };
}
