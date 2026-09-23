import { advancedWatermark } from './read-state';

describe('the read watermark', () => {
  it('moves forward', () => {
    expect(advancedWatermark(3, 7, 10)).toBe(7);
  });

  // A stale device reporting an older position cannot un-read anything.
  it('never moves backward', () => {
    expect(advancedWatermark(7, 3, 10)).toBe(7);
  });

  it('never passes the last message', () => {
    expect(advancedWatermark(3, 99, 10)).toBe(10);
  });
});
