import winston from "winston";

export const logger = winston.createLogger({
  level: process.env["LOG_LEVEL"] ?? "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase().padEnd(5)}] ${message}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

/** Add a file transport for persisting logs to the output project dir */
export function addFileTransport(logFilePath: string): void {
  logger.add(
    new winston.transports.File({
      filename: logFilePath,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    })
  );
}
