import { describe, test, expect, vi, beforeEach } from 'vitest'
import app from '../../src/index'

vi.mock('../../src/db/schema', async () => {
  const actual = await import('../../src/db/schema')
  return {
    ...actual,
    users: {}, // if accessed directly
  }
})

vi.mock('drizzle-orm/d1', () => {
  return {
    drizzle: vi.fn(() => ({
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([{ id: 1, email: 'mock@test.com' }]),
        }),
      }),
    })),
  }
})


// Mock crypto utils
vi.mock('../../src/utils/crypto', async () => {
  return {
    hashPassword: vi.fn(() =>
      Promise.resolve({ salt: 'mock-salt', hash: 'mock-hash' })
    ),
    signJWT: vi.fn(() => Promise.resolve('mock.jwt.token')),
  }
})

// Import mocked utils to assert calls
import { hashPassword, signJWT } from '../../src/utils/crypto'

function mockEnv() {
  return {
//     DB: {
//       select: () => ({
//         from: () => ({
//           where: () => Promise.resolve([]),
//         }),
//       }),
//       insert: () => ({
//         values: () => ({
//           returning: () =>
//             Promise.resolve([{ id: 1, email: 'user@example.com' }]),
//         }),
//       }),
//     },
    JWT_SECRET: 'test-secret',
    RATE_LIMIT_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
  }
}


describe('Auth Routes', () => {
  const testEmail = `user${Date.now()}@example.com`
  const testPassword = 'securepassword123'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  test.only('POST /auth/signup creates a new user', async () => {
    const request = new Request('http://localhost/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    })


    const res = await app.fetch(request, mockEnv())

    expect(res.status).toBe(200)

    const json = await res.json() as { message: string;}
    expect(json.message).toMatch(/success/i)
    expect(json).toHaveProperty('token')

    // Assert crypto functions were called
    expect(hashPassword).toHaveBeenCalledWith(testPassword)
    expect(signJWT).toHaveBeenCalled()

    // Check cookie header
    const setCookieHeader = res.headers.get('set-cookie')
    expect(setCookieHeader).toMatch(/token=mock\.jwt\.token/)
    expect(setCookieHeader).toMatch(/HttpOnly/)
  })
})
