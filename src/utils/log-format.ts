
/**
 * Formats a log line into the shape: `[LEVEL] MESSAGE key=value key2=value2`
 */
export function formatLogLine(level: string, message: string, extra?: Record<string, any>): string {
  let logLine = `[${level.toUpperCase()}] ${message}`;
  if (extra) {
    for (const key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) {
        logLine += ` ${key}=${extra[key]}`;
      }
    }
  }
  return logLine;
}
