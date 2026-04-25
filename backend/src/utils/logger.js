const IS_JSON_ENV = ['production', 'prod', 'staging'].includes(
  (process.env.APP_ENV || process.env.NODE_ENV || '').toLowerCase()
);

function write(level, message, context) {
  const entry = {
    level,
    time: new Date().toISOString(),
    message,
    ...(context && typeof context === 'object' ? context : {})
  };

  if (IS_JSON_ENV) {
    process.stdout.write(JSON.stringify(entry) + '\n');
  } else {
    const extra = context ? ' ' + JSON.stringify(context) : '';
    const line = `[${level.toUpperCase()}] ${entry.time} ${message}${extra}`;
    if (level === 'error') {
      console.error(line); // eslint-disable-line no-console
    } else if (level === 'warn') {
      console.warn(line);  // eslint-disable-line no-console
    } else {
      console.log(line);   // eslint-disable-line no-console
    }
  }
}

export const logger = {
  info:  (msg, ctx) => write('info',  msg, ctx),
  warn:  (msg, ctx) => write('warn',  msg, ctx),
  error: (msg, ctx) => write('error', msg, ctx),
  debug: (msg, ctx) => write('debug', msg, ctx),
};
