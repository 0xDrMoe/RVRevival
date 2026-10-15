// A small logger that prints one line per message and never prints the bot token.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Discord bot tokens look like three dot-separated base64 chunks.
const TOKEN_PATTERN = /[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,40}/g;

const secrets = new Set();

// Remember a secret (the bot token) so it is blanked out of every log line.
export function registerSecret(secret) {
  if (secret && secret.length >= 8) {
    secrets.add(secret);
  }
}

export function redact(text) {
  let result = text.replace(TOKEN_PATTERN, "[REDACTED]");
  for (const secret of secrets) {
    result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}

export function parseLogLevel(value) {
  const level = value?.trim().toLowerCase();
  return level in LEVELS ? level : "info";
}

// Turns errors into plain objects so JSON.stringify keeps their details.
function toLoggable(_key, value) {
  if (value instanceof Error) {
    const { name, message, code, status, method, url, stack } = value;
    return { name, message, code, status, method, url, stack };
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

function formatDetails(details) {
  if (!details || Object.keys(details).length === 0) {
    return "";
  }
  try {
    return " " + JSON.stringify(details, toLoggable);
  } catch {
    return " {\"details\":\"<could not be printed>\"}";
  }
}

export function createLogger(minimumLevel = parseLogLevel(process.env.LOG_LEVEL)) {
  function write(level, message, details) {
    if (LEVELS[level] < LEVELS[minimumLevel]) {
      return;
    }
    const time = new Date().toISOString();
    const line = redact(`${time} ${level.toUpperCase().padEnd(5)} ${message}${formatDetails(details)}`);
    if (level === "warn" || level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (message, details) => write("debug", message, details),
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details),
  };
}

export const logger = createLogger();
