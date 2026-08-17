import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
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

export function useProviders() {
  return useQuery({
    queryKey: queryKeys.providers(),
    queryFn: ({ signal }) => fetchProviders(signal),
  })
}

export function useProvider(providerId: string) {
  return useQuery({
    queryKey: queryKeys.provider(providerId),
    queryFn: ({ signal }) => fetchProvider(providerId, signal),
  })
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
  }
  /** The authoritative view the response carries, for the responses that carry one. */
  readonly viewOfResult?: (result: TResult) => ProviderView
}

/** The two cache entries a prediction overwrites, as they were before it. */
interface ProviderSnapshot {
  readonly providerId: string
  readonly list: readonly ProviderView[] | undefined
  readonly detail: ProviderView | undefined
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

      const snapshot: ProviderSnapshot = {
        providerId,
        list: queryClient.getQueryData<readonly ProviderView[]>(queryKeys.providers()),
        detail: queryClient.getQueryData<ProviderView>(queryKeys.provider(providerId)),
      }

      const current =
        snapshot.detail ?? snapshot.list?.find((provider) => provider.id === providerId)
      // Nothing cached to predict from; the response fills both keys in.
      if (current === undefined) return snapshot

      const predicted = optimistic.patch(current, variables)
      if (predicted === REMOVED) {
        queryClient.setQueryData(
          queryKeys.providers(),
          (list: readonly ProviderView[] | undefined) =>
            list?.filter((provider) => provider.id !== providerId),
        )
        // The detail entry is left alone deliberately: dropping it while the
        // detail screen is still mounted would send the screen straight back
        // for a Provider that is on its way out. It navigates away on success
        // and the entry ages out unobserved.
        return snapshot
      }

      writeProviderView(queryClient, predicted)
      return snapshot
    },

    onError(cause, variables, snapshot) {
      if (snapshot !== undefined) restoreProviders(queryClient, snapshot)
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
  }
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
      // (`provider-registry.ts:741`); predicting only `archived` would leave a
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
      // (`provider-registry.ts:993`).
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
      // Four fields, always these four (`provider-registry.ts:1013`), with the
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
