import { Context } from 'hono';
import { z } from 'zod';
import {
	ErrorResponse,
	FilamentColorsResponse,
	ListResponse,
	OrderData,
	OrderResponse,
	SliceResponse,
} from '../types';
import { BASE_URL } from '../constants';
import { authMiddleware } from '../utils/authMiddleware';
import { orderSchema } from '../db/schema';
import factory from '../factory';

const printer = factory.createApp()
  .use("/list", authMiddleware)
  .use("/estimate", authMiddleware)
  // .use("/upload", authMiddleware)
  .get("/list", async (c: Context) => {
    const list = await c.env.BUCKET.list()
    const data = list.objects.map((o: ListResponse) => {
      return {
        stl: o.key,
        size: o.size,
        version: o.version,
      }
    })
    return c.json(data)
  })
  .post("/upload", async (c: Context) => {
    const body = await c.req.parseBody()

    if (!body || !body.file) {
      return c.json({ error: "No file uploaded" }, 400)
    }

    const file = body.file as File

    try {
      const bucket = c.env.BUCKET
      const key = `${file.name}`

      await bucket.put(key, file.stream(), {
        httpMetadata: { contentType: file.type },
      })

      return c.json({ message: "File uploaded", key })
    } catch (error) {
      console.error("error", error)
      return c.json({ error: "Failed to upload file" }, 500)
    }
  })
  /**
   * Lists the available colors for the filament
   * @param filamentType The type of filament to list colors for (PLA or PETG)
   * @returns The list of colors for the filament
   */
  .post("/slice", async (c: Context) => {
    const fileURL = await c.req.json()
    try {
      const response = await fetch(`${BASE_URL}slicer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": c.env.SLANT_API,
        },
        body: JSON.stringify(fileURL),
      })

      if (!response.ok) {
        const error: ErrorResponse = await response.json()
        return c.json({ error: "Failed to slice file", details: error }, 500)
      }

      const result: SliceResponse = await response.json()
      return c.json(result)
    } catch (error: any) {
      console.error("error", error)
      return c.json({ error: "Failed to slice file", details: error.message }, 500)
    }
  })
  .get("/colors", async (c: Context) => {
    const query = c.req.query("filamentType")
    const normalizedQuery = query?.toUpperCase()
    const cacheKey = `3dprinter-web-api-COLOR_CACHE:${normalizedQuery}`

    const cachedResponse = await c.env.COLOR_CACHE.get(cacheKey)

    if (cachedResponse) {
      console.log(`Cached Hit for key ${normalizedQuery}`)
      return c.json(JSON.parse(cachedResponse))
    }

    if (query) {
      const validationResult = FilamentTypeSchema.safeParse(query)

      if (!validationResult.success) {
        return c.json(
          {
            error: "Invalid filament type",
            message: validationResult.error.issues[0].message,
          },
          400,
        )
      }
    }

    const response = await fetch(`${BASE_URL}filament`, {
      headers: {
        "Content-Type": "application/json",
        "api-key": c.env.SLANT_API,
      },
    })

    if (!response.ok) {
      const error = (await response.json()) as ErrorResponse
      return c.json({ error: "Failed to get colors", details: error }, 500)
    }

    const result = (await response.json()) as FilamentColorsResponse

    const filteredFilaments = result.filaments
      .filter(filament => !query || filament.profile === query) // Return all if no query, or filter by query
      .map(({ filament, hexColor, colorTag }) => ({
        filament,
        hexColor,
        colorTag,
      }))
      .sort((a, b) => a.colorTag.localeCompare(b.hexColor))

    await c.env.COLOR_CACHE.put(cacheKey, JSON.stringify(filteredFilaments), {
      expirationTtl: 604800, // 1 week
    })

    return c.json(filteredFilaments)
  })
  .post("/estimate", async (c: Context) => {
    try {
      const data = await c.req.json()
      const parsedData: OrderData = orderSchema.parse(data)

      const response = await fetch(`${BASE_URL}order/estimate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": c.env.SLANT_API,
        },
        body: JSON.stringify(parsedData),
      })

      if (!response.ok) {
        const error = await response.json()
        return c.json({ error: "Failed to estimate order", details: error }, 500)
      }

      const result = (await response.json()) as OrderResponse
      return c.json(result)
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: error.errors }, 400)
      }
      return c.json({ error: "Failed to estimate order" }, 500)
    }
  })

export default printer;

const FilamentTypeSchema = z.enum(['PLA', 'PETG'], {
	errorMap: () => ({
		message: 'Accepted values are "PLA" and "PETG".',
	}),
});
