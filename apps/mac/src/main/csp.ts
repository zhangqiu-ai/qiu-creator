/** The service address the packaged app uses unless CREATORHUB_HOST/PORT say otherwise. */
export const DEFAULT_SERVICE_ORIGIN = 'http://127.0.0.1:7420';

/**
 * Content-Security-Policy for the renderer. Dev adds what Vite's HMR client needs.
 *
 * Images and media may come from the app itself, `qc-asset:` (main-process
 * proxy) and the Mac service origin, which serves short-lived signed media
 * URLs for Markdown images (QC-010/011). Remote `https:` images are not
 * loaded: the editor shows a placeholder instead of contacting third parties.
 */
export function contentSecurityPolicy(
  devServerUrl: string | null,
  serviceOrigin: string = DEFAULT_SERVICE_ORIGIN,
): string {
  const dev = devServerUrl === null ? null : new URL(devServerUrl);
  const service = new URL(serviceOrigin).origin;
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // React Fast Refresh injects an inline preamble in development only.
    'script-src': dev === null ? ["'self'"] : ["'self'", "'unsafe-inline'"],
    // MDXEditor, Radix and CodeMirror set inline styles.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'qc-asset:', service],
    'media-src': ["'self'", 'qc-asset:', service],
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
