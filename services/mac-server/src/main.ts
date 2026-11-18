import { loadConfig, tokenFilePath } from './config.js';
import { startHost } from './host.js';
import { DEFAULT_LOG_MAX_BYTES, RotatingLogFile, trimFile } from './log-file.js';

// `pnpm dev` sets this so development never touches the real ~/CreatorHub by accident.
if (process.env['CREATORHUB_REQUIRE_HOME'] === '1' && !process.env['CREATORHUB_HOME']) {
  process.stderr.write(
    'CREATORHUB_HOME is required in dev, e.g. CREATORHUB_HOME="$(mktemp -d)" pnpm dev\n',
  );
  process.exit(2);
}

const config = loadConfig();
// Logs: CREATORHUB_LOG_FILE (set by the launchd template) is capped and rotated;
// without it the logger writes to stdout as before (development).
const logMax = Number(process.env['CREATORHUB_LOG_MAX_BYTES'] ?? DEFAULT_LOG_MAX_BYTES);
const logFile = process.env['CREATORHUB_LOG_FILE'];
trimFile(process.env['CREATORHUB_STDERR_FILE'], logMax);
const host = await startHost(
  {
    config,
    logger: true,
    ...(logFile === undefined || logFile === ''
      ? {}
      : { logStream: new RotatingLogFile(logFile, logMax) }),
  },
  { host: config.host, port: config.port },
  (err: unknown) => {
    // A reload that cannot finish: exit so launchd starts a clean process
    // (a pending restore is applied again on that start).
    process.stderr.write(`reload failed: ${String(err)}\n`);
    process.exit(1);
  },
);
const log = () => host.current().app.log;

const shutdown = (signal: string): void => {
  log().info({ signal }, 'shutting down');
  host.close().then(
    () => process.exit(0),
    (err: unknown) => {
      log().error({ err }, 'error during shutdown');
      process.exit(1);
    },
  );
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// Log the cause before dying so launchd restarts leave a trace in the log.
// State may be inconsistent after an uncaught error, so do not keep serving.
const fatal = (kind: string) => (err: unknown) => {
  log().fatal({ err, kind }, 'fatal error, exiting');
  process.exit(1);
};
process.on('uncaughtException', fatal('uncaughtException'));
process.on('unhandledRejection', fatal('unhandledRejection'));

log().info(
  {
    home: config.home,
    token:
      config.tokenSource === 'env' ? 'from CREATORHUB_TOKEN' : `from ${tokenFilePath(config.home)}`,
  },
  'creatorhub mac-server ready',
);
