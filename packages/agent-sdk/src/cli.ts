import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiError, createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import {
  WorkAssetRoleSchema,
  WorkStatusSchema,
  WorkTypeSchema,
  type ImportJobRecord,
} from '@qiu-creator/contracts';
import { Command, CommanderError, InvalidArgumentError } from 'commander';

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:7420';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  /** Override client construction (tests). */
  createClient?: (baseUrl: string, token: string) => CreatorHubClient;
}

interface GlobalOptions {
  server?: string;
  token?: string;
  json?: boolean;
}

function parseLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new InvalidArgumentError('limit must be an integer between 1 and 200');
  }
  return n;
}

function parseTags(value: string): string[] {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Build the `creatorhub` program. Every command goes through
 * `@qiu-creator/api-client`; the CLI never touches the Mac filesystem or
 * database directly, so there is exactly one import path into storage.
 */
export function buildProgram(io: CliIo): Command {
  const program = new Command('creatorhub')
    .description('CreatorHub command line for AI agents and scripts')
    .option(
      '--server <url>',
      `Mac server base URL (env CREATORHUB_URL, default ${DEFAULT_SERVER_URL})`,
    )
    .option('--token <token>', 'bearer token (env CREATORHUB_TOKEN)')
    .option('--json', 'print raw JSON responses')
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride();

  const client = (): CreatorHubClient => {
    const opts = program.opts<GlobalOptions>();
    const baseUrl = opts.server ?? io.env['CREATORHUB_URL'] ?? DEFAULT_SERVER_URL;
    const token = opts.token ?? io.env['CREATORHUB_TOKEN'];
    if (token === undefined || token === '') {
      throw new Error('a token is required: pass --token or set CREATORHUB_TOKEN');
    }
    return io.createClient ? io.createClient(baseUrl, token) : createClient({ baseUrl, token });
  };
  const json = (): boolean => program.opts<GlobalOptions>().json === true;

  const works = program.command('works').description('create and list works');

  works
    .command('create')
    .description('create a managed work from a Markdown file')
    .requiredOption('--title <title>', 'work title')
    .requiredOption('--file <path>', 'Markdown file to import')
    .option('--tags <tags>', 'comma-separated tags', parseTags)
    .option('--type <type>', `work type (${WorkTypeSchema.options.join('|')})`)
    .option('--source <source>', 'origin label recorded on the work', 'cli')
    .option(
      '--idempotency-key <key>',
      'reuse to make retries safe: the same key returns the work created the first time (default: a new random key)',
    )
    .action(
      async (opts: {
        title: string;
        file: string;
        tags?: string[];
        type?: string;
        source: string;
        idempotencyKey?: string;
      }) => {
        const markdown = await fs.readFile(opts.file, 'utf8');
        const type = opts.type === undefined ? undefined : WorkTypeSchema.parse(opts.type);
        const work = await client().works.create(
          {
            title: opts.title,
            markdown,
            source: opts.source,
            ...(opts.tags ? { tags: opts.tags } : {}),
            ...(type ? { type } : {}),
          },
          { idempotencyKey: opts.idempotencyKey ?? randomUUID() },
        );
        io.stdout(
          json()
            ? `${JSON.stringify(work, null, 2)}\n`
            : `created ${work.id} revision ${work.current_revision_id}\n`,
        );
      },
    );

  works
    .command('list')
    .description('list works, newest first')
    .option('--q <query>', 'full-text search')
    .option('--status <status>', `filter by status (${WorkStatusSchema.options.join('|')})`)
    .option('--limit <n>', 'page size (1-200)', parseLimit, 50)
    .action(async (opts: { q?: string; status?: string; limit: number }) => {
      const status = opts.status === undefined ? undefined : WorkStatusSchema.parse(opts.status);
      const page = await client().works.list({
        limit: opts.limit,
        ...(opts.q ? { q: opts.q } : {}),
        ...(status ? { status } : {}),
      });
      if (json()) {
        io.stdout(`${JSON.stringify(page, null, 2)}\n`);
        return;
      }
      for (const w of page.items) {
        io.stdout(`${w.id}\t${w.status}\t${w.updated_at}\t${w.title}\n`);
      }
      io.stdout(`${page.items.length} of ${page.total}\n`);
    });

  const describeJob = (job: ImportJobRecord): string =>
    [
      `job ${job.id} ${job.status}`,
      job.result_asset_id === null ? '' : ` asset ${job.result_asset_id}`,
      job.error === null ? '' : ` error ${job.error_code ?? ''}: ${job.error}`,
      '\n',
    ].join('');

  const importCmd = program.command('import').description('import content into CreatorHub');
  importCmd
    .command('url <url>')
    .description('download a public http(s) URL into the asset library (runs as a background job)')
    .option('--filename <name>', 'file name to store (default: from the server or URL)')
    .option('--work <id>', 'link the imported asset to this work')
    .option('--role <role>', `link role (${WorkAssetRoleSchema.options.join('|')})`)
    .option(
      '--idempotency-key <key>',
      'reuse to make retries safe: the same key returns the original job (default: a new random key)',
    )
    .option('--wait', 'wait until the job finishes')
    .action(
      async (
        url: string,
        opts: {
          filename?: string;
          work?: string;
          role?: string;
          idempotencyKey?: string;
          wait?: boolean;
        },
      ) => {
        const role = opts.role === undefined ? undefined : WorkAssetRoleSchema.parse(opts.role);
        const api = client();
        let job = await api.imports.url(
          {
            url,
            ...(opts.filename ? { filename: opts.filename } : {}),
            ...(opts.work ? { work_id: opts.work } : {}),
            ...(role ? { role } : {}),
          },
          { idempotencyKey: opts.idempotencyKey ?? randomUUID() },
        );
        if (opts.wait === true) job = await api.jobs.wait(job.id, { intervalMs: 500 });
        io.stdout(json() ? `${JSON.stringify(job, null, 2)}\n` : describeJob(job));
        if (opts.wait === true && job.status === 'failed')
          throw new CommanderError(1, 'job.failed', '');
      },
    );

  const jobs = program.command('jobs').description('inspect import jobs');
  jobs
    .command('get <id>')
    .description('show an import job')
    .action(async (id: string) => {
      const job = await client().jobs.get(id);
      io.stdout(json() ? `${JSON.stringify(job, null, 2)}\n` : describeJob(job));
    });

  const mounts = program
    .command('mounts')
    .description('mount external Markdown folders (indexed in place, never moved or deleted)');
  mounts
    .command('add <path>')
    .description('mount a folder (owner token)')
    .option('--name <name>', 'display name (default: folder name)')
    .action(async (folder: string, opts: { name?: string }) => {
      const mount = await client().mounts.create({
        path: path.resolve(folder),
        ...(opts.name ? { name: opts.name } : {}),
      });
      io.stdout(
        json()
          ? `${JSON.stringify(mount, null, 2)}\n`
          : `mounted ${mount.id} ${mount.root_path} (indexing in the background)\n`,
      );
    });
  mounts
    .command('list')
    .description('list mounts')
    .action(async () => {
      const page = await client().mounts.list();
      if (json()) {
        io.stdout(`${JSON.stringify(page, null, 2)}\n`);
        return;
      }
      for (const m of page.items) {
        io.stdout(`${m.id}\t${m.status}\t${m.work_count} works\t${m.root_path}\n`);
      }
    });
  mounts
    .command('rescan <id>')
    .description('rescan a mount for new, changed and missing files')
    .action(async (id: string) => {
      const m = await client().mounts.rescan(id);
      io.stdout(`rescan queued for ${m.id}\n`);
    });
  mounts
    .command('remove <id>')
    .description('unmount; files on disk are not touched')
    .action(async (id: string) => {
      const m = await client().mounts.remove(id);
      io.stdout(`unmounted ${m.id} (${m.work_count} works kept as "unmounted")\n`);
    });

  return program;
}

/** Run the CLI and return a process exit code instead of exiting. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const program = buildProgram(io);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // commander already printed help/usage errors
      return err.exitCode;
    }
    if (err instanceof ApiError) {
      io.stderr(`error: ${err.status} ${err.code ?? ''} ${err.message}\n`);
      return 1;
    }
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
