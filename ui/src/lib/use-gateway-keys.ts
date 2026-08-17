import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { toApiError } from './api-client.ts'
import {
  createGatewayKey,
  deleteGatewayKey,
  fetchGatewayKeys,
  revokeGatewayKey,
  updateGatewayKey,
  type CreatedGatewayKey,
  type GatewayKeyAccess,
  type GatewayKeyView,
} from './gateway-keys.ts'
import { queryKeys } from './query-keys.ts'

/**
 * The Gateway Keys list as shared server state, plus the four mutations that
 * change it.
 *
 * Editing, revoking and deleting are pure database writes the Gateway answers
 * without reaching a Provider, so their result is fully determined by the
 * request and the cache is patched before it leaves (ADR-0022). Creation is
 * not: its response carries the one-time secret, which nothing can predict, so
 * it waits behind a pending indicator and writes only what the Gateway returned.
 */

type GatewayKeyList = readonly GatewayKeyView[]

/** Everything `PATCH /gateway-keys/:id` replaces, including the revision it expects. */
export interface GatewayKeyEdit {
  readonly revision: number
  readonly name: string
  readonly access: GatewayKeyAccess
  readonly corsOrigins: readonly string[]
}

/** The Gateway Keys list read, as one object the hook and its route loader share. */
export function gatewayKeysQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.gatewayKeys(),
    queryFn: ({ signal }) => fetchGatewayKeys(signal),
  })
}

export function useGatewayKeys() {
  return useQuery(gatewayKeysQueryOptions())
}

interface GatewayKeyMutation<TVariables, TResult> {
  readonly perform: (variables: TVariables) => Promise<TResult>
  /** The list as it will read once the Gateway has stored the change. */
  readonly patch: (keys: GatewayKeyList, variables: TVariables) => GatewayKeyList
  /** The failure toast’s title, naming the Gateway Key the Owner acted on. */
  readonly failureTitle: (variables: TVariables) => string
  /** The authoritative view the response carries, for the responses that carry one. */
  readonly viewOfResult?: (result: TResult) => GatewayKeyView
}

/** The list as it was before the patch, kept so a refusal can put it back. */
interface Rollback {
  readonly previous: GatewayKeyList | undefined
}

/**
 * The recipe every predictable Gateway Key mutation follows: cancel, snapshot,
 * patch, then either keep the Gateway's own view of the row or put the snapshot
 * back and say which Gateway Key it was.
 */
function useGatewayKeyMutation<TVariables, TResult>(
  mutation: GatewayKeyMutation<TVariables, TResult>,
) {
  const client = useQueryClient()

  return useMutation<TResult, Error, TVariables, Rollback>({
    mutationFn: mutation.perform,
    async onMutate(variables) {
      // A read already in flight would land after the patch and redraw the row
      // as it was before the Owner acted.
      await client.cancelQueries({ queryKey: queryKeys.gatewayKeys() })
      const previous = client.getQueryData<GatewayKeyList>(queryKeys.gatewayKeys())
      if (previous !== undefined) {
        client.setQueryData<GatewayKeyList>(
          queryKeys.gatewayKeys(),
          mutation.patch(previous, variables),
        )
      }
      return { previous }
    },
    onError(cause, variables, context) {
      if (context?.previous !== undefined) {
        client.setQueryData<GatewayKeyList>(queryKeys.gatewayKeys(), context.previous)
      }
      toast.error(mutation.failureTitle(variables), { description: describe(cause) })
    },
    onSuccess(result) {
      const stored = mutation.viewOfResult?.(result)
      if (stored === undefined) return
      client.setQueryData<GatewayKeyList>(queryKeys.gatewayKeys(), (keys) =>
        keys?.map((key) => (key.id === stored.id ? stored : key)),
      )
    },
    onSettled: () => reconcile(client),
  })
}

export function useUpdateGatewayKey(csrfToken: string) {
  return useGatewayKeyMutation<
    { readonly id: string; readonly edit: GatewayKeyEdit },
    GatewayKeyView
  >({
    perform: ({ id, edit }) => updateGatewayKey(id, { ...edit }, csrfToken),
    patch: (keys, { id, edit }) =>
      keys.map((key) =>
        key.id === id
          ? {
              ...key,
              name: edit.name,
              access: edit.access,
              // The Gateway stores an empty scope whenever access is unrestricted.
              scope: edit.access.mode === 'selected' ? edit.access.providers : [],
              corsOrigins: edit.corsOrigins,
              // Mirrors the Gateway's own `expectedRevision + 1`
              // (`src/keys/gateway-key-registry.ts`). Leave the row on the
              // submitted revision and the Owner's next edit fails the
              // optimistic-concurrency check against a revision already spent.
              revision: edit.revision + 1,
            }
          : key,
      ),
    failureTitle: ({ edit }) => `Could not save Gateway Key ${edit.name}`,
    viewOfResult: (view) => view,
  })
}

export function useRevokeGatewayKey(csrfToken: string) {
  return useGatewayKeyMutation<
    { readonly id: string; readonly name: string },
    GatewayKeyView
  >({
    perform: ({ id }) => revokeGatewayKey(id, csrfToken),
    patch: (keys, { id }) => keys.map((key) => (key.id === id ? { ...key, revoked: true } : key)),
    failureTitle: ({ name }) => `Could not revoke Gateway Key ${name}`,
    viewOfResult: (view) => view,
  })
}

export function useDeleteGatewayKey(csrfToken: string) {
  // Deletion answers with no body, so there is nothing to write back; the row
  // stays gone on the strength of the patch until the settle invalidation.
  return useGatewayKeyMutation<{ readonly id: string; readonly name: string }, void>({
    perform: ({ id }) => deleteGatewayKey(id, csrfToken),
    patch: (keys, { id }) => keys.filter((key) => key.id !== id),
    failureTitle: ({ name }) => `Could not delete Gateway Key ${name}`,
  })
}

/**
 * Creation waits: only the Gateway can mint the credential, and the row it
 * returns is the first sighting of the key's id, revision and creation time.
 */
export function useCreateGatewayKey(csrfToken: string) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      readonly name: string
      readonly access: GatewayKeyAccess
      readonly corsOrigins: readonly string[]
    }) => createGatewayKey({ ...input }, csrfToken),
    onSuccess(created) {
      client.setQueryData<GatewayKeyList>(queryKeys.gatewayKeys(), (keys) =>
        keys === undefined ? undefined : [...keys, withoutSecret(created)],
      )
    },
    onSettled: () => reconcile(client),
  })
}

/**
 * The created key as the Gateway will list it. The plaintext credential is
 * dropped on the way into the cache: the cache outlives the dialog that shows
 * it, and a secret shown once must not be re-servable from a later render.
 */
function withoutSecret(created: CreatedGatewayKey): GatewayKeyView {
  return {
    id: created.id,
    name: created.name,
    scope: created.scope,
    access: created.access,
    revision: created.revision,
    corsOrigins: created.corsOrigins,
    createdAt: created.createdAt,
    lastUsedAt: created.lastUsedAt,
    revoked: created.revoked,
  }
}

/** Cheap background reconciliation; the cache write is what removed the wait. */
function reconcile(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: queryKeys.gatewayKeys() })
  // Every Gateway Key mutation records an audit event.
  void client.invalidateQueries({ queryKey: queryKeys.auditAll() })
}

/** A Gateway Key conflict has a cause the Owner can act on; the API's wording does not. */
function describe(cause: unknown): string {
  const failure = toApiError(cause)
  return failure.code === 'gateway_key_conflict'
    ? 'It changed elsewhere while you were editing. Reopen it to see the current settings.'
    : failure.message
}
