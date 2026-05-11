// Room and URL utilities for MoxMox.

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ROOM_ID_LENGTH = 16;
const ROOM_PARAM = 'moxmoxroom';

/**
 * Generate a cryptographically random room ID (16-char base62).
 * Uses crypto.getRandomValues when available, falls back to Math.random.
 */
export function generateRoomId() {
  const chars = new Array(ROOM_ID_LENGTH);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(ROOM_ID_LENGTH);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < ROOM_ID_LENGTH; i++) {
      chars[i] = BASE62[bytes[i] % BASE62.length];
    }
  } else {
    for (let i = 0; i < ROOM_ID_LENGTH; i++) {
      chars[i] = BASE62[Math.floor(Math.random() * BASE62.length)];
    }
  }
  return chars.join('');
}

/**
 * Build the shareable URL by appending ?moxmoxroom=<roomId> to a base URL.
 * Preserves existing query parameters and hash.
 */
export function buildShareUrl(baseUrl, roomId) {
  const url = new URL(baseUrl);
  url.searchParams.set(ROOM_PARAM, roomId);
  return url.toString();
}

/**
 * Extract the moxmoxroom parameter from a URL string.
 * Returns the room ID string, or null if not present.
 */
export function extractRoomId(urlString) {
  try {
    const url = new URL(urlString);
    return url.searchParams.get(ROOM_PARAM) || null;
  } catch {
    return null;
  }
}

/**
 * Remove the moxmoxroom parameter from a URL string.
 * Returns the cleaned URL string.
 */
export function stripRoomParam(urlString) {
  const url = new URL(urlString);
  url.searchParams.delete(ROOM_PARAM);
  return url.toString();
}

/**
 * Check if the current page is a Moxfield goldfish (playtest) page.
 */
export function isGoldfishPage(urlString) {
  try {
    const url = new URL(urlString);
    return (
      url.hostname === 'moxfield.com' &&
      /^\/decks\/[^/]+\/goldfish$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export { ROOM_PARAM, ROOM_ID_LENGTH };
