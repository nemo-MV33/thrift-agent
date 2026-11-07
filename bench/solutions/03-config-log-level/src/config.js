const LEVELS = ['debug', 'info', 'warn', 'error'];

export function loadConfig(env = process.env) {
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!LEVELS.includes(logLevel)) {
    throw new Error(`Unknown log level: ${logLevel}`);
  }
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? 'localhost',
    logLevel,
    debug: env.DEBUG === '1',
  };
}
