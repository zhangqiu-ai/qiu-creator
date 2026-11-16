import fs from 'node:fs/promises';
import { ApiError, createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import { WorkStatusSchema, WorkTypeSchema } from '@qiu-creator/contracts';
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
    .action(
      async (opts: {
        title: string;
        file: string;
        tags?: string[];
        type?: string;
        source: string;
      }) => {
        const markdown = await fs.readFile(opts.file, 'utf8');
        const type = opts.type === undefined ? undefined : WorkTypeSchema.parse(opts.type);
        const work = await client().works.create({
          title: opts.title,
          markdown,
          source: opts.source,
          ...(opts.tags ? { tags: opts.tags } : {}),
          ...(type ? { type } : {}),
        });
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
