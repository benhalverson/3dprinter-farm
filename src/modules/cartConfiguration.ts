import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { BASE_URL_V2 } from '../constants';
import { type addCartItemSchema, productsTable } from '../db/schema';
import type { WorkerEnv } from '../factory';

const filamentsSchema = z.object({
  success: z.literal(true),
  data: z.array(
    z.object({
      publicId: z.string().uuid(),
      profile: z.string(),
      hexValue: z.string(),
      color: z.string(),
      provider: z.string(),
      available: z.boolean(),
    }),
  ),
});

export async function validateCartConfiguration(
  db: WorkerEnv['Variables']['db'],
  env: Pick<WorkerEnv['Bindings'], 'COLOR_CACHE' | 'SLANT_API_V2'>,
  input: z.infer<typeof addCartItemSchema>,
) {
  const [product] = await db
    .select({ filamentType: productsTable.filamentType })
    .from(productsTable)
    .where(eq(productsTable.skuNumber, input.skuNumber))
    .all();
  if (!product || product.filamentType !== input.filamentType) {
    throw new HTTPException(400, { message: 'Product or material is invalid' });
  }
  const cached = await env.COLOR_CACHE.get(
    `v2:colors:${product.filamentType}:true:all`,
  );
  let filaments: z.infer<typeof filamentsSchema>;
  try {
    if (cached) {
      filaments = filamentsSchema.parse(JSON.parse(cached));
    } else {
      const response = await fetch(`${BASE_URL_V2}filaments`, {
        headers: { Authorization: `Bearer ${env.SLANT_API_V2}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Filament service unavailable');
      filaments = filamentsSchema.parse(await response.json());
    }
  } catch {
    throw new HTTPException(503, {
      message: 'Cannot verify filament availability; try again',
    });
  }
  const filament = filaments.data.find(
    item => item.publicId === input.filamentId,
  );
  if (
    !filament ||
    !filament.available ||
    filament.provider.toLowerCase() !== 'slant 3d' ||
    filament.profile !== product.filamentType ||
    ![filament.hexValue.toLowerCase(), filament.color.toLowerCase()].includes(
      input.color.toLowerCase(),
    )
  ) {
    throw new HTTPException(400, {
      message: 'Choose an available color for this material',
    });
  }
}
