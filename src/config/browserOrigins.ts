/** Exact browser origins shared by CORS and Better Auth; never accept suffix matches. */
export const BROWSER_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:4200',
  'http://localhost:5173',
  'http://localhost:8787',
  'https://rc-store.benhalverson.dev',
  'https://rc-admin.pages.dev',
  'https://api.benhalverson.dev',
  'https://api.luluspeedworks.com',
  'https://race-forge.com',
  'https://luluspeedworks.com',
] as const;
