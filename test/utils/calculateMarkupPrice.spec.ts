import { describe, expect, it } from 'vitest';
import { calculateMarkupPrice } from '../../src/utils/calculateMarkupPrice';

describe('calculateMarkupPrice', () => {
  it('should handle a valid markup percentage', () => {
    const basePrice = 100;
    const markupPercentage = 20;
    const result = calculateMarkupPrice(basePrice, markupPercentage);
    expect(result).toBe(120); // 100 + 20% of 100 = 120
  });

  it('should throw an error for 0% markup', () => {
    const basePrice = 100;
    const markupPercentage = 0;
    expect(() => calculateMarkupPrice(basePrice, markupPercentage)).toThrow(
      'Invalid markup percentage',
    );
  });

  it('should throw an error for negative markup percentage', () => {
    const basePrice = 100;
    const markupPercentage = -5;
    expect(() => calculateMarkupPrice(basePrice, markupPercentage)).toThrow(
      'Invalid markup percentage',
    );
  });
});
