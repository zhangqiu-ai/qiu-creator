/**
 * Stress harness for tus resumable uploads (QC-008).
 *
 * Starts the real server (`src/main.ts`) as a child process against a throwaway
 * CREATORHUB_HOME, then runs many interrupt/resume trials over raw sockets so
 * disconnects are abrupt and timing is controlled. After every trial it checks
 * that the upload completed with the right sha256, that no request hung, and
 * that the server still answers an unrelated request within a few seconds.
 *
 *   pnpm --filter @qiu-creator/mac-server exec tsx scripts/tus-stress.ts [--rounds N] [--big] [--out file.jsonl]
 *
 * Local only: talks to 127.0.0.1 on a random port. Never touches ~/CreatorHub.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const TUS = '/api/v1/assets/uploads/tus';
const TOKEN = randomBytes(24).toString('base64url');
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MiB = 1024 * 1024;
const REQUEST_DEADLINE_MS = 90_000; // > tus lock timeout (30 s) + drain (3 s)
const HEALTH_DEADLINE_MS = 5_000;

// ---- args ---------------------------------------------------------------------
const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const ROUNDS = Number(argValue('--rounds') ?? '1');
const BIG = args.includes('--big');
const OUT = argValue('--out');
const SEED = Number(argValue('--seed') ?? String(Date.now() % 1_000_000));

// Small deterministic PRNG so a failing run can be replayed with --seed.
let rngState = SEED >>> 0 || 1;
function rand(): number {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 0x1_0000_0000;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

// ---- server process -----------------------------------------------------------
interface Server {
  child: ChildProcess;
  port: number;
  exited: Promise<number | null>;
  logFile: string;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc008-home-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'qc008-files-'));
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc008-logs-'));
let serverStarts = 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

async function startServer(port?: number): Promise<Server> {
  const usePort = port ?? (await freePort());
  serverStarts += 1;
  const logFile = path.join(logDir, `server-${serverStarts}.log`);
  const log = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      CREATORHUB_HOME: home,
      CREATORHUB_PORT: String(usePort),
      CREATORHUB_TOKEN: TOKEN,
      CREATORHUB_LOG_LEVEL: 'info',
    },
    stdio: ['ignore', log, log],
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => {
      resolve(code);
    }),
  );
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early, see ${logFile}`);
    if (await healthy(usePort, 1000)) return { child, port: usePort, exited, logFile };
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start, see ${logFile}`);
}

async function stopServer(s: Server, signal: NodeJS.Signals): Promise<void> {
  if (s.child.exitCode !== null) return;
  s.child.kill(signal);
  const timer = setTimeout(() => s.child.kill('SIGKILL'), 10_000);
  await s.exited;
  clearTimeout(timer);
}

// ---- raw HTTP -----------------------------------------------------------------
interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  ms: number;
}
type Outcome = Res | { error: string; ms: number };

function request(
  port: number,
  method: string,
  url: string,
  headers: Record<string, string>,
  deadlineMs = REQUEST_DEADLINE_MS,
  body?: (req: http.ClientRequest) => void,
): Promise<Outcome> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (o: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(o);
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: url,
        agent: false,
        headers: { authorization: `Bearer ${TOKEN}`, 'tus-resumable': '1.0.0', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          done({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            ms: Date.now() - t0,
          });
        });
        res.on('error', (e) => {
          done({ error: `response: ${e.message}`, ms: Date.now() - t0 });
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done({ error: 'TIMEOUT', ms: Date.now() - t0 });
    }, deadlineMs);
    req.on('error', (e: NodeJS.ErrnoException) => {
      done({ error: e.code ?? e.message, ms: Date.now() - t0 });
    });
    if (body) body(req);
    else req.end();
  });
}

const isRes = (o: Outcome): o is Res => 'status' in o;

async function healthy(port: number, deadline = HEALTH_DEADLINE_MS): Promise<boolean> {
  const r = await request(port, 'GET', '/api/v1/assets?limit=1', {}, deadline);
  return isRes(r) && r.status === 200;
}

async function createUpload(port: number, size: number, name: string): Promise<string> {
  const r = await request(port, 'POST', TUS, {
    'upload-length': String(size),
    'upload-metadata': `filename ${Buffer.from(name).toString('base64')}`,
  });
  if (!isRes(r) || r.status !== 201) throw new Error(`create failed: ${JSON.stringify(r)}`);
  return String(r.headers.location);
}

async function headOffset(port: number, url: string): Promise<Outcome & { offset?: number }> {
  const r = await request(port, 'HEAD', url, {}, 15_000);
  if (!isRes(r)) return r;
  return { ...r, offset: Number(r.headers['upload-offset']) };
}

type CutMode = 'none' | 'destroy' | 'reset' | 'stall';

interface PatchPlan {
  file: string;
  offset: number;
  /** Stop sending after this many body bytes (relative to `offset`); undefined = send all. */
  cutAfter?: number;
  cut: CutMode;
  /** Bytes per second; 0 = unthrottled. */
  rate: number;
  /** Declared body length (defaults to the rest of the file). */
  length?: number;
}

interface PatchHandle {
  result: Promise<Outcome>;
  /** For `stall`: close the stalled connection later. */
  close: () => void;
  /** Resolves once the cut happened (or the body was fully written). */
  cutDone: Promise<void>;
}

/**
 * PATCH with an explicit Content-Length, streaming the file slice, optionally
 * throttled and cut part-way: `destroy` closes the socket (FIN, like curl
 * --max-time), `reset` sends RST, `stall` stops sending but keeps the socket
 * open (a client that vanished without the server noticing).
 */
function patch(port: number, url: string, plan: PatchPlan): PatchHandle {
  const size = fs.statSync(plan.file).size;
  const length = plan.length ?? size - plan.offset;
  let reqRef: http.ClientRequest | undefined;
  let markCut: () => void = () => {};
  const cutDone = new Promise<void>((r) => (markCut = r));
  const result = request(
    port,
    'PATCH',
    url,
    {
      'content-type': 'application/offset+octet-stream',
      'upload-offset': String(plan.offset),
      'content-length': String(length),
    },
    REQUEST_DEADLINE_MS,
    (req) => {
      reqRef = req;
      void pump(req);
    },
  );
  async function pump(req: http.ClientRequest): Promise<void> {
    const limit = plan.cutAfter ?? length;
    const fd = await fs.promises.open(plan.file, 'r');
    try {
      let sent = 0;
      const chunk = 64 * 1024;
      const t0 = Date.now();
      while (sent < limit && !req.destroyed) {
        const n = Math.min(chunk, limit - sent);
        const buf = Buffer.alloc(n);
        await fd.read(buf, 0, n, plan.offset + sent);
        sent += n;
        if (!req.write(buf)) {
          await new Promise<void>((r) => {
            const fin = (): void => {
              req.off('drain', fin);
              req.off('close', fin);
              r();
            };
            req.on('drain', fin);
            req.on('close', fin);
          });
        }
        if (plan.rate > 0) {
          const due = t0 + (sent / plan.rate) * 1000;
          const wait = due - Date.now();
          if (wait > 0) await sleep(wait);
        }
      }
      if (plan.cutAfter === undefined) {
        req.end();
      } else if (plan.cut === 'destroy') {
        req.destroy();
      } else if (plan.cut === 'reset') {
        const sock = req.socket;
        if (sock && typeof sock.resetAndDestroy === 'function') sock.resetAndDestroy();
        else req.destroy();
      }
      // 'stall': leave the socket open; the caller closes it later.
    } catch {
      // socket died under us; the request promise reports it
    } finally {
      await fd.close();
      markCut();
    }
  }
  return { result, cutDone, close: () => reqRef?.destroy() };
}

// ---- files ----------------------------------------------------------------------
const FTYP = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);

/** An MP4-signed file of random bytes, so every trial ingests a new asset. */
async function makeFile(size: number): Promise<{ file: string; sha: string }> {
  const file = path.join(work, `${randomBytes(6).toString('hex')}.mp4`);
  const fh = await fs.promises.open(file, 'w');
  const hash = createHash('sha256');
  let written = 0;
  const first = Buffer.concat([FTYP, randomBytes(Math.min(size, 4 * MiB) - FTYP.length)]);
  for (let buf = first; written < size; buf = randomBytes(Math.min(4 * MiB, size - written))) {
    await fh.write(buf);
    hash.update(buf);
    written += buf.length;
  }
  await fh.close();
  return { file, sha: hash.digest('hex') };
}

// ---- trials -----------------------------------------------------------------------
type Scenario =
  | 'cut-resume'
  | 'concurrent-resume'
  | 'duplicate-patch'
  | 'resume-during-stall'
  | 'restart-resume'
  | 'chunked-random-cuts';

interface Trial {
  scenario: Scenario;
  size: number;
  rate: number;
  cut: CutMode;
  cutAt: number;
  delayMs: number;
  parallel?: number;
  restartSignal?: NodeJS.Signals;
}

interface TrialResult extends Trial {
  n: number;
  ok: boolean;
  problems: string[];
  events: string[];
  ms: number;
}

let server: Server;

function describe(o: Outcome): string {
  return isRes(o) ? `${o.status} in ${o.ms}ms` : `ERR ${o.error} after ${o.ms}ms`;
}

async function finishFrom(url: string, file: string, events: string[]): Promise<Outcome> {
  const h = await headOffset(server.port, url);
  events.push(`HEAD ${describe(h)} offset=${h.offset ?? '?'}`);
  if (!isRes(h) || h.offset === undefined || Number.isNaN(h.offset)) return h;
  const p = patch(server.port, url, { file, offset: h.offset, cut: 'none', rate: 0 });
  const r = await p.result;
  events.push(`resume PATCH@${h.offset} ${describe(r)}`);
  return r;
}

async function runTrial(t: Trial, n: number): Promise<TrialResult> {
  const t0 = Date.now();
  const events: string[] = [];
  const problems: string[] = [];
  const { file, sha } = await makeFile(t.size);
  const url = await createUpload(server.port, t.size, `stress-${n}.mp4`);
  const cutAt = Math.max(1, Math.min(t.size - 1, t.cutAt));

  // Health probe in parallel with the trial: catches a blocked event loop.
  // Mutated from the trial body below; an object so the loop re-reads it.
  const flags = { probing: true, restarting: false };
  const probe = (async () => {
    while (flags.probing) {
      const during = flags.restarting;
      if (!(await healthy(server.port)) && !during && !flags.restarting) {
        problems.push('health probe failed during trial');
      }
      await sleep(250);
    }
  })();

  let final: Outcome | undefined;
  try {
    if (t.scenario === 'chunked-random-cuts') {
      // api-client style 8 MiB chunks, cutting a random chunk now and then.
      let offset = 0;
      let guard = 0;
      while (offset < t.size && guard++ < 200) {
        const len = Math.min(8 * MiB, t.size - offset);
        const cutThis = rand() < 0.35;
        const p = patch(server.port, url, {
          file,
          offset,
          length: len,
          cutAfter: cutThis ? Math.max(1, Math.floor(rand() * len)) : len,
          cut: cutThis ? pick(['destroy', 'reset'] as const) : 'none',
          rate: t.rate,
        });
        const r = await p.result;
        events.push(`chunk@${offset} ${cutThis ? 'cut' : 'full'} ${describe(r)}`);
        if (isRes(r) && r.status === 200) {
          final = r;
          break;
        }
        if (cutThis) await sleep(t.delayMs);
        const h = await headOffset(server.port, url);
        if (!isRes(h) || h.offset === undefined || Number.isNaN(h.offset)) {
          problems.push(`HEAD failed: ${describe(h)}`);
          break;
        }
        offset = h.offset;
      }
    } else {
      // Phase 1: first PATCH, interrupted.
      const first = patch(server.port, url, {
        file,
        offset: 0,
        cutAfter: cutAt,
        cut: t.scenario === 'resume-during-stall' ? 'stall' : t.cut,
        rate: t.rate,
      });
      await first.cutDone;
      if (t.scenario !== 'resume-during-stall') {
        const r1 = await first.result;
        events.push(`first PATCH cut@${cutAt} ${describe(r1)}`);
      } else {
        events.push(`first PATCH stalled@${cutAt}`);
      }
      await sleep(t.delayMs);

      if (t.scenario === 'restart-resume') {
        const sig = t.restartSignal ?? 'SIGTERM';
        const port = server.port;
        flags.restarting = true;
        await stopServer(server, sig);
        events.push(`server stopped with ${sig}`);
        server = await startServer(port);
        flags.restarting = false;
        events.push('server restarted');
      }

      if (t.scenario === 'concurrent-resume') {
        const h = await headOffset(server.port, url);
        events.push(`HEAD ${describe(h)} offset=${h.offset ?? '?'}`);
        const off = h.offset ?? 0;
        const many = Array.from({ length: t.parallel ?? 2 }, () =>
          patch(server.port, url, { file, offset: off, cut: 'none', rate: t.rate }),
        );
        const rs = await Promise.all(many.map((m) => m.result));
        rs.forEach((r, i) => events.push(`parallel PATCH#${i}@${off} ${describe(r)}`));
        final = rs.find((r) => isRes(r) && r.status === 200);
        if (!final) final = await finishFrom(url, file, events);
      } else if (t.scenario === 'duplicate-patch') {
        // Re-send the same (already partly applied) offset, then a proper resume.
        const dup = patch(server.port, url, { file, offset: 0, cut: 'none', rate: 0 });
        const rd = await dup.result;
        events.push(`duplicate PATCH@0 ${describe(rd)}`);
        if (isRes(rd) && rd.status === 200) final = rd;
        else final = await finishFrom(url, file, events);
      } else if (t.scenario === 'resume-during-stall') {
        // The old connection is still open and silent; resume on a new one.
        final = await finishFrom(url, file, events);
        first.close();
        const r1 = await first.result;
        events.push(`stalled PATCH closed: ${describe(r1)}`);
      } else {
        final = await finishFrom(url, file, events);
      }
    }
  } catch (err) {
    problems.push(`exception: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    flags.probing = false;
    await probe;
  }

  if (!final) problems.push('no final response');
  else if (!isRes(final)) problems.push(`final request failed: ${describe(final)}`);
  else if (final.status !== 200)
    problems.push(`final status ${final.status}: ${final.body.slice(0, 200)}`);
  else {
    const body = JSON.parse(final.body) as { asset: { sha256: string; bytes: number } };
    if (body.asset.sha256 !== sha) problems.push('sha256 mismatch');
    if (body.asset.bytes !== t.size) problems.push('size mismatch');
  }
  for (const e of events) if (e.includes('TIMEOUT')) problems.push(`hang: ${e}`);
  if (server.child.exitCode !== null) problems.push(`server exited with ${server.child.exitCode}`);
  if (!(await healthy(server.port))) problems.push('server unhealthy after trial');

  fs.rmSync(file, { force: true });
  return { ...t, n, ok: problems.length === 0, problems, events, ms: Date.now() - t0 };
}

function trialsFor(): Trial[] {
  const sizes = BIG ? [40 * MiB, 256 * MiB, 1024 * MiB] : [40 * MiB, 96 * MiB];
  const rates = [0, 8 * MiB, 32 * MiB, 2 * MiB];
  const delays = [0, 0, 20, 200, 1500, 4000];
  const cuts: CutMode[] = ['destroy', 'reset'];
  const out: Trial[] = [];
  const base = (scenario: Scenario): Trial => {
    const size = pick(sizes);
    return {
      scenario,
      size,
      rate: pick(rates),
      cut: pick(cuts),
      cutAt: Math.floor(size * (0.05 + rand() * 0.9)),
      delayMs: pick(delays),
    };
  };
  // Exact replay of the original report every round: 40 MiB, 8 MiB/s, cut at 16 MiB, immediate resume.
  {
    out.push({
      scenario: 'cut-resume',
      size: 40 * MiB,
      rate: 8 * MiB,
      cut: 'destroy',
      cutAt: 16_842_752,
      delayMs: 0,
    });
  }
  for (let i = 0; i < 4; i++) out.push(base('cut-resume'));
  out.push({ ...base('concurrent-resume'), parallel: pick([2, 3, 4]) });
  out.push(base('duplicate-patch'));
  out.push(base('resume-during-stall'));
  out.push({ ...base('restart-resume'), restartSignal: pick(['SIGTERM', 'SIGKILL'] as const) });
  out.push(base('chunked-random-cuts'));
  return out;
}

// ---- main ---------------------------------------------------------------------------
async function main(): Promise<void> {
  process.stdout.write(`seed=${SEED} home=${home} logs=${logDir}\n`);
  server = await startServer();
  const results: TrialResult[] = [];
  const outStream = OUT ? fs.createWriteStream(OUT, { flags: 'a' }) : undefined;
  let n = 0;
  try {
    for (let round = 0; round < ROUNDS; round++) {
      for (const t of trialsFor()) {
        n += 1;
        const r = await runTrial(t, n);
        results.push(r);
        outStream?.write(`${JSON.stringify({ seed: SEED, ...r })}\n`);
        process.stdout.write(
          `#${n} ${r.ok ? 'ok  ' : 'FAIL'} ${t.scenario} size=${t.size / MiB}MiB rate=${
            t.rate / MiB
          }MiB/s cut=${t.cut}@${t.cutAt} delay=${t.delayMs}ms ${r.ms}ms${
            r.ok ? '' : `\n    ${r.problems.join('\n    ')}\n    ${r.events.join('\n    ')}`
          }\n`,
        );
        if (!r.ok && server.child.exitCode !== null) server = await startServer();
      }
    }
  } finally {
    await stopServer(server, 'SIGTERM');
    outStream?.end();
  }
  const failed = results.filter((r) => !r.ok);
  const byScenario = new Map<string, { total: number; failed: number }>();
  for (const r of results) {
    const s = byScenario.get(r.scenario) ?? { total: 0, failed: 0 };
    s.total += 1;
    if (!r.ok) s.failed += 1;
    byScenario.set(r.scenario, s);
  }
  process.stdout.write(`\ntrials=${results.length} failed=${failed.length} seed=${SEED}\n`);
  for (const [k, v] of byScenario)
    process.stdout.write(`  ${k}: ${v.total - v.failed}/${v.total}\n`);
  const leftover = fs.existsSync(path.join(home, 'data', 'uploads'))
    ? fs.readdirSync(path.join(home, 'data', 'uploads'))
    : [];
  process.stdout.write(`leftover upload files: ${leftover.length}\n`);
  if (failed.length > 0) {
    process.stdout.write(`server logs kept in ${logDir}\n`);
  } else {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
  process.exitCode = failed.length > 0 ? 1 : 0;
}

await main();
