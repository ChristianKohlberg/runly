/**
 * Plain output prints absolute deadlines (a preview's, a lease's) through one
 * helper: today's as a time of day, any other day's with its date, because a
 * preview can run for days and a bare "until 9:20 PM" reads as "tonight".
 */
import { describe, it, expect } from 'vitest';
import { formatDeadline } from '../src/core/units.js';

const dateOf = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo, d, h, mi, s).getTime();

describe('formatDeadline', () => {
  const now = at(2026, 10, 2, 14, 0, 0);

  it('prints only the time of day for a deadline later today', () => {
    const t = at(2026, 10, 2, 21, 20, 3);
    expect(formatDeadline(t, now)).toBe(new Date(t).toLocaleTimeString());
  });

  it('prints only the time of day for a deadline earlier today (an expired preview)', () => {
    const t = at(2026, 10, 2, 0, 5, 0);
    expect(formatDeadline(t, now)).toBe(new Date(t).toLocaleTimeString());
  });

  it('adds the weekday and date for a deadline on another day', () => {
    const t = at(2026, 10, 9, 21, 20, 3);
    const out = formatDeadline(t, now);
    expect(out).toBe(`${dateOf(t)}, ${new Date(t).toLocaleTimeString()}`);
    expect(out).not.toBe(new Date(t).toLocaleTimeString());
    expect(out).not.toContain('2026');
  });

  it('dates tomorrow and yesterday too, even under 24 hours away', () => {
    const late = at(2026, 10, 2, 23, 30);
    const tomorrow = at(2026, 10, 3, 0, 30);
    expect(formatDeadline(tomorrow, late)).toBe(`${dateOf(tomorrow)}, ${new Date(tomorrow).toLocaleTimeString()}`);
    expect(formatDeadline(late, tomorrow)).not.toBe(new Date(late).toLocaleTimeString());
  });

  it('adds the year when the deadline is in another year', () => {
    const t = at(2027, 0, 3, 9, 0, 0);
    const out = formatDeadline(t, at(2026, 11, 30, 12));
    expect(out).toContain('2027');
    expect(out.endsWith(new Date(t).toLocaleTimeString())).toBe(true);
  });

  it('defaults now to the current time', () => {
    const soon = Date.now() + 1000;
    const out = formatDeadline(soon);
    // Either still today (time only) or, right at midnight, dated.
    expect(out.endsWith(new Date(soon).toLocaleTimeString())).toBe(true);
  });
});
