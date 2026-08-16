import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { fetchCatalog, type CatalogView } from '@/lib/catalog'
import { type KeyView, type ProviderView } from '@/lib/providers'

/**
 * The Vite dev server injects this constant via `define` in
 * `ui/vite.config.ts`. In production the constant is undefined, so the
 * snippet falls back to `window.location.origin` (the gateway that serves
 * the UI). In dev the Vite dev server serves the UI on a different
 * origin than the gateway, so the snippet URL must point at the gateway
 * directly — otherwise the Owner's curl would 404 against the Vite
 * origin, since inference routes are intentionally not proxied.
 */
declare const __IROHA_DEV_GATEWAY_URL__: string | undefined

type SnippetLanguage = 'curl' | 'openai-js' | 'openai-py' | 'curl-anthropic' | 'anthropic-js' | 'anthropic-py'
type RoutingMode = 'global' | 'provider'

const LANGUAGE_LABELS: Record<SnippetLanguage, string> = {
  curl: 'cURL',
  'openai-js': 'OpenAI JS SDK',
  'openai-py': 'OpenAI Python SDK',
  'curl-anthropic': 'cURL (Anthropic)',
  'anthropic-js': 'Anthropic JS SDK',
  'anthropic-py': 'Anthropic Python SDK',
}

const GATEWAY_KEY_PLACEHOLDER = '<gateway-key>'

interface CodeSnippetCardProps {
  readonly provider: ProviderView
}

/**
 * Mirrors the server-side `keyServesModel` rule
 * (`src/providers/provider-registry.ts`): an Upstream Key rejects a model
 * when it sets an `allowedModels` allow-list the model is not on, or a
 * `deniedModels` deny-list the model is on. A key with both lists null
 * accepts any model. The Owner-excluded catalog rows are already filtered
 * before this check runs.
 */
function keyServesModel(key: KeyView, model: string): boolean {
  if (key.allowedModels !== null && !key.allowedModels.includes(model)) return false
  if (key.deniedModels !== null && key.deniedModels.includes(model)) return false
  return true
}

function hasKeyRestriction(key: KeyView): boolean {
  return key.allowedModels !== null || key.deniedModels !== null
}

export function CodeSnippetCard({ provider }: CodeSnippetCardProps) {
  const [catalog, setCatalog] = useState<CatalogView | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [modelId, setModelId] = useState<string | null>(null)
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null)
  const [language, setLanguage] = useState<SnippetLanguage>('curl')
  const [routingMode, setRoutingMode] = useState<RoutingMode>('global')

  useEffect(() => {
    const controller = new AbortController()
    setCatalog(null)
    setLoadFailed(false)
    setModelId(null)
    fetchCatalog(provider.id, controller.signal)
      .then((view) => {
        if (controller.signal.aborted) return
        setCatalog(view)
        const first = view.entries.find((entry) => !entry.excluded)
        setModelId(first?.modelId ?? null)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setLoadFailed(true)
      })
    return () => controller.abort()
  }, [provider.id])

  // Keep the key selection in sync with the provider's keys: a removed key
  // falls back to the first remaining key, an added key does not steal the
  // Owner's current selection. A provider with no keys clears the
  // selection so the model list reverts to the unfiltered catalog.
  useEffect(() => {
    if (provider.keys.length === 0) {
      if (selectedKeyId !== null) setSelectedKeyId(null)
      return
    }
    const stillPresent = provider.keys.some((key) => key.id === selectedKeyId)
    if (!stillPresent) {
      setSelectedKeyId(provider.keys[0]?.id ?? null)
    }
  }, [provider.keys, selectedKeyId])

  const selectedKey =
    selectedKeyId === null
      ? null
      : (provider.keys.find((key) => key.id === selectedKeyId) ?? null)

  // The list the model picker offers: the catalog minus owner exclusions,
  // then restricted by the selected Upstream Key's allow- / deny-list.
  const filteredModels = useMemo<readonly string[]>(() => {
    if (catalog === null) return []
    const base = catalog.entries
      .filter((entry) => !entry.excluded)
      .map((entry) => entry.modelId)
    if (selectedKey === null) return base
    return base.filter((id) => keyServesModel(selectedKey, id))
  }, [catalog, selectedKey])

  // If the current modelId is no longer in the filtered list (the Owner
  // switched to a more restrictive key, or the catalog refreshed), snap
  // to the first filtered model. Empty filtered list → null, which the
  // dropdown renders as a disabled placeholder.
  useEffect(() => {
    if (catalog === null) return
    if (modelId !== null && !filteredModels.includes(modelId)) {
      setModelId(filteredModels[0] ?? null)
    }
  }, [catalog, filteredModels, modelId])

  const snippet = buildSnippet({
    language,
    origin: snippetOrigin(),
    providerId: provider.id,
    providerHandle: provider.handle,
    model: modelId ?? '',
    routingMode,
  })

  const modelPlaceholder = (() => {
    if (catalog === null) return loadFailed ? 'No models yet' : 'Loading models…'
    if (filteredModels.length > 0) return modelId ?? 'Pick a model'
    if (selectedKey !== null && hasKeyRestriction(selectedKey)) return 'No models for this key'
    return 'No models yet'
  })()

  return (
    <section className="bg-card rounded-xl border overflow-hidden">
      <div className="border-border flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div className="flex items-center gap-2">
          <Terminal className="text-muted-foreground size-4" aria-hidden />
          <h2 className="text-sm font-semibold tracking-tight">Code snippet</h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label
              htmlFor="code-snippet-routing"
              className="text-muted-foreground text-xs tracking-wide uppercase"
            >
              Routing
            </label>
            <Select
              value={routingMode}
              onValueChange={(value) => setRoutingMode(value as RoutingMode)}
            >
              <SelectTrigger id="code-snippet-routing" className="h-8 w-32" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="global">Global</SelectItem>
                <SelectItem value="provider">Provider</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {provider.keys.length > 0 && (
            <div className="flex items-center gap-2">
              <label
                htmlFor="code-snippet-key"
                className="text-muted-foreground text-xs tracking-wide uppercase"
              >
                Key
              </label>
              <Select
                value={selectedKeyId ?? '__none__'}
                onValueChange={(value) => setSelectedKeyId(value === '__none__' ? null : value)}
              >
                <SelectTrigger id="code-snippet-key" className="h-8 w-44" size="sm">
                  <SelectValue placeholder="Pick a key">
                    {selectedKey === null ? 'Pick a key' : selectedKey.id}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  {provider.keys.map((key) => (
                    <SelectItem key={key.id} value={key.id}>
                      <span className="flex flex-col gap-0.5">
                        <span className="font-mono text-xs">{key.id}</span>
                        <span
                          aria-hidden="true"
                          className="text-muted-foreground text-[10px] break-all"
                        >
                          Reaches {key.effectiveBaseUrl}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex items-center gap-2">
            <label
              htmlFor="code-snippet-model"
              className="text-muted-foreground text-xs tracking-wide uppercase"
            >
              Model
            </label>
            <Select
              value={modelId ?? '__none__'}
              onValueChange={(value) => setModelId(value === '__none__' ? null : value)}
              disabled={filteredModels.length === 0}
            >
              <SelectTrigger id="code-snippet-model" className="h-8 w-56" size="sm">
                <SelectValue placeholder={modelPlaceholder}>{modelPlaceholder}</SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                {filteredModels.length === 0 ? (
                  <SelectItem value="__none__" disabled>
                    {modelPlaceholder}
                  </SelectItem>
                ) : (
                  filteredModels.map((id) => (
                    <SelectItem key={id} value={id}>
                      {id}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-b px-5 py-2">
        <div
          role="tablist"
          aria-label="Snippet language"
          className="flex items-center gap-1"
        >
          {(Object.keys(LANGUAGE_LABELS) as SnippetLanguage[]).map((id) => {
            const isActive = language === id
            return (
              <Button
                key={id}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-pressed={isActive}
                variant={isActive ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setLanguage(id)}
              >
                {LANGUAGE_LABELS[id]}
              </Button>
            )
          })}
        </div>
        <CopyButton text={snippet} />
      </div>

      <pre className="bg-muted/50 overflow-x-auto p-4 font-mono text-xs leading-relaxed">
        {tokenize(snippet, language).map((token, index) => (
          <span key={index} className={TOKEN_CLASS[token.type]}>
            {token.text}
          </span>
        ))}
      </pre>
    </section>
  )
}

function CopyButton({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const onClick = async () => {
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'absolute'
        textarea.style.left = '-9999px'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={() => void onClick()}
      aria-live="polite"
    >
      {copied ? (
        <>
          <Check className="size-3" aria-hidden />
          Copied
        </>
      ) : (
        <>
          <Copy className="size-3" aria-hidden />
          Copy
        </>
      )}
    </Button>
  )
}

/**
 * The base URL the Code Snippet should target. In production the UI is
 * served by the gateway itself, so `window.location.origin` is the right
 * answer. In dev the UI is served by Vite on its own origin and the
 * gateway is elsewhere; the Vite config injects `__IROHA_DEV_GATEWAY_URL__`
 * with the gateway's URL so the Owner can paste a snippet URL that
 * actually reaches inference.
 */
function snippetOrigin(): string {
  if (typeof __IROHA_DEV_GATEWAY_URL__ === 'string' && __IROHA_DEV_GATEWAY_URL__ !== '') {
    return __IROHA_DEV_GATEWAY_URL__
  }
  return window.location.origin
}

interface BuildSnippetInput {
  readonly language: SnippetLanguage
  readonly origin: string
  readonly providerId: string
  readonly providerHandle: string
  readonly model: string
  readonly routingMode: RoutingMode
}

function buildSnippet({ language, origin, providerId, providerHandle, model, routingMode }: BuildSnippetInput): string {
  const baseUrl = routingMode === 'global' ? origin : `${origin}/providers/${providerHandle}`
  const routedModel = routingMode === 'global' ? `${providerId}/${model}` : model
  const chatCompletionsUrl = `${baseUrl}/v1/chat/completions`
  const messagesUrl = `${baseUrl}/v1/messages`
  switch (language) {
    case 'curl':
      return [
        `curl -X POST ${chatCompletionsUrl} \\`,
        `  -H "Authorization: Bearer ${GATEWAY_KEY_PLACEHOLDER}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{`,
        `    "model": "${escapeQuotes(routedModel)}",`,
        `    "messages": [{"role": "user", "content": "Hello"}]`,
        `  }'`,
      ].join('\n')
    case 'openai-js':
      return [
        `import OpenAI from 'openai'`,
        ``,
        `const client = new OpenAI({`,
        `  apiKey: '${GATEWAY_KEY_PLACEHOLDER}',`,
        `  baseURL: '${baseUrl}'`,
        `})`,
        ``,
        `const completion = await client.chat.completions.create({`,
        `  model: '${escapeQuotes(routedModel)}',`,
        `  messages: [{ role: 'user', content: 'Hello' }]`,
        `})`,
        ``,
        `console.log(completion.choices[0].message.content)`,
      ].join('\n')
    case 'openai-py':
      return [
        `from openai import OpenAI`,
        ``,
        `client = OpenAI(`,
        `    api_key='${GATEWAY_KEY_PLACEHOLDER}',`,
        `    base_url='${baseUrl}'`,
        `)`,
        ``,
        `completion = client.chat.completions.create(`,
        `    model='${escapeQuotes(routedModel)}',`,
        `    messages=[{'role': 'user', 'content': 'Hello'}]`,
        `)`,
        ``,
        `print(completion.choices[0].message.content)`,
      ].join('\n')
    case 'curl-anthropic':
      return [
        `curl -X POST ${messagesUrl} \\`,
        `  -H "x-api-key: ${GATEWAY_KEY_PLACEHOLDER}" \\`,
        `  -H "anthropic-version: 2023-06-01" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{`,
        `    "model": "${escapeQuotes(routedModel)}",`,
        `    "max_tokens": 1024,`,
        `    "messages": [{"role": "user", "content": "Hello"}]`,
        `  }'`,
      ].join('\n')
    case 'anthropic-js':
      return [
        `import Anthropic from '@anthropic-ai/sdk'`,
        ``,
        `const client = new Anthropic({`,
        `  apiKey: '${GATEWAY_KEY_PLACEHOLDER}',`,
        `  baseURL: '${baseUrl}'`,
        `})`,
        ``,
        `const message = await client.messages.create({`,
        `  model: '${escapeQuotes(routedModel)}',`,
        `  max_tokens: 1024,`,
        `  messages: [{ role: 'user', content: 'Hello' }]`,
        `})`,
        ``,
        `console.log(message.content)`,
      ].join('\n')
    case 'anthropic-py':
      return [
        `import anthropic`,
        ``,
        `client = anthropic.Anthropic(`,
        `    api_key='${GATEWAY_KEY_PLACEHOLDER}',`,
        `    base_url='${baseUrl}'`,
        `)`,
        ``,
        `message = client.messages.create(`,
        `    model='${escapeQuotes(routedModel)}',`,
        `    max_tokens=1024,`,
        `    messages=[{'role': 'user', 'content': 'Hello'}]`,
        `)`,
        ``,
        `print(message.content)`,
      ].join('\n')
  }
}

function escapeQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

type TokenType = 'placeholder' | 'string' | 'keyword' | 'fn' | 'flag' | 'plain'

interface Token {
  readonly type: TokenType
  readonly text: string
}

const TOKEN_CLASS: Record<TokenType, string> = {
  placeholder: 'font-semibold text-amber-600 dark:text-amber-400',
  string: 'text-emerald-600 dark:text-emerald-400',
  keyword: 'text-purple-600 dark:text-purple-400',
  fn: 'text-sky-600 dark:text-sky-400',
  flag: 'text-pink-600 dark:text-pink-400',
  plain: '',
}

const KEYWORDS: Record<SnippetLanguage, ReadonlySet<string>> = {
  curl: new Set(['curl']),
  'openai-js': new Set(['import', 'from', 'const', 'let', 'var', 'await', 'new']),
  'openai-py': new Set(['from', 'import', 'print']),
  'curl-anthropic': new Set(['curl']),
  'anthropic-js': new Set(['import', 'from', 'const', 'let', 'var', 'await', 'new']),
  'anthropic-py': new Set(['import', 'print']),
}

const BUILTINS: Record<SnippetLanguage, ReadonlySet<string>> = {
  curl: new Set(),
  'openai-js': new Set(['OpenAI', 'console']),
  'openai-py': new Set(['OpenAI']),
  'curl-anthropic': new Set(),
  'anthropic-js': new Set(['Anthropic', 'console']),
  'anthropic-py': new Set(['anthropic']),
}

const TOKEN_REGEX: Record<SnippetLanguage, RegExp> = {
  curl: /<\w+>|"[^"]*"|'[^']*'|curl|-{1,2}\w+|\s+|\S/g,
  'openai-js':
    /<\w+>|"[^"]*"|'[^']*'|`[^`]*`|\b(?:import|from|const|let|var|await|new)\b|\b(?:OpenAI|console)\b|\s+|\S/g,
  'openai-py': /<\w+>|"[^"]*"|'[^']*'|\b(?:from|import|print)\b|\bOpenAI\b|\s+|\S/g,
  'curl-anthropic': /<\w+>|"[^"]*"|'[^']*'|curl|-{1,2}\w+|\s+|\S/g,
  'anthropic-js':
    /<\w+>|"[^"]*"|'[^']*'|`[^`]*`|\b(?:import|from|const|let|var|await|new)\b|\b(?:Anthropic|console)\b|\s+|\S/g,
  'anthropic-py': /<\w+>|"[^"]*"|'[^']*'|\b(?:import|print)\b|\banthropic\b|\s+|\S/g,
}

function tokenize(text: string, language: SnippetLanguage): readonly Token[] {
  const tokens: Token[] = []
  for (const match of text.matchAll(TOKEN_REGEX[language])) {
    const raw = match[0]
    let type: TokenType
    if (raw.startsWith('<')) {
      type = 'placeholder'
    } else if (raw[0] === '"' || raw[0] === "'" || raw[0] === '`') {
      type = 'string'
    } else if (/^\s+$/.test(raw)) {
      type = 'plain'
    } else if (KEYWORDS[language].has(raw)) {
      type = 'keyword'
    } else if (language === 'curl' && raw.startsWith('-')) {
      type = 'flag'
    } else if (BUILTINS[language].has(raw)) {
      type = 'fn'
    } else {
      type = 'plain'
    }
    tokens.push({ type, text: raw })
  }
  return tokens
}
