#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import { resolve } from "node:path";
import chalk from "chalk";
import { Pipeline } from "./core/pipeline.js";
import type { AgentRole, LLMClient } from "./core/types.js";
import { Agent } from "./core/agent.js";
import { loadConfig } from "./config/settings.js";
import { StateManager } from "./core/state.js";
import { logger } from "./utils/logger.js";
import { OrchestratorAgent } from "./agents/orchestrator.js";
import { DesignerAgent } from "./agents/designer.js";
import { CoderAgent } from "./agents/coder.js";
import { QAAgent } from "./agents/qa.js";

const program = new Command();

program
  .name("agent-framework")
  .description("Multi-agent orchestration system for building full-stack web apps")
  .version("0.1.0");

// ── create ─────────────────────────────────────────────────

program
  .command("create")
  .description("Create a new app project from a description")
  .argument("<description>", "Natural-language description of the app to build")
  .option("-n, --name <name>", "Project name")
  .option("-o, --output <dir>", "Output directory")
  .option("-p, --provider <provider>", "LLM provider (openai | anthropic)")
  .option("-c, --config <path>", "Path to config file")
  .action(async (description: string, options: Record<string, string>) => {
    try {
      const config = await loadConfig(options["config"]);

      if (options["provider"]) {
        config.defaults.provider = options["provider"] as "openai" | "anthropic";
      }

      const projectName =
        options["name"] ?? slugify(description.slice(0, 50));
      const outputDir = resolve(
        options["output"] ?? `./output/${projectName}`
      );

      const pipeline = new Pipeline(outputDir, config, createAgent);
      await pipeline.create(projectName, description);
    } catch (err) {
      logger.error(chalk.red(`Failed: ${err}`));
      process.exit(1);
    }
  });

// ── resume ─────────────────────────────────────────────────

program
  .command("resume")
  .description("Resume a project from its last checkpoint")
  .argument("<dir>", "Path to the project output directory")
  .option("-c, --config <path>", "Path to config file")
  .action(async (dir: string, options: Record<string, string>) => {
    try {
      const config = await loadConfig(options["config"]);
      const outputDir = resolve(dir);

      const pipeline = new Pipeline(outputDir, config, createAgent);
      await pipeline.resume();
    } catch (err) {
      logger.error(chalk.red(`Failed: ${err}`));
      process.exit(1);
    }
  });

// ── status ─────────────────────────────────────────────────

program
  .command("status")
  .description("Show the current status of a project")
  .argument("<dir>", "Path to the project output directory")
  .action(async (dir: string) => {
    try {
      const outputDir = resolve(dir);
      const stateManager = new StateManager(outputDir);
      const loaded = await stateManager.load();

      if (!loaded) {
        console.log(chalk.yellow("No project state found at this path."));
        return;
      }

      const state = stateManager.getState();

      console.log(chalk.bold.cyan(`\n📋 Project: ${state.projectName}\n`));
      console.log(`  Stage:       ${chalk.bold(state.currentStage)}`);
      console.log(`  Created:     ${state.createdAt}`);
      console.log(`  Updated:     ${state.updatedAt}`);
      console.log(`  Tasks:       ${state.tasks.length}`);
      console.log(
        `  Total tokens: ${state.tokenUsage.total.totalTokens}`
      );

      if (state.history.length > 0) {
        console.log(chalk.bold("\n  Stage History:"));
        for (const exec of state.history) {
          const icon =
            exec.status === "completed"
              ? chalk.green("✓")
              : exec.status === "failed"
                ? chalk.red("✗")
                : chalk.yellow("⟳");
          console.log(
            `    ${icon} ${exec.stage} (${exec.agent}) — ${exec.status}`
          );
        }
      }

      console.log();
    } catch (err) {
      logger.error(chalk.red(`Failed: ${err}`));
      process.exit(1);
    }
  });

// ── Agent factory ──────────────────────────────────────────

function createAgent(role: AgentRole, llmClient: LLMClient): Agent {
  switch (role) {
    case "orchestrator":
      return new OrchestratorAgent(llmClient);
    case "designer":
      return new DesignerAgent(llmClient);
    case "coder":
      return new CoderAgent(llmClient);
    case "qa":
      return new QAAgent(llmClient);
    default:
      throw new Error(`Unknown agent role: ${role}`);
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

program.parse();
