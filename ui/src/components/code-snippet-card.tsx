import { useEffect, useState } from 'react'
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
import { type ProviderView } from '@/lib/providers'

type SnippetLanguage = 'curl' | 'openai-js' | 'openai-py'

const LANGUAGE_LABELS: Record<SnippetLanguage, string> = {
  curl: 'cURL',
  'openai-js': 'OpenAI JS SDK',
  'openai-py': 'OpenAI Python SDK',
}

const GATEWAY_KEY_PLACEHOLDER = '<gateway-key>'

interface CodeSnippetCardProps {
  readonly provider: ProviderView
}

export function CodeSnippetCard({ provider }: CodeSnippetCardProps) {
  const [catalog, setCatalog] = useState<CatalogView | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [modelId, setModelId] = useState<string | null>(null)
  const [language, setLanguage] = useState<SnippetLanguage>('curl')

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

  const availableModels =
    catalog === null
      ? ([] as readonly string[])
      : catalog.entries.filter((entry) => !entry.excluded).map((entry) => entry.modelId)
  const snippet = buildSnippet({
    language,
    origin: window.location.origin,
    providerId: provider.id,
    model: modelId ?? '',
  })

  return (
    <section className="bg-card rounded-xl border overflow-hidden">
      <div className="border-border flex items-center justify-between border-b px-5 py-4">
        <div className="flex items-center gap-2">
          <Terminal className="text-muted-foreground size-4" aria-hidden />
          <h2 className="text-sm font-semibold tracking-tight">Code snippet</h2>
        </div>
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
            disabled={availableModels.length === 0}
          >
            <SelectTrigger id="code-snippet-model" className="h-8 w-56" size="sm">
              <SelectValue>
                {availableModels.length === 0
                  ? loadFailed
                    ? 'No models yet'
                    : 'Loading models…'
                  : modelId ?? 'Pick a model'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              {availableModels.length === 0 ? (
                <SelectItem value="__none__" disabled>
                  {loadFailed ? 'No models yet' : 'Loading models…'}
                </SelectItem>
              ) : (
                availableModels.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
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

interface BuildSnippetInput {
  readonly language: SnippetLanguage
  readonly origin: string
  readonly providerId: string
  readonly model: string
}

function buildSnippet({ language, origin, providerId, model }: BuildSnippetInput): string {
  const baseUrl = `${origin}/providers/${providerId}`
  const chatCompletionsUrl = `${baseUrl}/v1/chat/completions`
  switch (language) {
    case 'curl':
      return [
        `curl -X POST ${chatCompletionsUrl} \\`,
        `  -H "Authorization: Bearer ${GATEWAY_KEY_PLACEHOLDER}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{`,
        `    "model": "${escapeQuotes(model)}",`,
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
        `  model: '${escapeQuotes(model)}',`,
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
        `    model='${escapeQuotes(model)}',`,
        `    messages=[{'role': 'user', 'content': 'Hello'}]`,
        `)`,
        ``,
        `print(completion.choices[0].message.content)`,
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
}

const BUILTINS: Record<SnippetLanguage, ReadonlySet<string>> = {
  curl: new Set(),
  'openai-js': new Set(['OpenAI', 'console']),
  'openai-py': new Set(['OpenAI']),
}

const TOKEN_REGEX: Record<SnippetLanguage, RegExp> = {
  curl: /<\w+>|"[^"]*"|'[^']*'|curl|-{1,2}\w+|\s+|\S/g,
  'openai-js':
    /<\w+>|"[^"]*"|'[^']*'|`[^`]*`|\b(?:import|from|const|let|var|await|new)\b|\b(?:OpenAI|console)\b|\s+|\S/g,
  'openai-py': /<\w+>|"[^"]*"|'[^']*'|\b(?:from|import|print)\b|\bOpenAI\b|\s+|\S/g,
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
