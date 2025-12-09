import { describe, expect, it } from 'vitest';
import { generateSkuNumber } from '../../src/utils/generateSkuNumber';

describe('Generate SKU number', () => {
  it('should generate a unique SKU number with timestamp and random suffix', () => {
    const sku1 = generateSkuNumber('test product');
    const sku2 = generateSkuNumber('test product');
    const sku3 = generateSkuNumber('F1 Chassis');
    const sku4 = generateSkuNumber('White T-Shirt');
    
    // Check format: PREFIX-TIMESTAMP-RANDOM (e.g., TEST-1702123456-A3B9)
    expect(sku1).toMatch(/^[A-Z0-9]{4}-\d{10}-[A-Z0-9]{4}$/);
    expect(sku2).toMatch(/^[A-Z0-9]{4}-\d{10}-[A-Z0-9]{4}$/);
    expect(sku3).toMatch(/^[A-Z0-9]{4}-\d{10}-[A-Z0-9]{4}$/);
    expect(sku4).toMatch(/^[A-Z0-9]{4}-\d{10}-[A-Z0-9]{4}$/);
    
    // Each SKU should be unique
    expect(sku1).not.toEqual(sku2);
    expect(sku1).not.toEqual(sku3);
    
    // Prefix should be derived from product name
    expect(sku1.startsWith('TEST')).toBe(true);
    expect(sku3.startsWith('F1CH')).toBe(true);
    expect(sku4.startsWith('WHIT')).toBe(true);
  });

  it('should handle product names with special characters', () => {
    const sku = generateSkuNumber(' a t4 a - 4 a # $');
    // Should strip special chars and create valid prefix
    expect(sku).toMatch(/^[A-Z0-9]{4}-\d{10}-[A-Z0-9]{4}$/);
    expect(sku.startsWith('AT4A')).toBe(true);
  });

  it('should use default prefix when no product name provided', () => {
    const sku = generateSkuNumber();
    expect(sku).toMatch(/^PROD-\d{10}-[A-Z0-9]{4}$/);
  });

  it('should pad short product names', () => {
    const sku = generateSkuNumber('AB');
    // Should pad to 4 chars with X
    expect(sku.startsWith('ABXX')).toBe(true);
  });
});
