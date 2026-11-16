import { loadConfig, tokenFilePath } from './config.js';
import { buildServer } from './server.js';

// `pnpm dev` sets this so development never touches the real ~/CreatorHub by accident.
if (process.env['CREATORHUB_REQUIRE_HOME'] === '1' && !process.env['CREATORHUB_HOME']) {
  process.stderr.write(
    'CREATORHUB_HOME is required in dev, e.g. CREATORHUB_HOME="$(mktemp -d)" pnpm dev\n',
  );
  process.exit(2);
}

const config = loadConfig();
const { app } = await buildServer({ config, logger: true });

const shutdown = (signal: string): void => {
  app.log.info({ signal }, 'shutting down');
  app.close().then(
    () => process.exit(0),
    (err: unknown) => {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    },
  );
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// Log the cause before dying so launchd restarts leave a trace in the log.
// State may be inconsistent after an uncaught error, so do not keep serving.
const fatal = (kind: string) => (err: unknown) => {
  app.log.fatal({ err, kind }, 'fatal error, exiting');
  process.exit(1);
};
process.on('uncaughtException', fatal('uncaughtException'));
process.on('unhandledRejection', fatal('unhandledRejection'));

await app.listen({ host: config.host, port: config.port });
app.log.info(
  {
    home: config.home,
    token:
      config.tokenSource === 'env' ? 'from CREATORHUB_TOKEN' : `from ${tokenFilePath(config.home)}`,
  },
  'creatorhub mac-server ready',
);
