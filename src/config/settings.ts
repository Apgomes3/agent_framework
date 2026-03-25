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
    projectsDir: "../projects",
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
    try {
      const raw = await readFile(filePath, "utf-8");
      const fileConfig = JSON.parse(raw) as Partial<AgentFrameworkConfig>;
      config = mergeConfig(config, fileConfig);
    } catch (err) {
      throw new Error(`Failed to parse config file "${filePath}": ${(err as Error).message}`);
    }
  }

  // Override with env vars
  const openaiKey = process.env["OPENAI_API_KEY"];
  if (openaiKey) {
    config.providers.openai = {
      apiKey: openaiKey,
      defaultModel: config.providers.openai?.defaultModel ?? "gpt-5.3-chat-latest",
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
        config.providers.gemini?.defaultModel ?? "gemini-3.1-pro-preview",
    };
  }

  const defaultProvider = process.env["DEFAULT_LLM_PROVIDER"] as LLMProvider | undefined;
  if (defaultProvider) {
    config.defaults.provider = defaultProvider;
  }

  const projectsDir = process.env["PROJECTS_DIR"];
  if (projectsDir) {
    config.defaults.projectsDir = projectsDir;
  }

  // Validate that at least the default provider has an API key
  validateConfig(config);

  return config;
}

/**
 * Validate config has usable API keys for the providers it references.
 * Throws early with a clear message instead of failing mid-pipeline.
 */
function validateConfig(config: AgentFrameworkConfig): void {
  const defaultProvider = config.defaults.provider;
  const providerConfig = config.providers[defaultProvider];

  if (!providerConfig?.apiKey) {
    const envVarMap: Record<LLMProvider, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      gemini: "GOOGLE_API_KEY",
    };
    throw new Error(
      `No API key for default provider "${defaultProvider}". ` +
      `Set ${envVarMap[defaultProvider]} in your environment or .env file.\n` +
      `See .env.example for the required variables.`
    );
  }

  // Warn about agent-specific providers that lack keys
  for (const [role, agentModel] of Object.entries(config.agentModels)) {
    if (agentModel && !config.providers[agentModel.provider]?.apiKey) {
      const envVarMap: Record<LLMProvider, string> = {
        openai: "OPENAI_API_KEY",
        anthropic: "ANTHROPIC_API_KEY",
        gemini: "GOOGLE_API_KEY",
      };
      throw new Error(
        `Agent "${role}" is configured to use provider "${agentModel.provider}" but no API key is set. ` +
        `Set ${envVarMap[agentModel.provider]} in your environment.`
      );
    }
  }
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
