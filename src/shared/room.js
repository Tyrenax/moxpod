// Room and URL utilities for MoxMox.

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TRADITIONAL_ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_ID_LENGTH = 16;
const TRADITIONAL_ROOM_CODE_LENGTH = 6;
const ROOM_PARAM = 'moxmoxroom';

/**
 * Generate a cryptographically random room ID (16-char base62).
 * Uses crypto.getRandomValues when available, falls back to Math.random.
 */
export function generateRoomId() {
  return generateCode(BASE62, ROOM_ID_LENGTH);
}

/**
 * Generate a short, uppercase room code for Traditional games.
 * Ambiguous characters (I, O, 0, 1) are omitted for easier typing.
 */
export function generateTraditionalRoomCode() {
  return generateCode(TRADITIONAL_ROOM_CHARS, TRADITIONAL_ROOM_CODE_LENGTH);
}

export function isTraditionalRoomCode(value) {
  return typeof value === 'string' &&
    new RegExp(`^[${TRADITIONAL_ROOM_CHARS}]{${TRADITIONAL_ROOM_CODE_LENGTH}}$`).test(value);
}

function generateCode(alphabet, length) {
  const chars = new Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < length; i++) {
      chars[i] = alphabet[bytes[i] % alphabet.length];
    }
  } else {
    for (let i = 0; i < length; i++) {
      chars[i] = alphabet[Math.floor(Math.random() * alphabet.length)];
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

/**
 * Check if the current page is any supported playtest page.
 * Returns the site name ('moxfield' | 'archidekt') or null.
 */
export function detectPlaytestSite(urlString) {
  try {
    const url = new URL(urlString);
    if (
      url.hostname === 'moxfield.com' &&
      /^\/decks\/[^/]+\/goldfish$/.test(url.pathname)
    ) {
      return 'moxfield';
    }
    if (
      url.hostname === 'archidekt.com' &&
      /^\/playtester-v2\/\d+/.test(url.pathname)
    ) {
      return 'archidekt';
    }
  } catch {
    // invalid URL
  }
  return null;
}

/**
 * Check if the current page is any supported playtest page (boolean).
 */
export function isPlaytestPage(urlString) {
  return detectPlaytestSite(urlString) !== null;
}

export { ROOM_PARAM, ROOM_ID_LENGTH, TRADITIONAL_ROOM_CODE_LENGTH };
