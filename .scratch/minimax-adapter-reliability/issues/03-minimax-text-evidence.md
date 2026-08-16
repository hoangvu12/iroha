# Emit MiniMax text failure and entitlement evidence

Status: Complete
Blocked by: 01

Add MiniMax-specific inference classification for structured 402/429 responses and normalize credit, five-hour, and weekly entitlement readings. Treat undocumented status numbers defensively; percentages and timestamps drive decisions while status numbers remain diagnostics.

Cover positive, zero, negative, weekly-limited, transient-throttle, malformed, and unavailable evidence.

## Comments

Added MiniMax text inference classification and authoritative entitlement mapping. Structured 402/429 emits provisional key-scoped evidence; bare/malformed responses remain generic and conservative. Percentages and timestamps, not undocumented status numbers, determine entitlement. Evidence: Wave 2 gate passed 221 tests, typecheck, and UI build.
