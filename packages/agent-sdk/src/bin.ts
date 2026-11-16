import { runCli } from './cli.js';

const code = await runCli(process.argv.slice(2), {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  env: process.env,
});
process.exitCode = code;
