import { Elysia, t } from 'elysia'
import type { ManagementKeyRegistry, ManagementKeyView, OwnerIdentity } from '../identity/index.ts'
import { createOwnerGuard, managementError } from './owner-guard.ts'

export function createManagementKeyRoutes(options: {
  identity: OwnerIdentity
  managementKeys: ManagementKeyRegistry
}) {
  // Deliberately omit ManagementKeyRegistry from this guard: only a human
  // Owner Session may create, revoke, or delete machine authority.
  const owner = createOwnerGuard(options.identity)
  return new Elysia({ name: 'iroha/management-keys', prefix: '/api/v1/admin/management-keys' })
    .guard({ as: 'local', detail: { security: [{ OwnerSession: [] }] } }, (app) => app
      .get('/', async ({ request, cookie, status }) => {
        const auth = await owner.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in auth) return status(auth.response.status, auth.response.body)
        return { keys: (await options.managementKeys.list()).map(toDto) }
      }, { detail: { tags: ['Management Keys'], summary: 'List Management Keys', operationId: 'listManagementKeys' }, response: { 200: t.Object({ keys: t.Array(keyDto) }), 401: errorDto, 403: errorDto } })
      .post('/', async ({ body, request, cookie, status }) => {
        const auth = await owner.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in auth) return status(auth.response.status, auth.response.body)
        const input = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
        const result = await options.managementKeys.create({ name: input.name, scopes: input.scopes, expiresAt: input.expiresAt })
        if (!result.ok) return status(400, { error: { code: 'validation_failed', message: 'The submitted values are not acceptable.', problems: result.problems.map((problem) => ({ ...problem })) } })
        return status(201, { ...toDto(result.value.key), secret: result.value.secret })
      }, { detail: { tags: ['Management Keys'], summary: 'Create a Management Key', operationId: 'createManagementKey' }, response: { 201: t.Composite([keyDto, t.Object({ secret: t.String() })]), 400: validationErrorDto, 401: errorDto, 403: errorDto } })
      .post('/:id/revoke', async ({ params, request, cookie, status }) => {
        const auth = await owner.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in auth) return status(auth.response.status, auth.response.body)
        const key = await options.managementKeys.revoke(params.id)
        return key === null ? status(404, managementError('management_key_not_found', 'No such Management Key.')) : toDto(key)
      }, { detail: { tags: ['Management Keys'], summary: 'Revoke a Management Key', operationId: 'revokeManagementKey' }, response: { 200: keyDto, 401: errorDto, 403: errorDto, 404: errorDto } })
      .delete('/:id', async ({ params, request, cookie, status }) => {
        const auth = await owner.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in auth) return status(auth.response.status, auth.response.body)
        const result = await options.managementKeys.delete(params.id)
        if (result === 'not_found') return status(404, managementError('management_key_not_found', 'No such Management Key.'))
        if (result === 'active') return status(409, managementError('management_key_active', 'Revoke this Management Key before deleting it.'))
        return status(204, undefined)
      }, { detail: { tags: ['Management Keys'], summary: 'Delete a revoked Management Key', operationId: 'deleteManagementKey' }, response: { 204: t.Void(), 401: errorDto, 403: errorDto, 404: errorDto, 409: errorDto } })
    )
}

const keyDto = t.Object({
  id: t.String(), name: t.String(), scopes: t.Array(t.Union([t.Literal('admin:read'), t.Literal('admin:write'), t.Literal('upstream-keys:reveal')])),
  createdAt: t.String(), lastUsedAt: t.Nullable(t.String()), expiresAt: t.Nullable(t.String()), revokedAt: t.Nullable(t.String()),
})
const errorDto = t.Object({ error: t.Object({ code: t.String(), message: t.String() }) })
const validationErrorDto = t.Object({ error: t.Object({ code: t.String(), message: t.String(), problems: t.Array(t.Object({ field: t.String(), message: t.String() })) }) })

function toDto(key: ManagementKeyView) {
  return { id: key.id, name: key.name, scopes: [...key.scopes], createdAt: key.createdAt.toISOString(), lastUsedAt: key.lastUsedAt?.toISOString() ?? null, expiresAt: key.expiresAt?.toISOString() ?? null, revokedAt: key.revokedAt?.toISOString() ?? null }
}
