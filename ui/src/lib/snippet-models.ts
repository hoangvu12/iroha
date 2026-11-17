/** The slice of an Upstream Key the Code Snippet's model list depends on. */
export interface SnippetKeyScope {
  readonly allowedModels: readonly string[] | null
  readonly deniedModels: readonly string[] | null
}

/** The slice of a Model Catalog view the Code Snippet's model list depends on. */
export interface SnippetCatalog {
  readonly entries: readonly { readonly modelId: string; readonly excluded: boolean }[]
}

/**
 * Mirrors the server-side `keyServesModel` rule
 * (`src/providers/provider-registry.ts`): an Upstream Key rejects a model
 * when it sets an `allowedModels` allow-list the model is not on, or a
 * `deniedModels` deny-list the model is on. A key with both lists null
 * accepts any model.
 */
export function keyServesModel(key: SnippetKeyScope, model: string): boolean {
  if (key.allowedModels !== null && !key.allowedModels.includes(model)) return false
  if (key.deniedModels !== null && key.deniedModels.includes(model)) return false
  return true
}

export function hasKeyRestriction(key: SnippetKeyScope): boolean {
  return key.allowedModels !== null || key.deniedModels !== null
}

/**
 * The models the Code Snippet offers: every catalogued model the Owner has
 * not excluded, whatever its source — the callable part of what the Models
 * card lists. With no key chosen the Gateway may route through any Upstream
 * Key, so nothing narrows the list; choosing a key narrows it to what that
 * key serves.
 */
export function snippetModelIds(
  catalog: SnippetCatalog,
  key: SnippetKeyScope | null,
): readonly string[] {
  const callable = catalog.entries.filter((entry) => !entry.excluded).map((entry) => entry.modelId)
  return key === null ? callable : callable.filter((id) => keyServesModel(key, id))
}
