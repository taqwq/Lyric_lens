import './setup';

import { describe, expect, it } from 'vitest';
import { parseReferents } from '../src/genius/annotations';

const referent = (over: Record<string, unknown> = {}) => ({
  id: 4242,
  fragment: 'gas',
  annotations: [{ body: { plain: 'Slang for excellent.' }, votes_total: 5 }],
  ...over,
});

describe('parseReferents', () => {
  it('returns id, fragment, text and votes', () => {
    expect(parseReferents([referent()])).toEqual([{ id: '4242', fragment: 'gas', text: 'Slang for excellent.', votes: 5 }]);
  });

  it('prefers the exact range content over the fragment, and trims both', () => {
    const [a] = parseReferents([referent({ fragment: 'short', range: { content: '  the exact range  ' }, annotations: [{ body: { plain: '  explained \n' }, votes_total: 9 }] })]);
    expect(a).toMatchObject({ fragment: 'the exact range', text: 'explained' });
  });

  it('marks verified annotations, and omits the flag otherwise', () => {
    const [verified, plain] = parseReferents([
      referent({ id: 1, annotations: [{ body: { plain: 'x' }, votes_total: 0, verified: true }] }),
      referent({ id: 2 }),
    ]);
    expect(verified).toEqual({ id: '1', fragment: 'gas', text: 'x', votes: 0, verified: true });
    expect(plain).not.toHaveProperty('verified');
  });

  it('keeps unverified annotations only from 3 votes up, but always keeps verified or accepted ones', () => {
    const list = parseReferents([
      referent({ id: 1, annotations: [{ body: { plain: 'two votes' }, votes_total: 2 }] }),
      referent({ id: 2, annotations: [{ body: { plain: 'three votes' }, votes_total: 3 }] }),
      referent({ id: 3, annotations: [{ body: { plain: 'accepted' }, votes_total: 0, state: 'accepted' }] }),
      referent({ id: 4, annotations: [{ body: { plain: 'verified' }, votes_total: 0, verified: true }] }),
      referent({ id: 5, annotations: [{ body: { plain: 'no vote count' } }] }),
    ]);
    expect(list.map((a) => a.id)).toEqual(['2', '3', '4']);
    expect(list.find((a) => a.id === '3')).not.toHaveProperty('verified');
  });

  it('skips the song description, empty annotations and referents without a fragment', () => {
    const list = parseReferents([
      referent({ id: 1, is_description: true }),
      referent({ id: 2, annotations: [] }),
      referent({ id: 3, annotations: undefined }),
      referent({ id: 4, annotations: [{ body: { plain: '   ' }, votes_total: 10 }] }),
      referent({ id: 5, fragment: '  ' }),
      referent({ id: 6, fragment: undefined }),
      referent({ id: 7 }),
    ]);
    expect(list.map((a) => a.id)).toEqual(['7']);
  });

  it('uses only the first annotation of a referent', () => {
    const [a] = parseReferents([referent({ annotations: [{ body: { plain: 'first' }, votes_total: 4 }, { body: { plain: 'second' }, votes_total: 99 }] })]);
    expect(a).toMatchObject({ text: 'first', votes: 4 });
  });

  it('falls back to the position when a referent has no id, and stringifies ids', () => {
    const list = parseReferents([referent({ id: undefined }), referent({ id: 'abc' })]);
    expect(list.map((a) => a.id)).toEqual(['0', 'abc']);
  });

  it('is empty for no referents', () => {
    expect(parseReferents([])).toEqual([]);
  });
});
