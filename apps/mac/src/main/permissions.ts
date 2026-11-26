import { isAppUrl } from './app-protocol.js';

/**
 * Web permissions the renderer may be granted (QC-104). Everything is denied
 * except HTML fullscreen requested by this app's own renderer, which the
 * native `<video controls>` fullscreen button needs: denying it made the
 * button do nothing. Camera, microphone, notifications, geolocation and the
 * rest stay denied, and so does fullscreen for any other page.
 */
export function permissionAllowed(
  permission: string,
  requestingUrl: string,
  devServerUrl: string | null,
): boolean {
  return permission === 'fullscreen' && isAppUrl(requestingUrl, devServerUrl);
}
