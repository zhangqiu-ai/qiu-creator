/** Content-Security-Policy for the renderer. Dev adds what Vite's HMR client needs. */
export function contentSecurityPolicy(devServerUrl: string | null): string {
  const dev = devServerUrl === null ? null : new URL(devServerUrl);
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // React Fast Refresh injects an inline preamble in development only.
    'script-src': dev === null ? ["'self'"] : ["'self'", "'unsafe-inline'"],
    // MDXEditor, Radix and CodeMirror set inline styles.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https:', 'qc-asset:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': dev === null ? ["'self'"] : ["'self'", `ws://${dev.host}`],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}
