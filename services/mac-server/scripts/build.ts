/**
 * Build a self-contained mac-server (QC-030):
 *
 *   <out>/server.mjs        bundled server (all JS deps and workspace packages)
 *   <out>/node_modules/     native modules and packages that need their own files,
 *                           copied with their dependency closure (no symlinks)
 *   <out>/bin/node          the Node binary the native modules were built for
 *   <out>/build-info.json   version, git commit, build time (shown by /health)
 *   <out>/package.json      { "type": "module" }
 *
 * The folder can be copied anywhere (e.g. ~/Library/Application Support/
 * qiu-creator/server) and run with `bin/node server.mjs`; it needs neither
 * tsx nor this repository's node_modules.
 *
 * Usage: tsx scripts/build.ts [--out <dir>] [--no-node]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { SOURCE_VERSION } from '../src/build-info.js';

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Not bundled: native addons (`.node` files and prebuilt per-platform
 * packages); @fastify/swagger-ui, which serves static files from its own
 * package folder; file-type, which imports `strtok3` at runtime through a
 * non-literal specifier that a bundler cannot see.
 */
export const EXTERNAL_PACKAGES = [
  'better-sqlite3',
  '@napi-rs/keyring',
  'sharp',
  '@fastify/swagger-ui',
  'file-type',
] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function gitCommit(): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: serverDir,
      encoding: 'utf8',
    }).trim();
    const dirty =
      execFileSync('git', ['status', '--porcelain'], {
        cwd: serverDir,
        encoding: 'utf8',
      }).trim() !== '';
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}

interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/**
 * Copy a package and everything it depends on into `<out>/node_modules`,
 * resolving each dependency from the real location of the package that
 * needs it (pnpm's layout), and dereferencing symlinks. Optional
 * dependencies for other platforms are simply not installed, so they do not
 * resolve and are skipped.
 */
function copyClosure(name: string, fromDir: string, outModules: string, done: Set<string>): void {
  // Look the folder up the way Node would (node_modules of fromDir and its parents),
  // without going through `exports`, which may hide package.json or have no JS entry.
  const req = createRequire(path.join(fromDir, 'noop.js'));
  const manifest = (req.resolve.paths(name) ?? [])
    .map((dir) => path.join(dir, name, 'package.json'))
    .find((file) => fs.existsSync(file));
  if (manifest === undefined) return; // optional dependency for another platform
  const pkgDir = fs.realpathSync(path.dirname(manifest));
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as PackageJson;
  if (done.has(pkg.name)) return;
  done.add(pkg.name);
  fs.cpSync(pkgDir, path.join(outModules, pkg.name), {
    recursive: true,
    dereference: true,
    // Their own nested node_modules are handled through the closure instead.
    filter: (src) => !src.slice(pkgDir.length).split(path.sep).includes('node_modules'),
  });
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    copyClosure(dep, pkgDir, outModules, done);
  }
}

export async function buildServerArtifact(
  out: string,
  options: { withNode?: boolean } = {},
): Promise<{ out: string; commit: string | null }> {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  await build({
    entryPoints: [path.join(serverDir, 'src/main.ts')],
    outfile: path.join(out, 'server.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: [...EXTERNAL_PACKAGES],
    sourcemap: 'linked',
    legalComments: 'linked',
    logLevel: 'warning',
    // CommonJS dependencies inside an ES module bundle still call require().
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });

  const modules = path.join(out, 'node_modules');
  const done = new Set<string>();
  for (const name of EXTERNAL_PACKAGES) copyClosure(name, serverDir, modules, done);

  if (options.withNode ?? true) {
    fs.mkdirSync(path.join(out, 'bin'), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(out, 'bin', 'node'));
    fs.chmodSync(path.join(out, 'bin', 'node'), 0o755);
  }

  const commit = gitCommit();
  fs.writeFileSync(
    path.join(out, 'build-info.json'),
    `${JSON.stringify(
      {
        version: SOURCE_VERSION,
        commit,
        built_at: new Date().toISOString(),
        node: process.version,
        externals: [...done].sort(),
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(out, 'package.json'),
    `${JSON.stringify({ name: 'creatorhub-mac-server', version: SOURCE_VERSION, private: true, type: 'module' }, null, 2)}\n`,
  );
  return { out, commit };
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const out = path.resolve(arg('--out') ?? path.join(serverDir, 'dist'));
  const result = await buildServerArtifact(out, { withNode: !process.argv.includes('--no-node') });
  process.stdout.write(`built ${result.out} (commit ${result.commit ?? 'unknown'})\n`);
}
