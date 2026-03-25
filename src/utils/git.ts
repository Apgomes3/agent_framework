import { simpleGit, type SimpleGit } from "simple-git";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.js";

export class GitManager {
  private git!: SimpleGit;

  constructor(private workDir: string) {}

  /** Initialize a new git repository if one doesn't exist */
  async init(): Promise<void> {
    this.git = simpleGit(this.workDir);
    if (!existsSync(join(this.workDir, ".git"))) {
      await this.git.init();
      logger.info("Initialized new git repository");
    }
  }

  /** Stage all changes and commit with a message */
  async commitAll(message: string): Promise<string> {
    await this.git.add(".");
    const result = await this.git.commit(message);
    const hash = result.commit || "initial";
    logger.info(`Committed: ${message} (${hash})`);
    return hash;
  }

  /** Create and checkout a new branch */
  async createBranch(branchName: string): Promise<void> {
    await this.git.checkoutLocalBranch(branchName);
    logger.info(`Created and checked out branch: ${branchName}`);
  }

  /** Checkout an existing branch */
  async checkout(branchName: string): Promise<void> {
    await this.git.checkout(branchName);
  }

  /** Merge a branch into the current branch */
  async merge(branchName: string): Promise<void> {
    await this.git.merge([branchName]);
    logger.info(`Merged branch: ${branchName}`);
  }

  /** Tag the current commit */
  async tag(tagName: string, message?: string): Promise<void> {
    if (message) {
      await this.git.addAnnotatedTag(tagName, message);
    } else {
      await this.git.addTag(tagName);
    }
    logger.info(`Tagged: ${tagName}`);
  }

  /** Get the current branch name */
  async currentBranch(): Promise<string> {
    const status = await this.git.status();
    return status.current ?? "main";
  }
}
