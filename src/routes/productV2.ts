import { zValidator } from '@hono/zod-validator';
import { eq, inArray } from 'drizzle-orm';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import { ZodError } from 'zod';
import {
  categoryTable,
  productsTable,
  productsToCategories,
  updateProductSchema,
} from '../db/schema';
import factory from '../factory';
import { reserveCatalogAssets } from '../modules/productAssets';
import {
  authMiddleware,
  requireCatalogMutationRole,
} from '../utils/authMiddleware';

type OpenAPISchema = Record<string, unknown>;

const productV2 = factory.createApp().put(
  '/v2/update-product',
  authMiddleware,
  requireCatalogMutationRole,
  describeRoute({
    description:
      'Update an existing product with attachment protection. Uses the original update payload and price behavior; print-file replacement is not supported.',
    tags: ['Products'],
    requestBody: {
      content: {
        'application/json': {
          schema: resolver(updateProductSchema) as OpenAPISchema,
        },
      },
      required: true,
    },
    responses: {
      200: {
        description: 'Product updated successfully',
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
      400: {
        description:
          'Validation error. imageGallery must have at least 1 item if provided.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                error: { type: 'string' },
                details: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
      },
      404: {
        description: 'Product not found',
      },
      500: {
        description: 'Internal server error',
      },
    },
  }),
  zValidator('json', updateProductSchema),
  reserveCatalogAssets,
  async c => {
    try {
      const parsedData = c.req.valid('json');

      // Check if product exists
      const existingProduct = await c.var.db
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, parsedData.id))
        .get();

      if (!existingProduct) {
        return c.json({ error: 'Product not found' }, 404);
      }

      // Normalize category input: accept both categoryId and categoryIds
      const normalizedCategoryIds =
        parsedData.categoryIds || parsedData.categoryId;

      // Validate categories exist if provided
      if (normalizedCategoryIds) {
        // Check for duplicate category IDs
        const uniqueCategoryIds = new Set(normalizedCategoryIds);
        if (uniqueCategoryIds.size !== normalizedCategoryIds.length) {
          return c.json(
            { error: 'Duplicate category IDs are not allowed' },
            400,
          );
        }

        // Validate all category IDs
        const existingCategories = await c.var.db
          .select({ categoryId: categoryTable.categoryId })
          .from(categoryTable)
          .where(inArray(categoryTable.categoryId, normalizedCategoryIds))
          .all();

        if (existingCategories.length !== normalizedCategoryIds.length) {
          const existingCategoryIds = new Set(
            existingCategories.map(c => c.categoryId),
          );
          const missingCategoryIds = normalizedCategoryIds.filter(
            id => !existingCategoryIds.has(id),
          );
          const errorMessage =
            missingCategoryIds.length === 1
              ? `Category with ID ${missingCategoryIds[0]} does not exist`
              : `Categories with IDs ${missingCategoryIds.join(', ')} do not exist`;
          return c.json(
            {
              error: errorMessage,
            },
            400,
          );
        }
      }

      // Prepare update data
      const updateData: {
        name: string;
        description: string;
        price: number;
        filamentType: string;
        color: string;
        image: string;
        imageGallery: string;
        categoryId?: number | null;
      } = {
        name: parsedData.name,
        description: parsedData.description,
        price: parsedData.price,
        filamentType: parsedData.filamentType,
        color: parsedData.color,
        image: parsedData.image,
        imageGallery: JSON.stringify(parsedData.imageGallery || []),
      };

      // Only set categoryId if categories are provided and not empty
      if (normalizedCategoryIds) {
        updateData.categoryId = normalizedCategoryIds[0];

        // Delete existing category associations in join table
        await c.var.db
          .delete(productsToCategories)
          .where(eq(productsToCategories.productId, parsedData.id));

        // Insert new category associations
        await c.var.db.insert(productsToCategories).values(
          normalizedCategoryIds.map((catId, idx) => ({
            productId: parsedData.id,
            categoryId: catId,
            orderIndex: idx,
          })),
        );
      }

      // Update the product
      const updateResult = await c.var.db
        .update(productsTable)
        .set(updateData)
        .where(eq(productsTable.id, parsedData.id))
        .returning({ id: productsTable.id });

      if (updateResult.length) {
        return c.json({
          success: true,
          message: 'Product updated successfully',
        });
      } else {
        return c.json({ error: 'Product update failed' }, 500);
      }
    } catch (error) {
      if (error instanceof ZodError) {
        console.log('error', error);
        return c.json(
          { error: 'Validation error', details: error.errors },
          400,
        );
      }
      console.error('500 update-product error', error);
      return c.json({ error: 'Internal Server Error' }, 500);
    }
  },
);
export default productV2;
