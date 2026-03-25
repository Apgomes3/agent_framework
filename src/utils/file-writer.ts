import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { Artifact } from "../core/types.js";
import { logger } from "./logger.js";

/**
 * Writes an artifact to disk, creating directories as needed.
 */
export async function writeArtifact(
  outputDir: string,
  artifact: Artifact
): Promise<void> {
  if (artifact.type === "directory") {
    const dirPath = join(outputDir, artifact.path);
    await mkdir(dirPath, { recursive: true });
    logger.debug(`Created directory: ${artifact.path}`);
    return;
  }

  if (!artifact.content) {
    logger.warn(`Artifact ${artifact.path} has no content, skipping`);
    return;
  }

  const filePath = join(outputDir, artifact.path);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, artifact.content, "utf-8");
  logger.debug(`Wrote file: ${artifact.path}`);
}

/**
 * Writes all artifacts from a result to disk.
 */
export async function writeArtifacts(
  outputDir: string,
  artifacts: Artifact[]
): Promise<void> {
  for (const artifact of artifacts) {
    await writeArtifact(outputDir, artifact);
  }
  logger.info(`Wrote ${artifacts.length} artifacts to ${outputDir}`);
}

/**
 * Read a file from the output directory. Returns undefined if not found.
 */
export async function readProjectFile(
  outputDir: string,
  relativePath: string
): Promise<string | undefined> {
  const filePath = join(outputDir, relativePath);
  if (!existsSync(filePath)) return undefined;
  return readFile(filePath, "utf-8");
}
