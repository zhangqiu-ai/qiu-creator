import fs from 'node:fs';
import { z } from 'zod';

/** Version of the source tree; the build artifact records it in `build-info.json`. */
export const SOURCE_VERSION = '0.1.0';

const BuildInfoSchema = z.object({
  version: z.string(),
  commit: z.string().nullable(),
  built_at: z.string().nullable(),
});
export type BuildInfo = z.infer<typeof BuildInfoSchema>;

/**
 * What `/health` reports (QC-030). The build script writes `build-info.json`
 * next to the bundled server; running from source there is none, so the
 * commit and build time are null.
 */
export function loadBuildInfo(
  file: URL = new URL('./build-info.json', import.meta.url),
): BuildInfo {
  try {
    return BuildInfoSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { version: SOURCE_VERSION, commit: null, built_at: null };
  }
}
