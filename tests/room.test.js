import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRoomId,
  generateTraditionalRoomCode,
  isTraditionalRoomCode,
  buildShareUrl,
  extractRoomId,
  stripRoomParam,
  isGoldfishPage,
  detectPlaytestSite,
  isPlaytestPage,
  ROOM_ID_LENGTH,
  TRADITIONAL_ROOM_CODE_LENGTH,
} from '../src/shared/room.js';

describe('generateRoomId', () => {
  it('produces a string of the correct length', () => {
    const id = generateRoomId();
    assert.equal(typeof id, 'string');
    assert.equal(id.length, ROOM_ID_LENGTH);
  });

  it('contains only base62 characters', () => {
    for (let i = 0; i < 20; i++) {
      const id = generateRoomId();
      assert.match(id, /^[A-Za-z0-9]+$/);
    }
  });

  it('generates unique IDs in a batch', () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateRoomId());
    }
    assert.equal(ids.size, 1000, 'all 1000 IDs should be unique');
  });

  it('matches the server room ID regex', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateRoomId();
      assert.match(id, /^[a-zA-Z0-9_-]{1,64}$/);
    }
  });
});

describe('generateTraditionalRoomCode', () => {
  it('produces a short uppercase code of the correct length', () => {
    const id = generateTraditionalRoomCode();
    assert.equal(typeof id, 'string');
    assert.equal(id.length, TRADITIONAL_ROOM_CODE_LENGTH);
    assert.equal(isTraditionalRoomCode(id), true);
  });

  it('omits ambiguous characters', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateTraditionalRoomCode();
      assert.match(id, /^[A-HJ-NP-Z2-9]+$/);
      assert.doesNotMatch(id, /[IO01]/);
    }
  });
});

describe('isTraditionalRoomCode', () => {
  it('accepts generated Traditional room codes', () => {
    assert.equal(isTraditionalRoomCode(generateTraditionalRoomCode()), true);
  });

  it('rejects wrong length, lowercase, and ambiguous characters', () => {
    assert.equal(isTraditionalRoomCode('ABC12'), false);
    assert.equal(isTraditionalRoomCode('abcdef'), false);
    assert.equal(isTraditionalRoomCode('ABCI2O'), false);
  });
});

describe('buildShareUrl', () => {
  it('appends moxmoxroom param to a simple URL', () => {
    const url = buildShareUrl(
      'https://moxfield.com/decks/abc123/goldfish',
      'myRoom42',
    );
    assert.equal(
      url,
      'https://moxfield.com/decks/abc123/goldfish?moxmoxroom=myRoom42',
    );
  });

  it('preserves existing query parameters', () => {
    const url = buildShareUrl(
      'https://moxfield.com/decks/abc123/goldfish?foo=bar',
      'room1',
    );
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('foo'), 'bar');
    assert.equal(parsed.searchParams.get('moxmoxroom'), 'room1');
  });

  it('overwrites an existing moxmoxroom param', () => {
    const url = buildShareUrl(
      'https://moxfield.com/decks/abc123/goldfish?moxmoxroom=old',
      'new',
    );
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('moxmoxroom'), 'new');
  });

  it('preserves hash fragments', () => {
    const url = buildShareUrl(
      'https://moxfield.com/decks/abc123/goldfish#section',
      'room1',
    );
    const parsed = new URL(url);
    assert.equal(parsed.hash, '#section');
    assert.equal(parsed.searchParams.get('moxmoxroom'), 'room1');
  });
});

describe('extractRoomId', () => {
  it('extracts room ID from a URL with the param', () => {
    const id = extractRoomId(
      'https://moxfield.com/decks/abc/goldfish?moxmoxroom=ABC123xyz',
    );
    assert.equal(id, 'ABC123xyz');
  });

  it('returns null when param is absent', () => {
    assert.equal(
      extractRoomId('https://moxfield.com/decks/abc/goldfish'),
      null,
    );
  });

  it('returns null for empty param', () => {
    assert.equal(
      extractRoomId('https://moxfield.com/decks/abc/goldfish?moxmoxroom='),
      null,
    );
  });

  it('returns null for invalid URL', () => {
    assert.equal(extractRoomId('not a url'), null);
  });

  it('handles URL with multiple params', () => {
    const id = extractRoomId(
      'https://moxfield.com/decks/abc/goldfish?a=1&moxmoxroom=room99&b=2',
    );
    assert.equal(id, 'room99');
  });
});

describe('stripRoomParam', () => {
  it('removes moxmoxroom from URL', () => {
    const url = stripRoomParam(
      'https://moxfield.com/decks/abc/goldfish?moxmoxroom=room1',
    );
    assert.equal(url, 'https://moxfield.com/decks/abc/goldfish');
  });

  it('preserves other params', () => {
    const url = stripRoomParam(
      'https://moxfield.com/decks/abc/goldfish?foo=bar&moxmoxroom=room1&baz=qux',
    );
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('foo'), 'bar');
    assert.equal(parsed.searchParams.get('baz'), 'qux');
    assert.equal(parsed.searchParams.has('moxmoxroom'), false);
  });

  it('returns same URL when param is not present', () => {
    const original = 'https://moxfield.com/decks/abc/goldfish';
    assert.equal(stripRoomParam(original), original);
  });
});

describe('isGoldfishPage', () => {
  it('returns true for a goldfish URL', () => {
    assert.equal(
      isGoldfishPage('https://moxfield.com/decks/abc123/goldfish'),
      true,
    );
  });

  it('returns true with query params', () => {
    assert.equal(
      isGoldfishPage(
        'https://moxfield.com/decks/abc123/goldfish?moxmoxroom=foo',
      ),
      true,
    );
  });

  it('returns false for deck page without goldfish', () => {
    assert.equal(
      isGoldfishPage('https://moxfield.com/decks/abc123'),
      false,
    );
  });

  it('returns false for non-moxfield URLs', () => {
    assert.equal(
      isGoldfishPage('https://example.com/decks/abc123/goldfish'),
      false,
    );
  });

  it('returns false for invalid URLs', () => {
    assert.equal(isGoldfishPage('not a url'), false);
  });

  it('returns false for moxfield non-deck pages', () => {
    assert.equal(isGoldfishPage('https://moxfield.com/help'), false);
  });
});

describe('detectPlaytestSite', () => {
  it('returns moxfield for goldfish URL', () => {
    assert.equal(
      detectPlaytestSite('https://moxfield.com/decks/abc123/goldfish'),
      'moxfield',
    );
  });

  it('returns moxfield with query params', () => {
    assert.equal(
      detectPlaytestSite('https://moxfield.com/decks/abc123/goldfish?moxmoxroom=foo'),
      'moxfield',
    );
  });

  it('returns archidekt for playtester-v2 URL', () => {
    assert.equal(
      detectPlaytestSite('https://archidekt.com/playtester-v2/21256567'),
      'archidekt',
    );
  });

  it('returns archidekt with query params', () => {
    assert.equal(
      detectPlaytestSite('https://archidekt.com/playtester-v2/21256567?foo=bar'),
      'archidekt',
    );
  });

  it('returns null for non-playtest moxfield pages', () => {
    assert.equal(
      detectPlaytestSite('https://moxfield.com/decks/abc123'),
      null,
    );
  });

  it('returns null for non-playtest archidekt pages', () => {
    assert.equal(
      detectPlaytestSite('https://archidekt.com/decks/21256567'),
      null,
    );
  });

  it('returns null for unrecognized sites', () => {
    assert.equal(
      detectPlaytestSite('https://example.com/decks/abc123/goldfish'),
      null,
    );
  });

  it('returns null for invalid URLs', () => {
    assert.equal(detectPlaytestSite('not a url'), null);
  });
});

describe('isPlaytestPage', () => {
  it('returns true for moxfield goldfish', () => {
    assert.equal(
      isPlaytestPage('https://moxfield.com/decks/abc123/goldfish'),
      true,
    );
  });

  it('returns true for archidekt playtester', () => {
    assert.equal(
      isPlaytestPage('https://archidekt.com/playtester-v2/21256567'),
      true,
    );
  });

  it('returns false for non-playtest pages', () => {
    assert.equal(isPlaytestPage('https://moxfield.com/help'), false);
    assert.equal(isPlaytestPage('https://archidekt.com/decks/123'), false);
    assert.equal(isPlaytestPage('https://example.com/playtest'), false);
  });
});
