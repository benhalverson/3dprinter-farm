export const BASE_URL = 'https://www.slant3dapi.com/api/' as const;
export const BASE_URL_V2 = 'https://slant3dapi.com/v2/api/' as const;

type SlantV2BaseUrlEnv = {
  SLANT_API_V2_BASE_URL?: string;
};

function withTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

export function slantV2BaseUrl(env?: SlantV2BaseUrlEnv): string {
  const configured = env?.SLANT_API_V2_BASE_URL?.trim();
  return withTrailingSlash(configured || BASE_URL_V2);
}

export function slantV2Url(env: SlantV2BaseUrlEnv | undefined, path: string) {
  return new URL(path.replace(/^\/+/, ''), slantV2BaseUrl(env)).toString();
}

export const STORE_URL = 'http://localhost:3000' as const;

export const SHARED_ORGANIZATION_ID = 'org_shared_catalog' as const;
export const SHARED_ORGANIZATION_NAME = '3D Printer Web API' as const;
export const SHARED_ORGANIZATION_SLUG = '3dprinter-web-api' as const;
