# Provider listings

How to ask a provider what it currently serves. Use these before writing an
entry and before asserting a model does not exist. Each command reads the key
from `.env` without printing it. None of this is a list of models — run it.

## Google (keyed)

```bash
node -e '
const fs=require("node:fs");
const env=Object.fromEntries(fs.readFileSync(".env","utf8").split("\n").filter(l=>l.includes("=")&&!l.startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^"|"$/g,"")]}));
fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",{headers:{"x-goog-api-key":env.GEMINI_API_KEY||env.GOOGLE_API_KEY}})
 .then(r=>r.json()).then(j=>{for(const m of j.models||[])console.log(m.name.replace("models/",""),"| in",m.inputTokenLimit,"out",m.outputTokenLimit,"|",(m.supportedGenerationMethods||[]).join(","))})'
```

Read `supportedGenerationMethods`: an id with `bidiGenerateContent` only is a
Live/realtime model and belongs to `add-realtime-voice-model.md`, not to
`GoogleModels.ts`. `inputTokenLimit` / `outputTokenLimit` are `contextWindow` /
`maxTokens`. Pricing is not in this listing — get it from
ai.google.dev/gemini-api/docs/pricing, which also carries the context-caching
(cache read) rate.

## OpenRouter (keyless, includes pricing)

```bash
curl -s https://openrouter.ai/api/v1/models | python3 -c '
import sys,json
for m in json.load(sys.stdin)["data"]:
    if "<vendor>/<needle>" in m["id"]:
        p=m["pricing"]; print(m["id"],"| ctx",m.get("context_length"),"| in",float(p["prompt"])*1e6,"out",float(p["completion"])*1e6,"cacheRead",float(p.get("input_cache_read") or 0)*1e6,"|",",".join(x for x in m.get("supported_parameters",[]) if x in ("tools","reasoning","structured_outputs")))'
```

`pricing.*` is USD per token — multiply by 1e6. `input_cache_read` is
`cacheReadCostPerMillion`. `supported_parameters` containing `tools` /
`reasoning` / `structured_outputs` is the provider's own word on
`supportsFunctions` / `supportsThinking` / `supportsJSON`. `context_length` is
the gateway's window, which can differ from the vendor's.

## Others

Anthropic: the `claude-api` skill is the maintained reference. OpenAI:
`GET https://api.openai.com/v1/models` lists ids only, no pricing or limits.
Where a provider has no listing endpoint, its public model page is the source
and the entry must say so in a comment.

## Checking for shutdowns

A provider listing a model says nothing about how long it stays. Read the notices
and match every id across every catalog, including speech, realtime, transcription
and the subscription twins, whose ids can outlive the API's or vanish before it:

- OpenRouter: `expiration_date` on `/api/v1/models`, plus any registered id the
  listing no longer returns.
- OpenAI, Google, Anthropic, Groq, Mistral: their deprecation pages. Anthropic's
  "not sooner than" is a floor, not a shutdown date.
- Parse table rows rather than scanning text near an id: a neighbouring row's date
  otherwise reads as that model's.

Export the real catalogs to compare. A regex over the source misses ids declared
through a constant, which once reported a shipped flagship as missing.

Read a replacement before removing its predecessor. It may be a different API, so
removal can take a feature with it rather than swap a model. Retired ids go in
`RetiredMediaModels.ts` so saved selections keep working.

When bulk-refreshing prices from a listing, match on id and name together. Some ids
are registered twice on purpose, as 200K and 1M context variants of one model, and
a refresh keyed on id alone overwrites the smaller one. The registry gate catches
this as a duplicate entry, so run it after any scripted edit.
