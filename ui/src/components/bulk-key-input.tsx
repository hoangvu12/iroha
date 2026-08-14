import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { CircleAlert, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  parseBulkKeyInput,
  parseBulkKeyJson,
  type ParseBulkResult,
} from '@/lib/parse-bulk-keys'

const DEFAULT_MAX_ENTRIES = 200
const DEBOUNCE_MS = 100

const PASTE_PLACEHOLDER = [
  '# Lines starting with # are skipped.',
  '# One Upstream Key per line. Optional base URL override after a comma or pipe.',
  'sk-abc',
  'sk-def,https://my-proxy.example.com/v1',
  'sk-ghi|https://other-endpoint.example.com/v2',
].join('\n')

type Tab = 'paste' | 'upload'

const TABS: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: 'paste', label: 'Paste' },
  { id: 'upload', label: 'Upload' },
]

interface BulkKeyInputProps {
  readonly onParsed: (result: ParseBulkResult & { ok: true }) => void
  readonly defaultBaseUrl: string
  readonly maxEntries?: number
}

const EMPTY_PARSE: ParseBulkResult & { ok: true } = {
  ok: true,
  entries: [],
  skippedHeader: false,
  comments: 0,
}

export function BulkKeyInput({
  onParsed,
  defaultBaseUrl,
  maxEntries = DEFAULT_MAX_ENTRIES,
}: BulkKeyInputProps) {
  // `defaultBaseUrl` is the Provider's URL that bulk-imported keys inherit
  // when their row omits one. The parent dialog threads it into
  // `createProvider` / `bulkAddKeys`; we keep it in the prop signature so
  // the same component works for both call sites without changing the
  // interface later.
  void defaultBaseUrl

  const [tab, setTab] = useState<Tab>('paste')
  const [text, setText] = useState('')
  const [textParse, setTextParse] = useState<ParseBulkResult | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [fileParse, setFileParse] = useState<ParseBulkResult | null>(null)

  const onParsedRef = useRef(onParsed)
  onParsedRef.current = onParsed

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const trimmed = text.trim()
      if (trimmed === '') {
        setTextParse(null)
        return
      }
      setTextParse(parseBulkKeyInput(text))
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [text])

  const effectiveParse = useMemo<ParseBulkResult & { ok: true }>(() => {
    const source = tab === 'paste' ? textParse : fileParse
    if (source !== null && source.ok) return source
    return EMPTY_PARSE
  }, [tab, textParse, fileParse])

  useEffect(() => {
    onParsedRef.current(effectiveParse)
  }, [effectiveParse])

  const hasUsableInput =
    tab === 'paste'
      ? text.trim() !== ''
      : fileName !== null && (fileParse === null || fileParse.ok)

  const showParseFailedAlert =
    tab === 'upload' && fileParse !== null && !fileParse.ok

  const entryCount = effectiveParse.entries.length
  const showTooManyAlert = entryCount > maxEntries

  const tablistRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const onTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const currentIndex = TABS.findIndex((t) => t.id === tab)
      if (currentIndex === -1) return
      let nextIndex: number | null = null
      switch (event.key) {
        case 'ArrowRight':
          nextIndex = (currentIndex + 1) % TABS.length
          break
        case 'ArrowLeft':
          nextIndex = (currentIndex - 1 + TABS.length) % TABS.length
          break
        case 'Home':
          nextIndex = 0
          break
        case 'End':
          nextIndex = TABS.length - 1
          break
        default:
          return
      }
      event.preventDefault()
      const nextTab = TABS[nextIndex]
      if (nextTab !== undefined) {
        setTab(nextTab.id)
      }
    },
    [tab],
  )

  // When the tab changes via keyboard navigation, follow the focus to the
  // newly selected tab so the focus ring stays inside the tablist. Mouse
  // clicks on a tab already land focus on that button, so this effect is
  // a no-op for mouse interactions.
  useEffect(() => {
    const tablist = tablistRef.current
    if (tablist === null) return
    if (!tablist.contains(document.activeElement)) return
    const index = TABS.findIndex((t) => t.id === tab)
    if (index === -1) return
    tabRefs.current[index]?.focus()
  }, [tab])

  const onFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (file === undefined) {
        setFileName(null)
        setFileParse(null)
        return
      }
      setFileName(file.name)
      const reader = new FileReader()
      reader.onload = () => {
        const contents = typeof reader.result === 'string' ? reader.result : ''
        const lower = file.name.toLowerCase()
        if (lower.endsWith('.json')) {
          setFileParse(parseBulkKeyJson(contents))
        } else {
          setFileParse(parseBulkKeyInput(contents))
        }
      }
      reader.onerror = () => {
        setFileParse({
          ok: false,
          reason: 'malformed_json',
          message: 'Could not read the file',
        })
      }
      reader.readAsText(file)
    },
    [],
  )

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={tablistRef}
        role="tablist"
        aria-label="Bulk key input source"
        className="flex items-center gap-1 border-b"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map((t, i) => {
          const isActive = t.id === tab
          return (
            <Button
              key={t.id}
              ref={(el) => {
                tabRefs.current[i] = el
              }}
              type="button"
              role="tab"
              id={`bulk-key-tab-${t.id}`}
              aria-selected={isActive}
              aria-controls={`bulk-key-panel-${t.id}`}
              tabIndex={isActive ? 0 : -1}
              variant={isActive ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </Button>
          )
        })}
      </div>

      <div
        role="tabpanel"
        id={`bulk-key-panel-${tab}`}
        aria-labelledby={`bulk-key-tab-${tab}`}
      >
        {tab === 'paste' ? (
          <textarea
            aria-label="Paste upstream keys"
            className={cn(
              'border-input bg-transparent ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex w-full rounded-md border px-3 py-2 font-mono text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
              'min-h-[16rem] resize-y',
            )}
            rows={12}
            placeholder={PASTE_PLACEHOLDER}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <Input
              type="file"
              accept=".csv,.json"
              aria-label="Upload upstream keys file"
              onChange={onFileChange}
              className="cursor-pointer"
            />
            <p className="text-muted-foreground text-xs">
              CSV or JSON. CSV is parsed the same way as the Paste tab.
            </p>
          </div>
        )}
      </div>

      {showParseFailedAlert && !fileParse.ok && (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden />
          <AlertTitle>That file isn't a valid JSON array.</AlertTitle>
          <AlertDescription>{fileParse.message}</AlertDescription>
        </Alert>
      )}

      {showTooManyAlert && (
        <Alert role="status">
          <TriangleAlert aria-hidden />
          <AlertTitle>
            {entryCount} entries parsed · limit is {maxEntries} · trim the file
            and try again
          </AlertTitle>
        </Alert>
      )}

      <p aria-live="polite" className="text-muted-foreground text-xs">
        {hasUsableInput ? (
          <>
            {entryCount} entries parsed ·{' '}
            {effectiveParse.skippedHeader ? 1 : 0} header skipped ·{' '}
            {effectiveParse.comments} comments skipped
          </>
        ) : (
          'No entries yet'
        )}
      </p>
    </div>
  )
}
