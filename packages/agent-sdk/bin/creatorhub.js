#!/usr/bin/env node
// Workspace packages ship TypeScript sources; tsx loads them at runtime.
import { register } from 'tsx/esm/api';

register();
await import('../src/bin.ts');
