interface SignalTarget {
  once(signal: NodeJS.Signals, listener: () => void): unknown
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown
}

export function installShutdownSignalHandlers(
  iroha: { readonly stop: () => Promise<void> },
  options: {
    readonly signals?: readonly NodeJS.Signals[]
    readonly register?: SignalTarget
    readonly exit?: (status: number) => void
    readonly log?: (message: string) => void
  } = {},
): () => void {
  const signals = options.signals ?? ['SIGINT', 'SIGTERM'] as const
  const register = options.register ?? process
  const exit = options.exit ?? ((status: number) => process.exit(status))
  const log = options.log ?? ((message: string) => console.error(message))
  let stopping = false
  const listeners = new Map<NodeJS.Signals, () => void>()

  for (const signal of signals) {
    const listener = () => {
      if (stopping) return
      stopping = true
      void iroha.stop().then(
        () => exit(0),
        (error: unknown) => {
          log(error instanceof Error ? error.message : String(error))
          exit(1)
        },
      )
    }
    listeners.set(signal, listener)
    register.once(signal, listener)
  }

  return () => {
    for (const [signal, listener] of listeners) register.removeListener(signal, listener)
  }
}
