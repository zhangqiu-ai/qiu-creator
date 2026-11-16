import fs from 'node:fs';
import path from 'node:path';

export function fixture(name: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
}
