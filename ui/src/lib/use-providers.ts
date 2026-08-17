import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { toApiError } from './api-client.ts'
import { queryKeys } from './query-keys.ts'
import {
  activateKey,
  addKey,
  archiveProvider,
  bulkAddKeys,
  createProvider,
  createUpstreamAccount,
  deleteUpstreamAccount,
  disableKey,
  duplicateProvider,
  fetchProvider,
  fetchProviders,
  purgeProvider,
  removeKey,
  revealKey,
  testKey,
  updateKeySettings,
  updateProvider,
  updateUpstreamAccount,
  type KeySettingsPatch,
  type KeyView,
  type NewKeyInput,
  type NewProviderInput,
  type ProviderPatch,
  type ProviderView,
  type UpstreamAccountView,
} from './providers.ts'
import { refreshCatalog } from './catalog.ts'
import { fetchRequests, type RequestFilter } from './requests.ts'
import { fetchUsage, refreshUsage } from './usage.ts'

/**
 * Everything the Providers screens read and write, over one cache. Both screens
 * used to hold a private copy of the Provider list, so a change made in one was
 * invisible in the other until a full refetch; they now share `['providers']`
 * and `['providers', id]`, and every mutation writes the `ProviderView` its
 * response already carries instead of throwing it away.
 */

/** Twelve or twenty-four hours of traffic is plenty for a sparkline. */
const REQUEST_HISTORY_LIMIT = 800

/**
 * The Provider list read, as one object the hook and the route loader share.
 * A loader that spelled the key or the fetch out for itself could drift from
 * this hook by a character and warm an entry no screen ever reads — the app
 * would still work, and the preload would silently do nothing.
 */
export function providersQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.providers(),
    queryFn: ({ signal }) => fetchProviders(signal),
  })
}

export function useProviders() {
  return useQuery(providersQueryOptions())
}

/** One Provider, by the id its route carries. Shared with that route's loader. */
export function providerQueryOptions(providerId: string) {
  return queryOptions({
    queryKey: queryKeys.provider(providerId),
    queryFn: ({ signal }) => fetchProvider(providerId, signal),
  })
}

export function useProvider(providerId: string) {
  return useQuery(providerQueryOptions(providerId))
}

/**
 * Warms one Provider's detail entry from an intent to open it.
 *
 * The Providers list opens a row by navigating imperatively rather than through
 * a `Link`, so `defaultPreload: 'intent'` has nothing to hang hover intent on
 * and the route's loader only runs once the Owner has already clicked. A row
 * cannot become an anchor without putting its action menu's button inside one,
 * which is invalid, so the row asks for the same read the loader would.
 *
 * `ensureQueryData` is a no-op on a fresh entry, which is what makes this safe
 * to fire from every pointer that crosses a row: hovering the list warms at most
 * one request per Provider per `staleTime`.
 */
export function useWarmProvider(): (providerId: string) => void {
  const queryClient = useQueryClient()

  return (providerId) => {
    // A failure here is a head start that did not arrive. The component's own
    // query re-reads the entry and renders the error branch it already has.
    void queryClient.ensureQueryData(providerQueryOptions(providerId)).catch(() => {})
  }
}

/**
 * The Request history behind the sparklines. It lives under its own key, which
 * is what stops toggling a Provider from re-pulling eight hundred Request
 * events along with the Provider list.
 */
export function useRequestHistory(filter: RequestFilter = {}) {
  return useQuery({
    queryKey: queryKeys.requests({ ...filter, limit: REQUEST_HISTORY_LIMIT }),
    queryFn: ({ signal }) =>
      fetchRequests(filter, { limit: REQUEST_HISTORY_LIMIT, signal }),
  })
}

export function useProviderUsage(providerId: string) {
  return useQuery({
    queryKey: queryKeys.usage(providerId),
    queryFn: ({ signal }) => fetchUsage(providerId, signal),
  })
}

/** A prediction that the Provider itself disappears. Only `purge` makes it. */
const REMOVED = 'removed'

interface ProviderMutation<TVariables, TResult> {
  readonly perform: (variables: TVariables) => Promise<TResult>
  /**
   * The failure toast's title. Every mutation raises one, and it names the
   * Provider or Upstream Key the Owner acted on: the row has already sprung
   * back to its old state by the time the Owner reads it.
   */
  readonly failureTitle: (variables: TVariables) => string
  /**
   * What the request will do to the cached Provider, for the mutations the
   * Gateway answers without talking to an upstream. Every mutation that awaits
   * a probe or server-only data leaves this out and shows a pending indicator
   * instead; predicting a probe's verdict would put a fact we invented in front
   * of the Owner. See ADR-0022.
   */
  readonly optimistic?: {
    readonly providerId: (variables: TVariables) => string
    readonly patch: (
      current: ProviderView,
      variables: TVariables,
    ) => ProviderView | typeof REMOVED
    /**
     * How to undo the patch, for a mutation whose reach is narrower than the
     * cache entry it writes.
     *
     * A Provider's Upstream Keys are separate rows sharing one `ProviderView`,
     * and a row only disables its *own* actions, so the Owner can disable two
     * Keys in quick succession. If the first then fails, putting the whole
     * snapshot back would silently revoke the second Key's patch too. Given the
     * view as the cache now holds it and the view the patch was computed from,
     * this puts back only what this mutation touched. Mutations that own the
     * whole Provider leave it out and the snapshot is restored wholesale.
     */
    readonly rollback?: (
      current: ProviderView,
      before: ProviderView,
      variables: TVariables,
    ) => ProviderView
  }
  /** The authoritative view the response carries, for the responses that carry one. */
  readonly viewOfResult?: (result: TResult) => ProviderView
}

/** The two cache entries a prediction overwrites, as they were before it. */
interface ProviderSnapshot {
  readonly providerId: string
  readonly list: readonly ProviderView[] | undefined
  readonly detail: ProviderView | undefined
  /** The Provider the patch was computed from, whichever entry supplied it. */
  readonly before: ProviderView | undefined
}

/**
 * The recipe every Provider mutation follows: cancel the reads it is about to
 * overwrite, snapshot them, predict, restore the snapshot and toast when the
 * request fails, write the view the response carries, and reconcile on settle.
 * Written once so ten mutations differ only by their patch.
 */
function useProviderMutation<TVariables, TResult>(
  mutation: ProviderMutation<TVariables, TResult>,
) {
  const queryClient = useQueryClient()

  return useMutation<TResult, Error, TVariables, ProviderSnapshot | undefined>({
    mutationFn: mutation.perform,

    async onMutate(variables) {
      const { optimistic } = mutation
      if (optimistic === undefined) return undefined

      const providerId = optimistic.providerId(variables)
      // `['providers']` prefixes `['providers', id]`, so one cancellation
      // reaches the list and every detail read in flight.
      await queryClient.cancelQueries({ queryKey: queryKeys.providers() })

      const list = queryClient.getQueryData<readonly ProviderView[]>(queryKeys.providers())
      const detail = queryClient.getQueryData<ProviderView>(queryKeys.provider(providerId))
      const current = detail ?? list?.find((provider) => provider.id === providerId)
      const snapshot: ProviderSnapshot = { providerId, list, detail, before: current }

      // Nothing cached to predict from; the response fills both keys in.
      if (current === undefined) return snapshot

      const predicted = optimistic.patch(current, variables)
      if (predicted === REMOVED) {
        queryClient.setQueryData(
          queryKeys.providers(),
          (list: readonly ProviderView[] | undefined) =>
            list?.filter((provider) => provider.id !== providerId),
        )
        // The detail entry is dropped rather than patched. Leaving it would let
        // `onSettled`'s prefix invalidation refetch a Provider that is on its way
        // out and answer `404` on the screen still showing it; removing it takes
        // the entry out of the invalidation's reach. `onDeleted` navigates away,
        // and a rollback puts the entry back if the purge is refused.
        queryClient.removeQueries({ queryKey: queryKeys.provider(providerId), exact: true })
        return snapshot
      }

      writeProviderView(queryClient, predicted)
      return snapshot
    },

    onError(cause, variables, snapshot) {
      if (snapshot !== undefined) {
        const narrow = mutation.optimistic?.rollback
        const before = snapshot.before
        if (narrow !== undefined && before !== undefined) {
          // Undo only this mutation's own reach, reading whatever the cache holds
          // now — a sibling row's prediction may have landed in between.
          const held = queryClient.getQueryData<ProviderView>(queryKeys.provider(before.id))
          const current =
            held ??
            queryClient
              .getQueryData<readonly ProviderView[]>(queryKeys.providers())
              ?.find((provider) => provider.id === before.id)
          writeProviderView(queryClient, narrow(current ?? before, before, variables))
        } else {
          restoreProviders(queryClient, snapshot)
        }
      }
      toast.error(mutation.failureTitle(variables), {
        description: toApiError(cause).message,
      })
    },

    onSuccess(result) {
      const view = mutation.viewOfResult?.(result)
      if (view !== undefined) writeProviderView(queryClient, view)
    },

    onSettled() {
      // Deliberately not awaited: the response has already been written into
      // the cache, so this is background reconciliation. Awaiting it would hold
      // the row's actions closed for a refetch the Owner is not waiting on.
      // Again by prefix: the list and the detail of whichever Provider moved.
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers() })
      // Every one of these writes records an audit entry.
      void queryClient.invalidateQueries({ queryKey: queryKeys.auditAll() })
    },
  })
}

/** Puts one Provider into both the detail entry and its place in the list. */
function writeProviderView(queryClient: QueryClient, view: ProviderView): void {
  queryClient.setQueryData(queryKeys.provider(view.id), view)
  queryClient.setQueryData(
    queryKeys.providers(),
    (list: readonly ProviderView[] | undefined) => {
      if (list === undefined) return list
      return list.some((provider) => provider.id === view.id)
        ? list.map((provider) => (provider.id === view.id ? view : provider))
        : [...list, view]
    },
  )
}

function restoreProviders(queryClient: QueryClient, snapshot: ProviderSnapshot): void {
  if (snapshot.list !== undefined) {
    queryClient.setQueryData(queryKeys.providers(), snapshot.list)
  }
  if (snapshot.detail !== undefined) {
    queryClient.setQueryData(queryKeys.provider(snapshot.providerId), snapshot.detail)
    return
  }
  // There was no detail entry to put back, but `writeProviderView` created one
  // holding the prediction. Restoring nothing would leave the refused state
  // cached: `onSettled` marks an inactive entry stale without refetching it, and
  // both `ensureQueryData` callers serve stale data as a hit — so opening the
  // Provider would paint what the Gateway had just refused.
  queryClient.removeQueries({ queryKey: queryKeys.provider(snapshot.providerId), exact: true })
}

/**
 * Puts one Upstream Key back as it was, leaving every other Key on the Provider
 * as the cache now holds it. Re-inserted at its old index so a rollback does not
 * reorder the Owner's list.
 */
function restoreKey(current: ProviderView, before: ProviderView, keyId: string): ProviderView {
  const original = before.keys.find((key) => key.id === keyId)
  const others = current.keys.filter((key) => key.id !== keyId)
  if (original === undefined) return { ...current, keys: others }

  const keys = [...others]
  keys.splice(Math.min(before.keys.findIndex((key) => key.id === keyId), keys.length), 0, original)
  return { ...current, keys }
}

/** Replaces one Upstream Key on a cached Provider and leaves the others alone. */
function patchKey(
  provider: ProviderView,
  keyId: string,
  patch: (key: KeyView) => KeyView,
): ProviderView {
  return {
    ...provider,
    keys: provider.keys.map((key) => (key.id === keyId ? patch(key) : key)),
  }
}

/** A Provider named for a failure toast. */
interface ProviderTarget {
  readonly id: string
  readonly displayName: string
}

/** An Upstream Key named for a failure toast; its id is what the Owner sees. */
interface KeyTarget {
  readonly providerId: string
  readonly keyId: string
}

export function useUpdateProvider(csrfToken: string) {
  return useProviderMutation({
    perform: (variables: ProviderTarget & { readonly patch: ProviderPatch }) =>
      updateProvider(variables.id, variables.patch, csrfToken),
    failureTitle: (variables) => `Could not save ${variables.displayName}`,
    optimistic: {
      providerId: (variables) => variables.id,
      // Every field the PATCH carries is stored verbatim.
      patch: (current, variables) => ({ ...current, ...variables.patch }),
    },
    viewOfResult: (view) => view,
  })
}

export function useArchiveProvider(csrfToken: string) {
  return useProviderMutation({
    perform: (variables: ProviderTarget) => archiveProvider(variables.id, csrfToken),
    failureTitle: (variables) => `Could not archive ${variables.displayName}`,
    optimistic: {
      providerId: (variables) => variables.id,
      // Archiving both stamps the Provider and takes it out of use
      // (`provider-registry.ts:753`); predicting only `archived` would leave a
      // stale Enabled toggle on screen.
      patch: (current) => ({ ...current, archived: true, enabled: false }),
    },
    viewOfResult: (view) => view,
  })
}

export function usePurgeProvider(csrfToken: string) {
  return useProviderMutation({
    perform: (variables: ProviderTarget) => purgeProvider(variables.id, csrfToken),
    failureTitle: (variables) => `Could not purge ${variables.displayName}`,
    optimistic: {
      providerId: (variables) => variables.id,
      // Purge answers with nothing, so unlike its nine siblings there is no
      // view to write back: the removal stands on the prediction until the
      // settle invalidation confirms it.
      patch: () => REMOVED,
    },
  })
}

/**
 * Pending only: creating a Provider tests each of its Upstream Keys against the
 * upstream before answering, and the Key Health that comes back is evidence, not
 * something the client may invent.
 */
export function useCreateProvider(csrfToken: string) {
  return useProviderMutation({
    perform: (variables: { readonly input: NewProviderInput }) =>
      createProvider(variables.input, csrfToken),
    failureTitle: (variables) => `Could not create ${variables.input.displayName}`,
    viewOfResult: (view) => view,
  })
}

/** Pending only: a duplicate probes the copied Upstream Keys before answering. */
export function useDuplicateProvider(csrfToken: string) {
  return useProviderMutation({
    perform: (variables: ProviderTarget & { readonly handle: string }) =>
      duplicateProvider(variables.id, variables.handle, csrfToken),
    failureTitle: (variables) => `Could not duplicate ${variables.displayName}`,
    viewOfResult: (view) => view,
  })
}

export function useActivateKey(csrfToken: string) {
  return useProviderMutation({
    perform: (variables: KeyTarget) =>
      activateKey(variables.providerId, variables.keyId, csrfToken),
    failureTitle: (variables) => `Could not activate key ${variables.keyId}`,
    optimistic: {
      providerId: (variables) => variables.providerId,
      // The Owner's say-so, recorded verbatim and scoped to the one Key
      // (`provider-registry.ts:994`).
      patch: (current, variables) =>
        patchKey(current, variables.keyId, (key) => ({
          ...key,
          health: 'active',
          healthReason: 'activated by Owner',
          retryAfterAt: null,
          healthScope: 'key',
          healthScopeId: null,
          healthModel: null,
        })),
      rollback: (current, before, variables) =>
        restoreKey(current, before, variables.keyId),
    },
    viewOfResult: (view) => view,
  })
}

export function useDisableKey(csrfToken: string) {
  return useProviderMutation({
    perform: (variables: KeyTarget) =>
      disableKey(variables.providerId, variables.keyId, csrfToken),
    failureTitle: (variables) => `Could not disable key ${variables.keyId}`,
    optimistic: {
      providerId: (variables) => variables.providerId,
      // Six fields, always these six (`provider-registry.ts:1026`), with the
      // scope pointing at the Key the Owner disabled.
      patch: (current, variables) =>
        patchKey(current, variables.keyId, (key) => ({
          ...key,
          health: 'disabled',
          healthReason: 'disabled by Owner',
          retryAfterAt: null,
          healthScope: 'key',
          healthScopeId: variables.keyId,
          healthModel: null,
        })),
      rollback: (current, before, variables) =>
        restoreKey(current, before, variables.keyId),
    },
    viewOfResult: (view) => view,
  })
}

export function useRemoveKey(csrfToken: string) {
  return useProviderMutation({
    perform: (variables: KeyTarget) =>
      removeKey(variables.providerId, variables.keyId, csrfToken),
    failureTitle: (variables) => `Could not remove key ${variables.keyId}`,
    optimistic: {
      providerId: (variables) => variables.providerId,
      // The Key goes; the Provider's other Keys are untouched.
      patch: (current, variables) => ({
        ...current,
        keys: current.keys.filter((key) => key.id !== variables.keyId),
      }),
      rollback: (current, before, variables) =>
        restoreKey(current, before, variables.keyId),
    },
    viewOfResult: (view) => view,
  })
}

export function useUpdateKeySettings(csrfToken: string) {
  return useProviderMutation({
    perform: (variables: KeyTarget & { readonly settings: KeySettingsPatch }) =>
      updateKeySettings(variables.providerId, variables.keyId, variables.settings, csrfToken),
    failureTitle: (variables) => `Could not save key ${variables.keyId}`,
    optimistic: {
      providerId: (variables) => variables.providerId,
      patch: (current, variables) =>
        patchKey(current, variables.keyId, (key) => {
          const next = { ...key, ...changedKeySettings(variables.settings) }
          // `effectiveBaseUrl` is derived rather than stored: the Key's own
          // override when it has one, the Provider's base URL otherwise.
          return { ...next, effectiveBaseUrl: next.baseUrl ?? current.baseUrl }
        }),
      rollback: (current, before, variables) =>
        restoreKey(current, before, variables.keyId),
    },
    viewOfResult: (view) => view,
  })
}

/**
 * The settings one save actually sends. A null `accountId`, `allowedModels` or
 * `deniedModels` is omitted from the request, which the server reads as "leave
 * this field alone", so the prediction leaves it alone too.
 */
function changedKeySettings(settings: KeySettingsPatch): Partial<KeyView> {
  return {
    ...(settings.accountId !== null ? { accountId: settings.accountId } : {}),
    ...(settings.allowedModels !== null ? { allowedModels: settings.allowedModels } : {}),
    ...(settings.deniedModels !== null ? { deniedModels: settings.deniedModels } : {}),
    ...(settings.baseUrl !== undefined ? { baseUrl: settings.baseUrl } : {}),
  }
}

/**
 * Pending only: the server stores the Key and then probes it, and its Key Health
 * is the probe's verdict. ADR-0022 rejected a placeholder row here — it would
 * need a client-minted id no route accepts.
 */
export function useAddKey(csrfToken: string) {
  return useProviderMutation({
    perform: (variables: ProviderTarget & { readonly input: NewKeyInput }) =>
      addKey(variables.id, variables.input, csrfToken),
    failureTitle: (variables) => `Could not add a key to ${variables.displayName}`,
    viewOfResult: (view) => view,
  })
}

/**
 * Pending only, for the same reason as `useAddKey`, and its response is a
 * per-entry report rather than a Provider: the cache catches up on settle.
 */
export function useBulkAddKeys(csrfToken: string) {
  return useProviderMutation({
    perform: (
      variables: ProviderTarget & {
        readonly entries: readonly { readonly upstreamKey: string; readonly baseUrl?: string }[]
      },
    ) => bulkAddKeys(variables.id, variables.entries, csrfToken),
    failureTitle: (variables) => `Could not add keys to ${variables.displayName}`,
  })
}

/** Pending only: a test is a live probe, and its verdict is what the Owner asked for. */
export function useTestKey(csrfToken: string) {
  return useProviderMutation({
    perform: (variables: KeyTarget) => testKey(variables.providerId, variables.keyId, csrfToken),
    failureTitle: (variables) => `Could not test key ${variables.keyId}`,
    viewOfResult: (view) => view,
  })
}

export function useCreateUpstreamAccount(csrfToken: string) {
  return useProviderMutation({
    perform: (variables: { readonly providerId: string; readonly displayName: string }) =>
      createUpstreamAccount(variables.providerId, variables.displayName, csrfToken),
    failureTitle: (variables) => `Could not add ${variables.displayName}`,
    optimistic: {
      providerId: (variables) => variables.providerId,
      // The name the Owner typed is the whole row; the id and timestamps are
      // the server's to mint and arrive with the response. A placeholder is
      // honest here, where ADR-0022 rules one out for an Upstream Key, because
      // nothing addresses the account by id before the response lands.
      patch: (current, variables) => ({
        ...current,
        accounts: [...current.accounts, placeholderAccount(variables.displayName)],
      }),
    },
    viewOfResult: (view) => view,
  })
}

export function useUpdateUpstreamAccount(csrfToken: string) {
  return useProviderMutation({
    perform: (variables: {
      readonly providerId: string
      readonly accountId: string
      readonly displayName: string
    }) =>
      updateUpstreamAccount(
        variables.providerId,
        variables.accountId,
        variables.displayName,
        csrfToken,
      ),
    failureTitle: (variables) => `Could not rename ${variables.displayName}`,
    optimistic: {
      providerId: (variables) => variables.providerId,
      // A rename only: the identity stays put so assigned Keys keep grouping.
      patch: (current, variables) => ({
        ...current,
        accounts: current.accounts.map((account) =>
          account.id === variables.accountId
            ? { ...account, displayName: variables.displayName }
            : account,
        ),
      }),
    },
    viewOfResult: (view) => view,
  })
}

export function useDeleteUpstreamAccount(csrfToken: string) {
  return useProviderMutation({
    perform: (variables: { readonly providerId: string; readonly accountId: string }) =>
      deleteUpstreamAccount(variables.providerId, variables.accountId, csrfToken),
    failureTitle: (variables) => `Could not remove account ${variables.accountId}`,
    optimistic: {
      providerId: (variables) => variables.providerId,
      // The grouping goes and its Keys become independent again rather than
      // being deleted: the column is `on delete set null`.
      patch: (current, variables) => ({
        ...current,
        accounts: current.accounts.filter((account) => account.id !== variables.accountId),
        keys: current.keys.map((key) =>
          key.accountId === variables.accountId ? { ...key, accountId: null } : key,
        ),
      }),
    },
    viewOfResult: (view) => view,
  })
}

/**
 * Pending only: the value is the server's to decrypt, and the reveal is recorded
 * in the audit log, which is the only cache it dirties.
 */
export function useRevealKey() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (variables: KeyTarget) => revealKey(variables.providerId, variables.keyId),
    onError(cause, variables) {
      toast.error(`Could not reveal key ${variables.keyId}`, {
        description: toApiError(cause).message,
      })
    },
    onSettled() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.auditAll() })
    },
  })
}

/**
 * Pending only: a refresh asks the Provider what is left, so the reading it
 * returns is the answer. It replaces `['usage', providerId]` on arrival.
 */
export function useRefreshUsage(csrfToken: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (variables: ProviderTarget) => refreshUsage(variables.id, csrfToken),
    onSuccess(usage, variables) {
      queryClient.setQueryData(queryKeys.usage(variables.id), usage)
    },
    onError(cause, variables) {
      toast.error(`Could not refresh usage for ${variables.displayName}`, {
        description: toApiError(cause).message,
      })
    },
    onSettled() {
      // A usage refresh is not only a read: it records `usage.refreshed` and
      // reconciles Key Health from the Provider's own entitlement surface
      // (`src/usage/usage-service.ts`). Writing `['usage', id]` alone would leave
      // the reconciled Key Health unseen until `staleTime` expired.
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.auditAll() })
    },
  })
}

/**
 * Refreshing a Provider's model catalogue.
 *
 * Pending only — it reads the upstream's model list — but it is also an audited
 * write (`model_catalog.refreshed`), so it reconciles like every other mutation
 * here. The button it sits behind reports its own success and failure inline, so
 * this raises no toast of its own.
 */
export function useRefreshCatalog(csrfToken: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (variables: ProviderTarget) => refreshCatalog(variables.id, csrfToken),
    onSettled() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.auditAll() })
    },
  })
}

let placeholderAccountCounter = 0

/** A row the Owner can see immediately, carrying a local id until the response lands. */
function placeholderAccount(displayName: string): UpstreamAccountView {
  placeholderAccountCounter += 1
  const at = new Date().toISOString()
  return {
    id: `pending-account-${placeholderAccountCounter}`,
    displayName,
    createdAt: at,
    updatedAt: at,
  }
}
