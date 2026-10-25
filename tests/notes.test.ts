import './setup';
import { describe, expect, it } from 'vitest';
import type { GeniusAnnotation, Note } from '../src/core/types';
import { geniusFor } from '../src/ui/notes';

const ann = (id: string, fragment: string, votes = 1, verified = false): GeniusAnnotation => ({ id, fragment, text: `about ${fragment}`, votes, ...(verified ? { verified } : {}) });
const note = (phrase: string, genius?: string): Note => ({ kind: 'reference', phrase, text: '説明', ...(genius ? { genius } : {}) });

const annotations = [
  ann('11592548', "Who that nigga thinkin' that he frontin' on Man-Man? (Man-Man)", 50),
  ann('11592600', "Get the fuck off my stage, I'm the Sandman (Sandman)", 120),
  ann('11592601', 'Sandman', 3),
];

describe('geniusFor', () => {
  it('keeps a cited annotation that is about the phrase', () => {
    expect(geniusFor(note('Man-Man', '11592548'), annotations)).toEqual({ annotation: annotations[0], cited: true });
  });

  it('rejects a citation of a neighbouring line and falls back to the best overlapping annotation', () => {
    const line = "Get the fuck off my stage, I'm the Sandman (Sandman)";
    const result = geniusFor(note('Sandman', '11592548'), annotations, line);
    expect(result?.cited).toBe(false);
    expect(result?.annotation.id).toBe('11592600');
  });

  it('accepts a citation whose fragment is the whole line containing the phrase', () => {
    const line = "Get the fuck off my stage, I'm the Sandman (Sandman)";
    expect(geniusFor(note('my stage', '11592600'), annotations, line)?.cited).toBe(true);
  });

  it('returns null without annotations or any overlap', () => {
    expect(geniusFor(note('Parmesan'), null)).toBeNull();
    expect(geniusFor(note('Parmesan'), annotations)).toBeNull();
  });

  it('prefers verified annotations', () => {
    const list = [ann('a', 'Sandman here', 90), ann('b', 'the Sandman here', 5, true)];
    expect(geniusFor(note('Sandman'), list)?.annotation.id).toBe('b');
  });
});
