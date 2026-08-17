"""Rebuild the opencode `iroha` provider block from the gateway's global /v1/models.

Emits .scratch/opencode.generated.json (paste into the `models` object of the
`iroha` provider in ~/.config/opencode/opencode.json) plus a report of what was
skipped and which models fell back to family defaults.

Inputs, fetched first:
  curl -s -H "Authorization: Bearer $IROHA_GATEWAY_KEY" \
    http://127.0.0.1:3000/v1/models -o .scratch/models.json
  curl -s https://models.dev/api.json -o .scratch/modelsdev.json

Run from the repo root: python -X utf8 .scratch/build-opencode-models.py
"""

import io
import json
import re
from collections import OrderedDict

GATEWAY = json.load(io.open('.scratch/models.json', encoding='utf-8'))['data']
MODELSDEV = json.load(io.open('.scratch/modelsdev.json', encoding='utf-8'))

# --- non-chat modalities: unusable from a coding agent ---------------------
SKIP = [
    r'(^|[-/])tts([-.]|$)', r'-tts-', r'asr', r'realtime', r'-s2s-',
    r'text-embedding', r'embedding-v\d', r'(^|/)wan\d', r'z-image',
    r'image-\d|image-edit|image-plus|image-max|image-pro|qwen-image|qwen3-image',
    r'-ocr(-|$)', r'captioner', r'tingwu', r'lyria', r'-vc-', r'-vd-',
    r'livetranslate', r'qwen-audio', r'qwen-mt-',
]


def skipped(model_path: str) -> bool:
    low = model_path.lower()
    return any(re.search(p, low) for p in SKIP)


# --- models.dev index ------------------------------------------------------
# Only first-party catalogs: reseller entries in models.dev carry stale or
# invented limits, and a wrong context window is worse than a family default.
TRUSTED = ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'moonshotai',
           'minimax', 'zhipuai', 'alibaba', 'mistral', 'meta', 'nvidia',
           'cloudflare-workers-ai', 'poolside', 'stepfun']


DATE = r'-(20\d{2}-\d{2}-\d{2}|20\d{6})$'
SNAPSHOT = r'-\d{4}$'


def norm(model_id: str) -> str:
    """Collapse separator/version noise so `claude-opus-4-8` == `claude-opus-4.8`."""
    low = re.sub(r'[._]', '-', model_id.lower().split(':')[0])
    dated = re.sub(DATE, '', low)
    # Only 1-2 digit tails are version parts; 4-digit tails are snapshot dates.
    return re.sub(r'-(\d+)-(\d{1,2})(?=-|$)', r'-\1.\2', dated) + low[len(dated):]


INDEX = {}
for provider in TRUSTED:
    for model_id, model in MODELSDEV.get(provider, {}).get('models', {}).items():
        limit = model.get('limit') or {}
        if not limit.get('context'):
            continue
        INDEX.setdefault(norm(model_id), (limit['context'], limit.get('output') or 32768))

# Suffixes upstreams bolt onto a base model to pick a reasoning/speed tier.
TIER = r'-(thinking|reasoning|extra-low|low|medium|high|highspeed|agent|review|spark|free|preview|latest|fast-preview)$'


def lookup(model_id: str):
    """Resolve limits from the trusted index, peeling tier/date suffixes off the tail.

    A dated or tiered upstream name (`qwen-plus-2025-09-11`, `gemini-3.6-flash-low`)
    shares its base model's window, so peel one suffix at a time until a base hits.
    """
    key = norm(model_id)
    for _ in range(6):
        if key in INDEX:
            return INDEX[key]
        stripped = re.sub(TIER, '', key)
        for pattern in (DATE, SNAPSHOT, r'-(preview|latest)$'):
            if stripped == key:
                stripped = re.sub(pattern, '', key)
        if stripped == key:
            return None
        key = stripped
    return None


# --- family fallbacks for models newer than models.dev --------------------
FALLBACK = [
    (r'^claude-', 200000, 64000),
    (r'^gpt-3\.5', 16385, 4096),
    (r'^gpt-4-(0613|0125|o-preview)|^gpt-4$', 128000, 4096),
    (r'^gpt-4o', 128000, 16384),
    (r'^gpt-4\.1', 1047576, 32768),
    (r'^gpt-oss', 131072, 32768),
    (r'^(gpt-5|o3|o4)', 400000, 128000),
    (r'^gemini-', 1048576, 65536),
    (r'^gemma-', 131072, 8192),
    (r'^grok-', 256000, 64000),
    (r'^glm-', 200000, 128000),
    (r'^kimi-|^k2|^kat-coder', 262144, 128000),
    (r'^deepseek', 163840, 65536),
    (r'^minimax-m3$|^m3$', 1000000, 128000),
    (r'^minimax-|^m2', 204800, 131072),
    (r'^nemotron-', 131072, 32768),
    (r'^llama-4', 1048576, 8192),
    (r'^llama-', 128000, 8192),
    (r'^mistral-|^mimo-|^step-|^laguna-|^owl-', 131072, 32768),
    (r'^qwen3-coder-plus|^qwen-turbo|^qwen3\.[567]-plus|^qwen3\.8', 1000000, 65536),
    (r'^qwen3-coder', 262144, 65536),
    (r'^qwen3?[.-]?\d*[-.]?max', 262144, 65536),
    (r'^qwq|^qvq', 131072, 32768),
    (r'^qwen', 131072, 32768),
]
DEFAULT = (131072, 32768)

models, fell_back, dropped = OrderedDict(), [], []
for entry in GATEWAY:
    _, _, path = entry['id'].partition('/')
    if skipped(path):
        dropped.append(entry['id'])
        continue
    hit = lookup(path.split('/')[-1])
    if hit:
        context, output = hit
    else:
        tail = norm(path.split('/')[-1])
        context, output = DEFAULT
        for pattern, ctx, out in FALLBACK:
            if re.search(pattern, tail):
                context, output = ctx, out
                break
        fell_back.append(f"{entry['id']} -> {context}")
    # The name is the Qualified Model ID verbatim: it is what the picker shows
    # and what a caller sends upstream, and no two models collide on it.
    models[entry['id']] = {'name': entry['id'], 'limit': {'context': context, 'output': output}}

json.dump(models, io.open('.scratch/opencode.generated.json', 'w', encoding='utf-8'), indent=2)
print(f'kept {len(models)} models, skipped {len(dropped)} non-chat, {len(fell_back)} used family fallbacks')
io.open('.scratch/opencode-report.txt', 'w', encoding='utf-8').write(
    'SKIPPED (non-chat)\n' + '\n'.join(dropped) + '\n\nFALLBACK LIMITS\n' + '\n'.join(fell_back) + '\n')
