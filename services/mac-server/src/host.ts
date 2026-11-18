import { buildServer, type BuildServerOptions, type CreatorHubServer } from './server.js';

export interface ServerHost {
  /** The running server (a new instance after each reload). */
  current(): CreatorHubServer;
  /** `http://host:port` the server listens on; the same across reloads. */
  readonly address: string;
  /** Settles when the reload in progress (if any) is done. */
  settled(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Run the server and let it reload itself in place (QC-030): a restore closes
 * everything (jobs, AI runner, mounts, database), the next build applies the
 * pending restore, and the new server listens on the same address. If the
 * rebuild fails, `onFatal` decides (main exits so launchd restarts the
 * service; the restore marker is applied again on that start).
 */
export async function startHost(
  options: Omit<BuildServerOptions, 'reload'>,
  listen: { host: string; port: number },
  onFatal: (err: unknown) => void,
): Promise<ServerHost> {
  let server: CreatorHubServer;
  let reloading: Promise<void> = Promise.resolve();
  let closed = false;
  let port = listen.port;

  const build = async (): Promise<string> => {
    server = await buildServer({ ...options, reload });
    const address = await server.app.listen({ host: listen.host, port });
    const bound = server.app.server.address();
    if (bound !== null && typeof bound === 'object') port = bound.port;
    return address;
  };

  function reload(afterResponse: Promise<void>): void {
    if (closed) return;
    reloading = reloading.then(async () => {
      try {
        await afterResponse;
        server.app.log.info('reloading on the restored database');
        await server.app.close();
        if (!closed) await build();
      } catch (err) {
        onFatal(err);
      }
    });
  }

  const address = await build();
  return {
    current: () => server,
    address,
    settled: () => reloading,
    close: async () => {
      closed = true;
      await reloading;
      await server.app.close();
    },
  };
}
