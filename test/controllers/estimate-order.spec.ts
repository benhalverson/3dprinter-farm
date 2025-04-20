import { describe, it, expect, vi } from 'vitest';
import { Context } from 'hono';
import { estimateOrder, orderSchema } from '../../src/controllers/estimate-order';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

describe('estimateOrder function', () => {

  it('should return error if API call fails', async () => {
		global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({
        error: 'Invalid API key',
        details: {
          error: 'Unauthorized access',
        },
      }),
    });

    const mockData = {
      email: 'test@example.com',
      phone: '1234567890',
      name: 'John Doe',
      orderNumber: '123e4567-e89b-12d3-a456-426614174000',
      filename: 'file.txt',
      fileURL: 'https://example.com/file.txt',
      bill_to_street_1: '123 Main St',
      bill_to_street_2: '',
      bill_to_street_3: '',
      bill_to_city: 'Anytown',
      bill_to_state: 'CA',
      bill_to_zip: '12345',
      bill_to_country_as_iso: 'USA',
      bill_to_is_US_residential: true,
      ship_to_name: 'Jane Doe',
      ship_to_street_1: '456 Elm St',
      ship_to_street_2: '',
      ship_to_street_3: '',
      ship_to_city: 'Othertown',
      ship_to_state: 'TX',
      ship_to_zip: '67890',
      ship_to_country_as_iso: 'USA',
      ship_to_is_US_residential: true,
      order_item_name: 'Widget',
      order_quantity: 2,
      order_image_url: 'https://example.com/image.png',
      order_sku: 'W123',
      order_item_color: 'red',
    };

    const c = {
      req: {
        json: vi.fn().mockResolvedValue(mockData),
      },
      env: {
        SLANT_API: 'fake-api-key',
      },
      json: vi.fn(),
    } as unknown as Context;

    await estimateOrder(c);

    expect(c.json).toHaveBeenCalledWith({
      error: 'Failed to estimate order',
      details: {
        error: 'Invalid API key',
        details: {
          error: 'Unauthorized access',
        },
      },
    }, 400);
  });

  it('should return order estimate if API call succeeds', async () => {
    const mockResponse = {
      totalPrice: 100,
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockResponse),
    });

    const mockData = {
			"email": "sample@sample.com",
			"phone": "123-123-1234",
			"name": "1 test",
			"orderNumber": "1234",
			"filename": "cap.stl",
			"fileURL": "https://pub-0ec69c7d5c064de8b57f5d594f07bc02.r2.dev/cap%20v2.stl",
			"bill_to_street_1": "",
			"bill_to_street_2": "",
			"bill_to_street_3": "",
			"bill_to_city": "",
			"bill_to_state": "CA",
			"bill_to_zip": "",
			"bill_to_country_as_iso": "US",
			"bill_to_is_US_residential": "true",
			"ship_to_name": "Ben Halverson",
			"ship_to_street_1": "",
			"ship_to_street_2": "",
			"ship_to_street_3": "",
			"ship_to_city": "San Jose",
			"ship_to_state": "CA",
			"ship_to_zip": "95134",
			"ship_to_country_as_iso": "US",
			"ship_to_is_US_residential": "true",
			"order_item_name": "Front_rim_2wd_x2.stl",
			"order_quantity": "4",
			"order_image_url": "http://google.com/image.png",
			"order_sku": "1234",
			"order_item_color": "black"
		}

		const c = {
      req: {
        json: vi.fn().mockResolvedValue(mockData),
      },
      env: {
        SLANT_API: 'fake-api-key',
      },
      json: vi.fn(),
    } as unknown as Context;

    await estimateOrder(c);

    expect(c.json).toHaveBeenCalledWith(mockResponse);
  });


  it.skip('should return validation error for invalid request data', async () => {
    const invalidData = { invalidField: 'invalid data' };

    const c = {
      req: {
        valid: vi.fn().mockReturnValue({
          json: vi.fn().mockResolvedValue(invalidData),
        }),
      },
      env: {
        SLANT_API: 'fake-api-key',
      },
      json: vi.fn(),
    } as unknown as Context;

    await estimateOrder(c);

    expect(c.json).toHaveBeenCalledWith({
      error: expect.any(Array), // We expect an array of validation errors
    }, 400);
  });

});
