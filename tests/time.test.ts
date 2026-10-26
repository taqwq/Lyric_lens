import './setup';
import { describe, expect, it } from 'vitest';
import { nextPacificMidnight } from '../src/llm/chain';
import { formatWhen } from '../src/ui/time';

// 2026-10-26 12:00 JST (03:00 UTC): Pacific daylight time, so the reset is 16:00 JST.
const NOW = Date.UTC(2026, 9, 26, 3, 0);

describe('formatWhen', () => {
  it('shows a Pacific-midnight reset as the hour, not the engine\'s safety minute', () => {
    const until = nextPacificMidnight(NOW);
    expect(new Date(until).getUTCMinutes()).toBe(1);
    expect(formatWhen(until, NOW)).toBe('16:00');
  });

  it('prefixes 明日 when the reset falls on the next Japan date', () => {
    const evening = Date.UTC(2026, 9, 26, 9, 30); // 18:30 JST, after today's reset
    expect(formatWhen(nextPacificMidnight(evening), evening)).toBe('明日 16:00');
  });

  it('keeps an arbitrary reset time as it is', () => {
    expect(formatWhen(Date.UTC(2026, 9, 26, 9, 37), NOW)).toBe('18:37');
  });

  it('reads 17:00 once Pacific time is back on standard time', () => {
    const winter = Date.UTC(2026, 10, 10, 3, 0); // 2026-11-10 12:00 JST
    expect(formatWhen(nextPacificMidnight(winter), winter)).toBe('17:00');
  });
});
