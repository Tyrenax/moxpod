// Display logic for the spectator panel.
//
// These are the pure helpers behind the feature's whole reason for existing:
// showing what an opponent has applied to a card. No DOM needed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effectivePT, describeModifiers, cardImageUrl, SPLIT_PRESETS } from '../src/board/panel.js';

function creature(overrides = {}) {
  return {
    key: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    name: 'Grizzly Bears', set: 'lea', cn: '10', layout: 'normal',
    power: '2', toughness: '2',
    tapped: false, flipped: false, rotated: false, doesntUntap: false,
    counters: 0, adjustedPower: 0, adjustedToughness: 0, adjustedLoyalty: 0,
    ...overrides,
  };
}

describe('effectivePT', () => {
  it('shows the printed values when nothing was modified', () => {
    const pt = effectivePT(creature());
    assert.equal(pt.text, '2/2');
    assert.equal(pt.modified, false);
  });

  it('adds a -1/-1 to the printed values', () => {
    const pt = effectivePT(creature({ adjustedPower: -1, adjustedToughness: -1 }));
    assert.equal(pt.text, '1/1');
    assert.equal(pt.modified, true);
    assert.equal(pt.base, '2/2');
    assert.equal(pt.delta, '-1/-1');
  });

  it('adds a +2/+2 and signs the delta', () => {
    const pt = effectivePT(creature({ adjustedPower: 2, adjustedToughness: 2 }));
    assert.equal(pt.text, '4/4');
    assert.equal(pt.delta, '+2/+2');
  });

  it('handles an asymmetric modifier', () => {
    const pt = effectivePT(creature({ adjustedPower: 3, adjustedToughness: -1 }));
    assert.equal(pt.text, '5/1');
    assert.equal(pt.delta, '+3/-1');
  });

  it('can take a creature below zero without pretending otherwise', () => {
    const pt = effectivePT(creature({ adjustedPower: -5, adjustedToughness: -5 }));
    assert.equal(pt.text, '-3/-3');
    assert.equal(pt.modified, true);
  });

  it('returns nothing for a card with no power and no modifier', () => {
    assert.equal(effectivePT(creature({ power: null, toughness: null })), null);
  });

  it('does not crash on a star power like Tarmogoyf', () => {
    const pt = effectivePT(creature({ power: '*', toughness: '1+*' }));
    assert.equal(pt.text, '*/1+*');
    assert.equal(pt.modified, false);
  });

  it('still reports a modifier on a star-power creature', () => {
    const pt = effectivePT(creature({ power: '*', toughness: '*', adjustedPower: 1, adjustedToughness: 1 }));
    assert.equal(pt.modified, true);
    assert.equal(pt.delta, '+1/+1');
  });
});

describe('describeModifiers', () => {
  it('says nothing about a clean permanent', () => {
    assert.deepEqual(describeModifiers(creature()), []);
  });

  it('lists everything the owner applied, in plain language', () => {
    const mods = describeModifiers(creature({
      tapped: true, doesntUntap: true, counters: 3,
      adjustedPower: -1, adjustedToughness: -1,
    }));
    assert.ok(mods.includes('Engagée'));
    assert.ok(mods.includes('Ne se dégage pas au prochain tour'));
    assert.ok(mods.some(m => m.includes('3 marqueur')));
    assert.ok(mods.some(m => m.includes('-1/-1')));
  });

  it('reports a loyalty change', () => {
    const mods = describeModifiers(creature({ adjustedLoyalty: -2 }));
    assert.ok(mods.some(m => m.includes('-2')));
  });

  it('reports a face-down permanent', () => {
    assert.ok(describeModifiers(creature({ flipped: true })).includes('Face cachée'));
  });
});

describe('cardImageUrl', () => {
  it('addresses the Scryfall CDN directly when we have a printing id', () => {
    const url = cardImageUrl(creature());
    assert.equal(url, 'https://cards.scryfall.io/normal/front/0/f/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.jpg');
    assert.ok(!url.includes('api.scryfall.com'), 'must avoid the per-card 302');
  });

  it('falls back to set + collector number when there is no printing id', () => {
    const url = cardImageUrl(creature({ key: 't:tok1:Soldier', set: 'war', cn: '12' }));
    assert.match(url, /api\.scryfall\.com\/cards\/war\/12/);
  });

  it('returns null for a token with nothing to look up, so we draw a text frame', () => {
    assert.equal(cardImageUrl({ key: 't:x:Thing', set: null, cn: null }), null);
  });

  it('escapes set and collector number', () => {
    const url = cardImageUrl({ key: 'tok', set: 'a b', cn: '1/2' });
    assert.ok(!url.includes(' '), 'unescaped space in URL');
    assert.match(url, /1%2F2/);
  });
});

describe('split presets', () => {
  it('offers the layouts that were asked for', () => {
    const values = SPLIT_PRESETS.map(p => p.value);
    assert.ok(values.includes(50), '50/50 missing');
    assert.ok(values.includes(60), '60/40 missing');
    assert.ok(values.every(v => v > 0 && v < 100));
  });
});
