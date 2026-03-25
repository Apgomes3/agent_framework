import { exec } from "node:child_process";
import { logger } from "./logger.js";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a shell command in the given working directory.
 * Returns stdout/stderr and exit code — never throws.
 */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 120_000
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = exec(command, { cwd, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        exitCode: error?.code ?? (error ? 1 : 0),
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      });
    });

    child.on("error", (err) => {
      logger.warn(`Process error for "${command}": ${err.message}`);
      resolve({ exitCode: 1, stdout: "", stderr: err.message });
    });
  });
}
