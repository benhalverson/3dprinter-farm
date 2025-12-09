import { zValidator } from '@hono/zod-validator';
import { count, eq, like, or } from 'drizzle-orm';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import Stripe from 'stripe';
import { z, ZodError } from 'zod';

type OpenAPISchema = Record<string, unknown>;
import { BASE_URL, BASE_URL_V2 } from '../constants';
import {
  addProductSchema,
  addCategorySchema,
  categoryDataSchema,
  categoryTable,
  idSchema,
  productsTable,
  productsToCategories,
  updateProductSchema,
} from '../db/schema';
import factory from '../factory';
import { authMiddleware } from '../utils/authMiddleware';
import { calculateMarkupPrice } from '../utils/calculateMarkupPrice';
import { generateSkuNumber } from '../utils/generateSkuNumber';

// Helper function to safely parse imageGallery JSON
function parseImageGallery(imageGallery: string | null): string[] {
  if (!imageGallery) return [];
  try {
    const parsed = JSON.parse(imageGallery);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const product = factory
  .createApp()
  .get(
    '/products',
    describeRoute({
      description: 'Get all products with pagination',
      tags: ['Products'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  products: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'number' },
                        name: { type: 'string' },
                        description: { type: 'string' },
                        image: { type: 'string' },
                        imageGallery: {
                          type: 'array',
                          items: { type: 'string' },
                        },
                        stl: { type: 'string' },
                        price: { type: 'number' },
                        filamentType: { type: 'string' },
                        skuNumber: { type: 'string' },
                        color: { type: 'string' },
                      },
                    },
                  },
                  pagination: {
                    type: 'object',
                    properties: {
                      page: { type: 'number' },
                      limit: { type: 'number' },
                      totalItems: { type: 'number' },
                      totalPages: { type: 'number' },
                      hasNextPage: { type: 'boolean' },
                      hasPreviousPage: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
          description: 'Paginated list of all products',
        },
        400: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string' },
                },
              },
            },
          },
          description: 'Invalid pagination parameters',
        },
      },
    }),
    async c => {
      const pageParam = c.req.query('page');
      const limitParam = c.req.query('limit');

      // Check if pagination is requested
      const isPaginationRequested = pageParam || limitParam;

      try {
        if (!isPaginationRequested) {
          // Return simple array for backward compatibility
          const rawProducts = await c.var.db
            .select({
              id: productsTable.id,
              name: productsTable.name,
              description: productsTable.description,
              image: productsTable.image,
              imageGallery: productsTable.imageGallery,
              stl: productsTable.stl,
              price: productsTable.price,
              filamentType: productsTable.filamentType,
              skuNumber: productsTable.skuNumber,
              color: productsTable.color,
            })
            .from(productsTable)
            .all();

          // Parse imageGallery safely
          const products = rawProducts.map(product => ({
            ...product,
            imageGallery: parseImageGallery(product.imageGallery),
          }));

          return c.json(products);
        }

        // Parse pagination parameters
        const page = pageParam ? Math.max(1, parseInt(pageParam, 10)) : 1;
        const limit = limitParam
          ? Math.min(100, Math.max(1, parseInt(limitParam, 10)))
          : 10;
        const offset = (page - 1) * limit;

        // Validate pagination parameters
        if (Number.isNaN(page) || Number.isNaN(limit)) {
          return c.json(
            {
              error:
                'Invalid pagination parameters. Page and limit must be numbers.',
            },
            400,
          );
        }

        // Get total count for pagination
        const [totalCountResult] = await c.var.db
          .select({ count: count() })
          .from(productsTable);

        const totalItems = totalCountResult.count;
        const totalPages = Math.ceil(totalItems / limit);

        // Get paginated results without Stripe fields
        const rawProducts = await c.var.db
          .select({
            id: productsTable.id,
            name: productsTable.name,
            description: productsTable.description,
            image: productsTable.image,
            imageGallery: productsTable.imageGallery,
            stl: productsTable.stl,
            price: productsTable.price,
            filamentType: productsTable.filamentType,
            skuNumber: productsTable.skuNumber,
            color: productsTable.color,
          })
          .from(productsTable)
          .limit(limit)
          .offset(offset)
          .all();

        // Parse imageGallery safely
        const products = rawProducts.map(product => ({
          ...product,
          imageGallery: parseImageGallery(product.imageGallery),
        }));

        const pagination = {
          page,
          limit,
          totalItems,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        };

        return c.json({
          products,
          pagination,
        });
      } catch (error) {
        console.error('Error fetching products:', error);
        return c.json({ error: 'Failed to fetch products' }, 500);
      }
    },
  )
  .use('/products/search', authMiddleware)
  .get(
    '/products/search',
    describeRoute({
      description: 'Search products by name and description with pagination',
      tags: ['Products'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  products: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'number' },
                        name: { type: 'string' },
                        description: { type: 'string' },
                        image: { type: 'string' },
                        imageGallery: {
                          type: 'array',
                          items: { type: 'string' },
                        },
                        stl: { type: 'string' },
                        price: { type: 'number' },
                        filamentType: { type: 'string' },
                        skuNumber: { type: 'string' },
                        color: { type: 'string' },
                      },
                    },
                  },
                  pagination: {
                    type: 'object',
                    properties: {
                      page: { type: 'number' },
                      limit: { type: 'number' },
                      totalItems: { type: 'number' },
                      totalPages: { type: 'number' },
                      hasNextPage: { type: 'boolean' },
                      hasPreviousPage: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
          description: 'Paginated list of products matching the search query',
        },
        400: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string' },
                },
              },
            },
          },
          description: 'Invalid search query or pagination parameters',
        },
      },
    }),
    async c => {
      const query = c.req.query('q');
      const pageParam = c.req.query('page');
      const limitParam = c.req.query('limit');

      if (!query) {
        return c.json({ error: 'Search query is required' }, 400);
      }

      if (query.trim().length < 2) {
        return c.json(
          { error: 'Search query must be at least 2 characters long' },
          400,
        );
      }

      // Parse pagination parameters
      const page = pageParam ? Math.max(1, parseInt(pageParam, 10)) : 1;
      const limit = limitParam
        ? Math.min(100, Math.max(1, parseInt(limitParam, 10)))
        : 10;
      const offset = (page - 1) * limit;

      // Validate pagination parameters
      if (Number.isNaN(page) || Number.isNaN(limit)) {
        return c.json(
          {
            error:
              'Invalid pagination parameters. Page and limit must be numbers.',
          },
          400,
        );
      }

      try {
        const searchTerm = `%${query.trim()}%`;
        const whereClause = or(
          like(productsTable.name, searchTerm),
          like(productsTable.description, searchTerm),
        );

        // Get total count for pagination
        const [totalCountResult] = await c.var.db
          .select({ count: count() })
          .from(productsTable)
          .where(whereClause);

        const totalItems = totalCountResult.count;
        const totalPages = Math.ceil(totalItems / limit);

        // Get paginated results
        const rawProducts = await c.var.db
          .select({
            id: productsTable.id,
            name: productsTable.name,
            description: productsTable.description,
            image: productsTable.image,
            imageGallery: productsTable.imageGallery,
            stl: productsTable.stl,
            price: productsTable.price,
            filamentType: productsTable.filamentType,
            skuNumber: productsTable.skuNumber,
            color: productsTable.color,
          })
          .from(productsTable)
          .where(whereClause)
          .limit(limit)
          .offset(offset)
          .all();

        // Parse imageGallery safely
        const products = rawProducts.map(product => ({
          ...product,
          imageGallery: parseImageGallery(product.imageGallery),
        }));

        const pagination = {
          page,
          limit,
          totalItems,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        };

        return c.json({
          products,
          pagination,
        });
      } catch (error) {
        console.error('Error searching products:', error);
        return c.json({ error: 'Failed to search products' }, 500);
      }
    },
  )
  .use('/add-product', authMiddleware)
  .use('/update-product', authMiddleware)
  .post(
    '/add-product',
    describeRoute({
      description: 'Add a new product',
      tags: ['Products'],
      requestBody: {
        content: {
          'application/json': {
            schema: resolver(addProductSchema) as any,
          },
        },
        required: true,
      },
      responses: {
        201: {
          content: {
            'application/json': {
              schema: resolver(addProductSchema) as any,
            },
          },
          description: 'The product was created successfully',
        },
        400: {
          content: {
            'application/json': {
              schema: resolver(addProductSchema) as any,
            },
          },
          description: 'Missing or invalid parameters',
        },
      },
    }),
    zValidator('json', addProductSchema),
    async c => {
      const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
        telemetry: false,
      });
      const user = c.get('jwtPayload') as { id: number; email: string };
      if (!user) return c.json({ error: 'Unauthorized' }, 401);
      const data = await c.req.valid('json');
      const { categoryIds, categoryId, imageGallery, ...rest } = data as any;
      // Normalize category inputs: accept categoryIds array, categoryId number, or categoryId array
      let normalizedCategoryIds: number[] | undefined;
      if (Array.isArray(categoryIds)) {
        normalizedCategoryIds = categoryIds;
      } else if (Array.isArray(categoryId)) {
        normalizedCategoryIds = categoryId;
      } else if (typeof categoryId === 'number') {
        normalizedCategoryIds = [categoryId];
      }
      const skuNumber = generateSkuNumber(data.name, data.color);

      const stripeProduct = await stripe.products.create({
        name: data.name,
        description: data.description,
        images: [data.image],
        shippable: true,
        metadata: {
          sku_number: skuNumber,
        },
      });

      const slicingResponse = await fetch(`${BASE_URL}slicer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': c.env.SLANT_API,
        },
        body: JSON.stringify({ fileURL: data.stl, sku_number: skuNumber }),
      });

      if (!slicingResponse.ok) {
        const error = (await slicingResponse.json()) as Error;
        console.log('slicing error', error);
        return c.json(
          { error: 'Failed to slice file', details: error.message },
          500,
        );
      }

      const slicingResult = (await slicingResponse.json()) as {
        data: { price: number };
      };
      console.log('slicing result', slicingResult);
      const basePrice = slicingResult.data.price;
      const markupPrice = calculateMarkupPrice(basePrice, data.price);

      let stripePriceId = null;
      if (markupPrice) {
        const price = await stripe.prices.create({
          product: stripeProduct.id,
          unit_amount: Math.round(markupPrice * 100), // Stripe expects the amount in cents
          currency: 'usd',
        });
        stripePriceId = price.id;
      }

      console.log('data.imageGallery before insertion', imageGallery);
      // Use first category as primary if provided; otherwise leave null
      const primaryCategoryId =
        normalizedCategoryIds && normalizedCategoryIds.length > 0
          ? normalizedCategoryIds[0]
          : null;

      const productDataToInsert = {
        ...rest,
        price: markupPrice,
        skuNumber: skuNumber,
        stripeProductId: stripeProduct.id,
        stripePriceId: stripePriceId,
        imageGallery: JSON.stringify(imageGallery || []),
        categoryId: primaryCategoryId,
      };

      console.log('Inserting product:', productDataToInsert);

      try {
        const response = await c.var.db
          .insert(productsTable)
          .values(productDataToInsert)
          .returning();
        console.log('response', response);

        // Insert category links into join table (if any provided)
        const created = response[0];
        if (
          created &&
          Array.isArray(normalizedCategoryIds) &&
          normalizedCategoryIds.length > 0
        ) {
          for (const [idx, catId] of normalizedCategoryIds.entries()) {
            await c.var.db.insert(productsToCategories).values({
              productId: created.id,
              categoryId: catId,
              orderIndex: idx,
            });
          }
        }

        return c.json(response);
      } catch (error) {
        console.error('Error adding product', error);
        return c.json({ error: 'Failed to add product' }, 500);
      }
    },
  )
  .use('/v2/add-product', authMiddleware)
  .post(
    '/v2/add-product',
    describeRoute({
      description: 'Add a new product using Slant3D V2 API',
      tags: ['Products'],
      requestBody: {
        content: {
          'application/json': {
            schema: resolver(addProductSchema) as any,
          },
        },
        required: true,
      },
      responses: {
        201: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  message: { type: 'string' },
                  product: {
                    type: 'object',
                    properties: {
                      id: { type: 'number' },
                      name: { type: 'string' },
                      price: { type: 'number' },
                      skuNumber: { type: 'string' },
                      publicFileServiceId: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          description: 'The product was created successfully using V2 API',
        },
        400: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string' },
                  details: { type: 'string' },
                },
              },
            },
          },
          description: 'Missing or invalid parameters',
        },
        500: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string' },
                  details: { type: 'string' },
                },
              },
            },
          },
          description: 'Internal server error',
        },
      },
    }),
    zValidator('json', addProductSchema),
    async c => {
      try {
        const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
          telemetry: false,
        });
        const user = c.get('jwtPayload') as { id: number; email: string };
        if (!user) return c.json({ error: 'Unauthorized' }, 401);

        const data = await c.req.valid('json');
        const { categoryIds, categoryId, imageGallery, ...rest } = data as any;
        let normalizedCategoryIds: number[] | undefined;
        if (Array.isArray(categoryIds)) {
          normalizedCategoryIds = categoryIds;
        } else if (Array.isArray(categoryId)) {
          normalizedCategoryIds = categoryId;
        } else if (typeof categoryId === 'number') {
          normalizedCategoryIds = [categoryId];
        }
        const skuNumber = generateSkuNumber(data.name, data.color);

        // Step 1: Create Stripe product
        const stripeProduct = await stripe.products.create({
          name: data.name,
          description: data.description,
          images: [data.image],
          shippable: true,
          metadata: {
            sku_number: skuNumber,
          },
        });

        // Step 2: Get presigned URL from Slant3D V2 API
        const presignedRequest = {
          name: data.name.replace(/\.stl$/i, ''),
          platformId: c.env.SLANT_PLATFORM_ID,
          ownerId: user.id.toString(),
        };

        console.log('Getting presigned URL:', presignedRequest);

        const presignedResponse = await fetch(
          `${BASE_URL_V2}files/direct-upload`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${c.env.SLANT_API_V2}`,
            },
            body: JSON.stringify(presignedRequest),
          },
        );

        if (!presignedResponse.ok) {
          const errorText = await presignedResponse.text();
          console.error('V2 presigned error:', errorText);
          return c.json(
            {
              error: 'Failed to get presigned URL from Slant3D V2 API',
              details: errorText,
            },
            500,
          );
        }

        const presignedData = (await presignedResponse.json()) as {
          data: {
            presignedUrl: string;
            filePlaceholder: {
              publicFileServiceId: string;
              name: string;
              ownerId: string;
              platformId: string;
              type: string;
              createdAt: string;
              updatedAt: string;
            };
          };
        };

        const { presignedUrl, filePlaceholder } = presignedData.data;
        console.log('Got presigned URL, uploading file...');

        // Step 3: Download the file from R2 and upload to presigned URL
        let fileBuffer: Buffer;
        try {
          const fileResponse = await fetch(data.stl);
          if (!fileResponse.ok) {
            throw new Error(`Failed to fetch file from R2: ${fileResponse.statusText}`);
          }
          fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
        } catch (err: any) {
          console.error('Failed to fetch file:', err);
          return c.json(
            {
              error: 'Failed to fetch STL file from storage',
              details: err.message,
            },
            500,
          );
        }

        // Upload to presigned URL
        try {
          const uploadResponse = await fetch(presignedUrl, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/octet-stream',
            },
            body: fileBuffer,
          });
          if (!uploadResponse.ok) {
            throw new Error(`Upload failed: ${uploadResponse.statusText}`);
          }
          console.log('File uploaded to presigned URL');
        } catch (err: any) {
          console.error('Failed to upload to presigned URL:', err);
          return c.json(
            {
              error: 'Failed to upload file to Slant3D',
              details: err.message,
            },
            500,
          );
        }

        // Step 4: Confirm the upload
        console.log('Confirming upload...');
        const confirmResponse = await fetch(`${BASE_URL_V2}files/confirm-upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${c.env.SLANT_API_V2}`,
          },
          body: JSON.stringify({ filePlaceholder }),
        });

        if (!confirmResponse.ok) {
          const errorText = await confirmResponse.text();
          console.error('V2 confirm error:', errorText);
          return c.json(
            {
              error: 'Failed to confirm upload with Slant3D V2 API',
              details: errorText,
            },
            500,
          );
        }

        const confirmData = (await confirmResponse.json()) as {
          data: {
            publicFileServiceId: string;
            STLMetrics?: {
              x: number;
              y: number;
              z: number;
            };
          };
        };

        const publicFileServiceId = confirmData.data.publicFileServiceId;

        // Step 5: Get estimate from Slant3D V2 API using the confirmed file ID
        const DEFAULT_BLACK_FILAMENT_ID =
          '76fe1f79-3f1e-43e4-b8f4-61159de5b93c';
        const estimateOptions = {
          options: {
            filamentId: DEFAULT_BLACK_FILAMENT_ID,
            quantity: 1,
          },
        };

        console.log('Requesting estimate for:', publicFileServiceId);

        const estimateResponse = await fetch(
          `${BASE_URL_V2}files/${publicFileServiceId}/estimate`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${c.env.SLANT_API_V2}`,
            },
            body: JSON.stringify(estimateOptions),
          },
        );

        if (!estimateResponse.ok) {
          const errorText = await estimateResponse.text();
          console.error('V2 estimate error:', errorText);
          return c.json(
            {
              error: 'Failed to get price estimate from Slant3D V2 API',
              details: errorText,
            },
            500,
          );
        }

        const estimateDataRaw = (await estimateResponse.json()) as any;
        console.log('Slant3D estimate raw response:', JSON.stringify(estimateDataRaw));

        // Handle both possible response structures from Slant3D
        // V2 API returns: { total, pricePerUnit, subtotal, etc }
        const basePrice = estimateDataRaw.data?.total ?? 
                         estimateDataRaw.data?.pricePerUnit ?? 
                         estimateDataRaw.data?.subtotal ?? 
                         estimateDataRaw.data?.estimatedCost ?? 
                         estimateDataRaw.total ?? 
                         estimateDataRaw.pricePerUnit ?? 
                         estimateDataRaw.estimatedCost ?? 
                         estimateDataRaw.cost;

        console.log('Slant3D estimated base price:', basePrice);
        console.log('Markup percentage from request:', data.price);
        
        if (!basePrice || basePrice <= 0) {
          return c.json(
            {
              error: 'Invalid price estimate from Slant3D',
              details: `Expected positive price but got: ${basePrice}. Full response: ${JSON.stringify(estimateDataRaw)}`,
            },
            500,
          );
        }
        
        let markupPrice: number;
        try {
          markupPrice = calculateMarkupPrice(basePrice, data.price);
        } catch (err: any) {
          console.error('Error calculating markup price:', err.message);
          return c.json(
            {
              error: 'Failed to calculate product price',
              details: err.message,
            },
            400,
          );
        }

        console.log('Final markup price:', markupPrice);

        // Step 6: Create Stripe price
        let stripePriceId = null;
        if (markupPrice && markupPrice > 0) {
          const price = await stripe.prices.create({
            product: stripeProduct.id,
            unit_amount: Math.round(markupPrice * 100),
            currency: 'usd',
          });
          stripePriceId = price.id;
        }

        // Step 7: Insert into database
        const primaryCategoryId =
          normalizedCategoryIds && normalizedCategoryIds.length > 0
            ? normalizedCategoryIds[0]
            : null;

        const productDataToInsert = {
          ...rest,
          price: markupPrice,
          skuNumber: skuNumber,
          stripeProductId: stripeProduct.id,
          stripePriceId: stripePriceId,
          imageGallery: JSON.stringify(imageGallery || []),
          categoryId: primaryCategoryId,
          publicFileServiceId: publicFileServiceId,
        };

        console.log('Product data to insert:', productDataToInsert);

        const insertResponse = await c.var.db
          .insert(productsTable)
          .values(productDataToInsert)
          .returning();

        const created = insertResponse[0];

        // Insert category links
        if (
          created &&
          Array.isArray(normalizedCategoryIds) &&
          normalizedCategoryIds.length > 0
        ) {
          for (const [idx, catId] of normalizedCategoryIds.entries()) {
            await c.var.db.insert(productsToCategories).values({
              productId: created.id,
              categoryId: catId,
              orderIndex: idx,
            });
          }
        }

        return c.json(
          {
            success: true,
            message: 'Product created successfully using V2 API',
            product: {
              id: created.id,
              name: created.name,
              price: created.price,
              skuNumber: created.skuNumber,
              publicFileServiceId: publicFileServiceId,
            },
          },
          201,
        );
      } catch (error: any) {
        console.error('V2 add-product error:', error);
        return c.json(
          {
            error: 'Failed to add product',
            details: error.message || 'Unknown error',
          },
          500,
        );
      }
    },
  )

  .get(
    '/product/:id',
    describeRoute({
      description: 'Get a product by ID',
      tags: ['Products'],
    }),
    async c => {
      const idParam = c.req.param('id');
      const parsedData = idSchema.parse({ id: Number(idParam) });
      const response = await c.var.db
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, parsedData.id));
      const rawProduct = response[0];

      if (!rawProduct) {
        return c.json({ error: 'Product not found' }, 404);
      }

      // Parse imageGallery safely for individual product
      const product = {
        ...rawProduct,
        imageGallery: parseImageGallery(rawProduct.imageGallery),
      };

      return c.json(product);
    },
  )
  .put(
    '/update-product',
    describeRoute({
      description: 'Update an existing product',
      tags: ['Products'],
    }),
    async c => {
      try {
        const body = await c.req.json();
        const parsedData = updateProductSchema.parse(body);
        const updateResult = await c.var.db
          .update(productsTable)
          .set({
            name: parsedData.name,
            description: parsedData.description,
            price: parsedData.price,
            filamentType: parsedData.filamentType,
            color: parsedData.color,
            image: parsedData.image,
            imageGallery: JSON.stringify(parsedData.imageGallery || []),
          })
          .where(eq(productsTable.id, parsedData.id));

        if (updateResult) {
          return c.json({
            success: true,
            message: 'Product updated successfully',
          });
        } else {
          return c.json({ error: 'Product not found or update failed' }, 404);
        }
      } catch (error) {
        if (error instanceof ZodError) {
          console.log('error', error);
          return c.json(
            { error: 'Validation error', details: error.errors },
            400,
          );
        }
        return c.json({ error: 'Internal Server Error' }, 500);
      }
    },
  )
  .delete(
    '/delete-product/:id',
    authMiddleware,
    describeRoute({
      description: 'Delete a product by ID',
      tags: ['Products'],
      parameters: [],
      responses: {
        200: {
          description: 'Product deleted successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
      },
    }),
    async c => {
      try {
        const idParam = c.req.param('id');
        const parsedData = idSchema.parse({ id: Number(idParam) });
        const deleteResult = await c.var.db
          .delete(productsTable)
          .where(eq(productsTable.id, parsedData.id));

        if (deleteResult) {
          return c.json({
            success: true,
            message: 'Product deleted successfully',
          });
        } else {
          return c.json({ error: 'Product not found or delete failed' }, 404);
        }
      } catch (error) {
        if (error instanceof ZodError) {
          console.log('error', error);
          return c.json(
            { error: 'Validation error', details: error.errors },
            400,
          );
        }
        return c.json({ error: 'Internal Server Error' }, 500);
      }
    },
  )
  .post(
    '/add-category',
    describeRoute({
      summary: 'Add a new product category',
      description: 'Creates a new category and returns the created record.',
      tags: ['Product'],
      requestBody: {
        content: {
          'application/json': {
            schema: resolver(addCategorySchema) as unknown as OpenAPISchema,
          },
        },
        required: true,
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: resolver(categoryDataSchema.array()) as unknown as OpenAPISchema,
            },
          },
          description: 'Category created successfully',
        },
        500: {
          content: {
            'application/json': {
              schema: resolver(z.object({
                error: z.string(),
              })) as unknown as OpenAPISchema,
            },
          },
          description: 'Failed to add category',
        },
      },
    }),
    zValidator('json', addCategorySchema),
    async c => {
      const categoryData = c.req.valid('json');
      try {
        const newCategory = await c.var.db
          .insert(categoryTable)
          .values(categoryData)
          .returning();
        return c.json(newCategory);
      } catch (error) {
        console.error('Error adding category', error);
        return c.json({ error: 'Failed to add category' }, 500);
      }
    },
  )
  .get(
    '/categories',
    describeRoute({
      summary: 'Get all product categories',
      description: 'Retrieves a list of all available product categories.',
      tags: ['Product'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: resolver(categoryDataSchema.array()) as unknown as OpenAPISchema,
            },
          },
          description: 'List of categories retrieved successfully',
        },
        500: {
          content: {
            'application/json': {
              schema: resolver(z.object({
                error: z.string(),
              })) as unknown as OpenAPISchema,
            },
          },
          description: 'Failed to fetch categories',
        },
      },
    }),
    async c => {
      try {
        const categories = await c.var.db.select().from(categoryTable);
        return c.json(categories);
      } catch (error) {
        console.error('Error fetching categories', error);
        return c.json({ error: 'Failed to fetch categories' }, 500);
      }
    },
  );

export default product;
