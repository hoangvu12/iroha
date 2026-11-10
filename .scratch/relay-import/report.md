# relay-hunt → iroha import

Manifest: `C:\Users\ADMIN\Desktop\nguyenvu\relay-hunt\pool\import-manifest.json` (generated 2026-11-10T02:11:57Z)
Admin surface: `https://iroha.nguyenvu.dev`
Mode: applied

## Numbers

| quantity | value |
|---|---|
| endpoints in plan | 19 |
| providers in plan | 18 |
| distinct canonical ids | 44 |
| rewrite entries | 79 |
| providers created | 0 |
| providers reused | 18 |
| endpoints added | 0 |
| endpoints extended | 0 |
| endpoints unchanged | 19 |
| skipped | 0 |
| failed | 0 |
| providers now in iroha | 67 |

## Dedupe

| host | provider | endpoints | canonical ids |
|---|---|---|---|
| `103.160.145.120` | `relay-103-160-145-120-20128` (reused) | 1 | 7 |
| `105.96.3.44` | `relay-105-96-3-44` (reused) | 1 | 3 |
| `144.22.238.16` | `relay-144-22-238-16-20128` (reused) | 1 | 6 |
| `150.241.102.68` | `relay-150-241-102-68` (reused) | 1 | 2 |
| `150.241.73.11` | `relay-150-241-73-11` (reused) | 1 | 1 |
| `161.118.212.102` | `relay-161-118-212-102` (reused) | 1 | 3 |
| `180.76.170.223` | `relay-180-76-170-223-20128` (reused) | 1 | 2 |
| `192.227.179.46` | `relay-192-227-179-46` (reused) | 1 | 3 |
| `217.60.245.205` | `relay-217-60-245-205-20128` (reused) | 1 | 4 |
| `52.66.181.17` | `relay-52-66-181-17` (reused) | 2 | 5 |
| `9router.iweka-internal.my.id` | `relay-9router-iweka-internal-my-id` (reused) | 1 | 10 |
| `ai.track360.net.in` | `relay-ai-track360-net-in` (reused) | 1 | 2 |
| `desktop-as3dt75.tail2daffa.ts.net` | `relay-desktop-as3dt75-tail2daffa-ts-net` (reused) | 1 | 18 |
| `omni.vietnamtutor.com` | `relay-omni-vietnamtutor-com` (reused) | 1 | 3 |
| `omniroute.nexacore.my.id` | `relay-omniroute-nexacore-my-id` (reused) | 1 | 9 |
| `omniroute.v-nance.com` | `relay-omniroute-v-nance-com` (reused) | 1 | 4 |
| `or.elija-labs.com` | `relay-or-elija-labs-com` (reused) | 1 | 1 |
| `sandesh-thapa-omniroute-space.hf.space` | `relay-sandesh-thapa-omniroute-space-hf-space` (reused) | 1 | 23 |

## Model shelf

| endpoint | canonical id | wire spelling | alternates |
|---|---|---|---|
| `103.160.145.120:20128` | `claude-fable-5-1` | _(identical)_ | — |
| `103.160.145.120:20128` | `claude-fable-5-2` | _(identical)_ | — |
| `103.160.145.120:20128` | `claude-opus-4-7` | _(identical)_ | — |
| `103.160.145.120:20128` | `claude-opus-4-8` | `auto/best-reasoning` | `claude-opus-4-8` |
| `103.160.145.120:20128` | `claude-opus-5` | _(identical)_ | — |
| `103.160.145.120:20128` | `claude-sonnet-5` | `auto/best-coding` | `claude-sonnet-5` |
| `103.160.145.120:20128` | `gpt-5-6-terra` | `gpt-5.6-terra` | — |
| `105.96.3.44:443` | `claude-opus-4-6` | `no-think/antigravity/claude-opus-4-6-thinking` | `claude-opus-4-6-thinking`, `claude-opus-4-6-thinking-high`, `claude-opus-4-6-thinking-low`, `claude-opus-4-6-thinking-medium`, `no-think/antigravity/claude-opus-4-6-thinking-low`, `no-think/antigravity/claude-opus-4-6-thinking-medium` |
| `105.96.3.44:443` | `claude-sonnet-4-6` | `no-think/antigravity/claude-sonnet-4-6` | `claude-sonnet-4-6`, `claude-sonnet-4-6-high`, `claude-sonnet-4-6-low`, `claude-sonnet-4-6-medium`, `no-think/antigravity/claude-sonnet-4-6-low`, `no-think/antigravity/claude-sonnet-4-6-medium` |
| `105.96.3.44:443` | `gemini-3-6-flash` | `auto/best-coding` | `gemini-3.6-flash-high` |
| `144.22.238.16:20128` | `claude-opus-5-5` | _(identical)_ | `claude-opus-5-5-high` |
| `144.22.238.16:20128` | `claude-sonnet-5-5` | _(identical)_ | `claude-sonnet-5-5-high` |
| `144.22.238.16:20128` | `deepseek-v4-pro-0813` | `auto/deepseek` | `deepseek-ai/deepseek-v4-pro-0813` |
| `144.22.238.16:20128` | `gemini-3-8-flash` | `gemini-3.8-flash` | `gemini-3.8-flash-high` |
| `144.22.238.16:20128` | `gemini-3-flash` | `auto/gemini` | `gemini-3-flash-preview` |
| `144.22.238.16:20128` | `glm-5-2` | `auto/best-coding` | `zai-org/glm-5.2` |
| `150.241.102.68:443` | `gemini-2-5-flash` | `auto/best-coding` | `google/gemini-2.5-flash-lite` |
| `150.241.102.68:443` | `minimax-m3` | `auto/minimax` | `minimax/minimax-m3` |
| `150.241.73.11:443` | `gemini-2-5-flash` | `auto/best-coding` | `google/gemini-2.5-flash-lite` |
| `161.118.212.102:443` | `gemini-2-5-flash` | `auto/gemini` | `gemini-2.5-flash` |
| `161.118.212.102:443` | `gpt-4o` | `auto/best-coding` | `gpt-4o-2024-11-20` |
| `161.118.212.102:443` | `gpt-5-6-sol` | `agentrouter/gpt-5.6-sol` | `gpt-5.6-sol` |
| `180.76.170.223:20128` | `deepseek-v3-2` | `ds-web/DeepSeek V3.2` | `DeepSeek V3.2`, `DeepSeek-V3.2`, `auto/claude-sonnet` |
| `180.76.170.223:20128` | `deepseek-v4-pro-0813` | `auto/best-coding` | `deepseek-v4-pro` |
| `192.227.179.46:443` | `claude-opus-4-6` | `auto/minimax` | `claude-opus-4-6-thinking` |
| `192.227.179.46:443` | `gpt-5-6-terra` | `gpt-5.6-terra` | — |
| `192.227.179.46:443` | `gpt-6-luna` | `auto/best-reasoning` | `gpt-6-luna` |
| `217.60.245.205:20128` | `claude-fable-5-2` | `claude/claude-fable-5-xhigh` | `auto/minimax`, `claude-fable-5`, `claude-fable-5-2` |
| `217.60.245.205:20128` | `claude-opus-5` | `auto/claude-opus` | `claude-opus-5` |
| `217.60.245.205:20128` | `claude-opus-5-5` | `claude/claude-opus-5-5-xhigh` | `claude-opus-5-5` |
| `217.60.245.205:20128` | `claude-sonnet-5-5` | `auto/best-reasoning` | `claude-sonnet-5-5` |
| `52.66.181.17:443` | `claude-opus-4-7` | _(identical)_ | — |
| `52.66.181.17:443` | `claude-opus-4-8` | _(identical)_ | — |
| `52.66.181.17:443` | `claude-opus-5` | _(identical)_ | — |
| `52.66.181.17:443` | `claude-sonnet-5-5` | `auto/best-coding` | `claude-sonnet-5-5` |
| `52.66.181.17:443` | `minimax-m3` | `auto/minimax` | `MiniMaxAI/MiniMax-M3` |
| `52.66.181.17:80` | `claude-opus-4-7` | _(identical)_ | — |
| `52.66.181.17:80` | `claude-opus-4-8` | _(identical)_ | — |
| `52.66.181.17:80` | `claude-opus-5` | _(identical)_ | — |
| `52.66.181.17:80` | `claude-sonnet-5-5` | `auto/best-coding` | `claude-sonnet-5-5` |
| `52.66.181.17:80` | `minimax-m3` | `auto/minimax` | `MiniMaxAI/MiniMax-M3` |
| `9router.iweka-internal.my.id:443` | `claude-fable-5-1` | _(identical)_ | — |
| `9router.iweka-internal.my.id:443` | `claude-fable-5-2` | `auto/best-coding` | `claude-fable-5-2` |
| `9router.iweka-internal.my.id:443` | `claude-haiku-4-5` | `auto/best-reasoning` | `claude-haiku-4-5-20251001` |
| `9router.iweka-internal.my.id:443` | `claude-opus-4-7` | `auto/claude-opus` | `claude-opus-4-7` |
| `9router.iweka-internal.my.id:443` | `claude-opus-4-8` | _(identical)_ | — |
| `9router.iweka-internal.my.id:443` | `claude-opus-5` | _(identical)_ | — |
| `9router.iweka-internal.my.id:443` | `claude-opus-5-5` | _(identical)_ | — |
| `9router.iweka-internal.my.id:443` | `claude-sonnet-5` | `auto/claude-sonnet` | `claude-sonnet-5` |
| `9router.iweka-internal.my.id:443` | `claude-sonnet-5-5` | _(identical)_ | — |
| `9router.iweka-internal.my.id:443` | `gpt-oss-120b` | `auto/minimax` | `gpt-oss-120b-medium` |
| `ai.track360.net.in:443` | `claude-fable-5-2` | `claude/claude-fable-5` | `claude-fable-5`, `claude-fable-5-high`, `claude-fable-5-low`, `claude-fable-5-medium`, `claude/claude-fable-5-low`, `claude/claude-fable-5-medium` |
| `ai.track360.net.in:443` | `gemini-3-6-flash` | `auto/best-coding` | `gemini-3.6-flash-high` |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `claude-fable-5-1` | _(identical)_ | — |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `claude-fable-5-2` | _(identical)_ | — |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `claude-haiku-5-5` | _(identical)_ | — |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `claude-opus-4-7` | _(identical)_ | — |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `claude-opus-4-8` | _(identical)_ | — |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `claude-opus-5` | _(identical)_ | — |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `claude-opus-5-5` | `auto/claude-opus` | `claude-opus-5-5` |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `claude-sonnet-4-6` | `auto/claude-sonnet` | `claude-sonnet-4-6` |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `claude-sonnet-5-5` | _(identical)_ | — |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `gemini-3-8-flash` | `gemini-3.8-flash` | `gemini-3.8-flash-high` |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `gemini-3-flash` | `auto/minimax` | `gemini-3-flash` |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `gpt-5-6-sol` | `gpt-5.6-sol` | — |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `gpt-5-6-terra` | `gpt-5.6-terra` | — |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `gpt-6-1-sol` | `gpt-6.1-sol` | — |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `gpt-6-1-terra` | `gpt-6.1-terra` | — |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `gpt-6-astra` | _(identical)_ | — |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `gpt-6-sol` | _(identical)_ | — |
| `desktop-as3dt75.tail2daffa.ts.net:443` | `gpt-oss-120b` | `auto/best-coding` | `openai/gpt-oss-120b` |
| `omni.vietnamtutor.com:443` | `claude-sonnet-4-6` | `auto/best-reasoning` | `claude-sonnet-4-6` |
| `omni.vietnamtutor.com:443` | `gemini-3-1-pro` | `auto/gemini` | `gemini-3.1-pro-low` |
| `omni.vietnamtutor.com:443` | `gemini-3-7-flash` | `auto/best-coding` | `gemini-3.7-flash-high` |
| `omniroute.nexacore.my.id:443` | `claude-fable-5-1` | `claude-fable-5.1` | — |
| `omniroute.nexacore.my.id:443` | `claude-fable-5-2` | _(identical)_ | — |
| `omniroute.nexacore.my.id:443` | `claude-haiku-5-5` | _(identical)_ | — |
| `omniroute.nexacore.my.id:443` | `claude-opus-4-8` | `claude-opus-4.8` | — |
| `omniroute.nexacore.my.id:443` | `claude-opus-5-5` | _(identical)_ | `auto/claude-opus`, `claude-opus-5-5-high` |
| `omniroute.nexacore.my.id:443` | `claude-sonnet-5-5` | _(identical)_ | `auto/claude-sonnet`, `claude-sonnet-5-5-high` |
| `omniroute.nexacore.my.id:443` | `deepseek-v4-1-flash` | `deepseek-v4.1-flash` | — |
| `omniroute.nexacore.my.id:443` | `gemini-3-1-flash-lite` | `auto/gemini` | `gemini-3.1-flash-lite` |
| `omniroute.nexacore.my.id:443` | `gpt-6-sol` | _(identical)_ | — |
| `omniroute.v-nance.com:443` | `claude-opus-4-6` | `auto/best-coding` | `claude-opus-4-6-thinking` |
| `omniroute.v-nance.com:443` | `claude-sonnet-4-6` | `no-think/agy/claude-sonnet-4-6` | `claude-sonnet-4-6` |
| `omniroute.v-nance.com:443` | `gemini-3-1-pro` | `agy/gemini-3.1-pro-high` | `gemini-3.1-pro-high` |
| `omniroute.v-nance.com:443` | `gemini-3-5-flash` | `agy/gemini-3.5-flash-low` | `agy/gemini-3.5-flash-medium`, `gemini-3.5-flash-high`, `gemini-3.5-flash-low`, `gemini-3.5-flash-medium` |
| `or.elija-labs.com:443` | `gpt-4o` | `auto/best-coding` | `gpt-4o-2024-11-20` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `claude-opus-4-7` | `claude-opus-4.7` | `anthropic/claude-opus-4.7` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `claude-opus-4-8` | `claude-opus-4.8` | `anthropic/claude-opus-4.8` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `claude-opus-5` | _(identical)_ | `anthropic/claude-opus-5`, `anthropic/claude-opus-5-fast`, `auto/claude-opus` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `claude-sonnet-5` | `auto/claude-sonnet` | `anthropic/claude-sonnet-5` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `deepseek-v4-pro-0813` | `auto/deepseek` | `deepseek/deepseek-v4-pro-0813` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `gemini-2-5-flash` | `auto/best-coding` | `gemini-2.5-flash` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `gemini-3-7-flash` | `gemini-3.7-flash` | `google/gemini-3.7-flash` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `gemini-3-8-flash` | `gemini-3.8-flash` | `gemini-3.8-flash-high` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `gemini-4-argon` | `openrouter/gemini-4-argon` | `gemini-4-argon` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `gpt-5-2-pro` | `gpt-5.2-pro` | `openai/gpt-5.2-pro` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `gpt-5-4` | `gpt-5.4` | `openai/gpt-5.4` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `gpt-5-5` | `gpt-5.5` | `openai/gpt-5.5` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `gpt-5-5-pro` | `gpt-5.5-pro` | `openai/gpt-5.5-pro` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `gpt-5-6-sol` | `gpt-5.6-sol` | `openai/gpt-5.6-sol` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `gpt-5-6-terra` | `gpt-5.6-terra` | `openai/gpt-5.6-terra` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `gpt-6-astra` | `openrouter/gpt-6-astra` | `gpt-6-astra` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `gpt-6-sol` | `openrouter/gpt-6-sol` | `gpt-6-sol` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `grok-4-6` | `grok-4.6` | `x-ai/grok-4.6` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `kimi-k3` | `openrouter/kimi-k3` | `auto/kimi`, `kimi-k3`, `moonshotai/kimi-k3` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `minimax-m3` | `auto/minimax` | `minimax/minimax-m3` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `muse-spark-1-1` | `muse-spark-1.1` | `meta/muse-spark-1.1` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `muse-spark-1-2` | `muse-spark-1.2` | `meta/muse-spark-1.2` |
| `sandesh-thapa-omniroute-space.hf.space:443` | `qwen3-8-max` | `qwen3.8-max` | `qwen/qwen3.8-max` |

## Verification through iroha

| provider | endpoint | model | status | served |
|---|---|---|---|---|
| `relay-103-160-145-120-20128` | `103.160.145.120:20128` | `claude-fable-5-2` | 200 | `claude-fable-5-2` |
| `relay-105-96-3-44` | `105.96.3.44:443` | `gemini-3-6-flash` | 502 ✗ | _The Provider could not be reached._ |
| `relay-105-96-3-44` | `105.96.3.44:443` | `claude-opus-4-6` | 502 ✗ | _The Provider could not be reached._ |
| `relay-105-96-3-44` | `105.96.3.44:443` | `claude-sonnet-4-6` | 502 ✗ | _The Provider could not be reached._ |
| `relay-144-22-238-16-20128` | `144.22.238.16:20128` | `claude-opus-5-5` | 200 | `claude-opus-5-5-high` |
| `relay-150-241-102-68` | `150.241.102.68:443` | `minimax-m3` | 502 ✗ | _The Provider could not be reached._ |
| `relay-150-241-102-68` | `150.241.102.68:443` | `gemini-2-5-flash` | 502 ✗ | _The Provider could not be reached._ |
| `relay-150-241-73-11` | `150.241.73.11:443` | `gemini-2-5-flash` | 502 ✗ | _The Provider could not be reached._ |
| `relay-161-118-212-102` | `161.118.212.102:443` | `gpt-5-6-sol` | 502 ✗ | _The Provider could not be reached._ |
| `relay-161-118-212-102` | `161.118.212.102:443` | `gemini-2-5-flash` | 502 ✗ | _The Provider could not be reached._ |
| `relay-161-118-212-102` | `161.118.212.102:443` | `gpt-4o` | 502 ✗ | _The Provider could not be reached._ |
| `relay-180-76-170-223-20128` | `180.76.170.223:20128` | `deepseek-v4-pro-0813` | 200 | `deepseek-v4-pro` |
| `relay-192-227-179-46` | `192.227.179.46:443` | `gpt-5-6-terra` | 502 ✗ | _The Provider could not be reached._ |
| `relay-192-227-179-46` | `192.227.179.46:443` | `gpt-6-luna` | 502 ✗ | _The Provider could not be reached._ |
| `relay-192-227-179-46` | `192.227.179.46:443` | `claude-opus-4-6` | 502 ✗ | _The Provider could not be reached._ |
| `relay-217-60-245-205-20128` | `217.60.245.205:20128` | `claude-fable-5-2` | 200 | `claude-fable-5` |
| `relay-52-66-181-17` | `52.66.181.17:443` | `claude-sonnet-5-5` | 502 ✗ | _The Provider could not be reached._ |
| `relay-52-66-181-17` | `52.66.181.17:443` | `claude-opus-5` | 200 | `claude-opus-5` |
| `relay-52-66-181-17` | `52.66.181.17:80` | `claude-sonnet-5-5` | 502 ✗ | _The Provider could not be reached._ |
| `relay-52-66-181-17` | `52.66.181.17:80` | `claude-opus-5` | 200 | `claude-opus-5` |
| `relay-9router-iweka-internal-my-id` | `9router.iweka-internal.my.id:443` | `claude-fable-5-2` | 200 | `claude-fable-5-2` |
| `relay-ai-track360-net-in` | `ai.track360.net.in:443` | `claude-fable-5-2` | 200 | `claude-fable-5` |
| `relay-desktop-as3dt75-tail2daffa-ts-net` | `desktop-as3dt75.tail2daffa.ts.net:443` | `claude-fable-5-2` | 200 | `claude-fable-5-2` |
| `relay-omni-vietnamtutor-com` | `omni.vietnamtutor.com:443` | `gemini-3-7-flash` | 200 | `gemini-3.7-flash-high` |
| `relay-omniroute-nexacore-my-id` | `omniroute.nexacore.my.id:443` | `claude-fable-5-2` | 200 | `claude-fable-5-2` |
| `relay-omniroute-v-nance-com` | `omniroute.v-nance.com:443` | `gemini-3-1-pro` | 200 | `gemini-3.1-pro-high` |
| `relay-or-elija-labs-com` | `or.elija-labs.com:443` | `gpt-4o` | 200 | `gpt-4o-2024-11-20` |
| `relay-sandesh-thapa-omniroute-space-hf-space` | `sandesh-thapa-omniroute-space.hf.space:443` | `gpt-6-astra` | 503 ✗ | _No eligible Upstream Key is available for this connection._ |
| `relay-sandesh-thapa-omniroute-space-hf-space` | `sandesh-thapa-omniroute-space.hf.space:443` | `gemini-4-argon` | 503 ✗ | _No eligible Upstream Key is available for this connection._ |
| `relay-sandesh-thapa-omniroute-space-hf-space` | `sandesh-thapa-omniroute-space.hf.space:443` | `claude-opus-5` | 503 ✗ | _No eligible Upstream Key is available for this connection._ |

## Per-key state

| provider | key base URL | health | allowed models | rewrites |
|---|---|---|---|---|
| `relay-sandesh-thapa-omniroute-space-hf-space` | `https://sandesh-thapa-omniroute-space.hf.space/v1` | cooling_down | 23 | 22 |
| `relay-or-elija-labs-com` | `https://or.elija-labs.com/v1` | active | 1 | 1 |
| `relay-omniroute-v-nance-com` | `https://omniroute.v-nance.com/v1` | active | 4 | 4 |
| `relay-omniroute-nexacore-my-id` | `https://omniroute.nexacore.my.id/v1` | active | 9 | 4 |
| `relay-omni-vietnamtutor-com` | `https://omni.vietnamtutor.com/v1` | active | 3 | 3 |
| `relay-desktop-as3dt75-tail2daffa-ts-net` | `https://desktop-as3dt75.tail2daffa.ts.net/v1` | active | 18 | 9 |
| `relay-ai-track360-net-in` | `https://ai.track360.net.in/v1` | active | 2 | 2 |
| `relay-9router-iweka-internal-my-id` | `https://9router.iweka-internal.my.id/v1` | active | 10 | 5 |
| `relay-52-66-181-17` | `https://52.66.181.17:443/v1` | active | 5 | 2 |
| `relay-52-66-181-17` | `http://52.66.181.17:80/v1` | active | 5 | 2 |
| `relay-217-60-245-205-20128` | `http://217.60.245.205:20128/v1` | active | 4 | 4 |
| `relay-192-227-179-46` | `https://192.227.179.46:443/v1` | active | 3 | 3 |
| `relay-180-76-170-223-20128` | `http://180.76.170.223:20128/v1` | active | 2 | 2 |
| `relay-161-118-212-102` | `https://161.118.212.102/v1` | active | 3 | 3 |
| `relay-150-241-102-68` | `https://150.241.102.68:443/v1` | active | 2 | 2 |
| `relay-144-22-238-16-20128` | `http://144.22.238.16:20128/v1` | active | 6 | 4 |
| `relay-105-96-3-44` | `https://105.96.3.44:443/v1` | active | 3 | 3 |
| `relay-103-160-145-120-20128` | `http://103.160.145.120:20128/v1` | active | 7 | 3 |
| `relay-150-241-73-11` | `https://150.241.73.11:443/v1` | active | 1 | 1 |
