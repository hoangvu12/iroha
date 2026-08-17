import { AUTH_BASE, request } from './api-client.ts'

export interface AuthState {
  readonly setupRequired: boolean
  readonly authenticated: boolean
  readonly recoveryEnabled: boolean
  readonly owner: { readonly username: string } | null
  readonly session: { readonly id: string; readonly csrfToken: string } | null
}

export interface SessionSummary {
  readonly id: string
  readonly current: boolean
  readonly createdAt: string
  readonly lastSeenAt: string
  readonly expiresAt: string
  readonly userAgent: string | null
}

// The auth surface is the one part of the API outside the Owner-only routes, so
// every call here names its base.

export async function fetchAuthState(signal?: AbortSignal): Promise<AuthState> {
  return await request<AuthState>('GET', '/state', { base: AUTH_BASE, signal })
}

export async function setupOwner(input: {
  username: string
  password: string
  setupToken: string
}): Promise<AuthState> {
  // Setup and sign-in answer with the same state the screen would otherwise
  // have to fetch, so signing in costs one round trip.
  return await request<AuthState>('POST', '/setup', { base: AUTH_BASE, body: input })
}

export async function signIn(input: { username: string; password: string }): Promise<AuthState> {
  return await request<AuthState>('POST', '/login', { base: AUTH_BASE, body: input })
}

export async function signOut(csrfToken: string): Promise<void> {
  await request('POST', '/logout', { base: AUTH_BASE, csrfToken })
}

export async function fetchSessions(): Promise<readonly SessionSummary[]> {
  const body = await request<{ sessions: readonly SessionSummary[] }>('GET', '/sessions', {
    base: AUTH_BASE,
  })
  return body.sessions
}

export async function revokeSession(id: string, csrfToken: string): Promise<void> {
  await request('DELETE', `/sessions/${encodeURIComponent(id)}`, { base: AUTH_BASE, csrfToken })
}

export async function revokeAllSessions(csrfToken: string): Promise<number> {
  const body = await request<{ revoked: number }>('DELETE', '/sessions', {
    base: AUTH_BASE,
    csrfToken,
  })
  return body.revoked
}

export async function recoverAccess(input: {
  recoveryToken: string
  password: string
}): Promise<number> {
  const body = await request<{ sessionsRevoked: number }>('POST', '/recover', {
    base: AUTH_BASE,
    body: input,
  })
  return body.sessionsRevoked
}
