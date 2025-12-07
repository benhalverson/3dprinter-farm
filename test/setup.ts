import { mockAuth } from './mocks/auth';
import { mockDrizzle } from './mocks/drizzle';
import { mockGlobalFetch } from './mocks/fetch';

// Setup all mocks globally
mockAuth();
mockDrizzle();
mockGlobalFetch();
