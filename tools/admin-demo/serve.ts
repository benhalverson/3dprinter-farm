import { createDemoRuntime } from './runtime.ts';

const runtime = await createDemoRuntime({
  port: Number(process.env.DEMO_PORT ?? 8790),
});
console.info(`Local demo API: ${runtime.url}`);
console.info(
  'POST /__fixture/login with x-demo-fixture-token: lulu-local-demo and JSON {"role":"admin"}; use credentials: include.',
);
console.info(
  'Seeded products: 1 mapped, 2 legacy. Temporary D1/R2; deterministic local providers.',
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    await runtime.close();
    process.exit(0);
  });
