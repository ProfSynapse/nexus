# Async artifact jobs and deep research generation plan

## Goal

Add a shared completion pattern for long-running generated artifacts:

- `generateVideo` starts video generation and saves completed MP4 output to the requested `outputPath`.
- `generateResearch` starts deep research and saves completed Markdown output to the requested `outputPath`.
- If the provider job outlives the tool call timeout, the tool result returns a structured `in_progress` payload with the provider job id, polling URL or response id, intended output path, and a human note explaining where the completed artifact should land.

This keeps the chat/tool call useful even when the provider keeps working after the bot times out.

## Provider research notes

- OpenAI Responses API supports `background: true` and polling by response id with `GET /v1/responses/{response_id}`. OpenAI documents background response data retention as roughly 10 minutes, so Nexus should persist and poll promptly after timeout.
  - Source: https://platform.openai.com/docs/guides/background
  - Source: https://platform.openai.com/docs/guides/deep-research
- Perplexity Sonar Deep Research supports async jobs through `POST /v1/async/sonar` and retrieval with `GET /v1/async/sonar/{request_id}`. Perplexity documents async job/result TTL as 7 days.
  - Source: https://docs.perplexity.ai/docs/sonar/models/sonar-deep-research

## Result contract

Successful generated artifact tools should include:

```ts
{
  status: "completed",
  path: "Media/example.mp4",
  provider: "openrouter",
  model: "google/veo-3.1-lite",
  note: "Video generation completed and saved to Media/example.mp4."
}
```

Timed-out but recoverable generated artifact tools should include:

```ts
{
  status: "in_progress",
  path: "Research/topic.md",
  provider: "openai",
  model: "o3-deep-research",
  providerJobId: "resp_...",
  pollingUrl: "https://api.openai.com/v1/responses/resp_...",
  note: "Research is still running. The requested output path is Research/topic.md; keep the provider job details so a follow-up status check can save the completed report there."
}
```

The `note` is intentionally redundant with structured fields because LLM callers often preserve natural language better than nested metadata across turns.

## Shared job registry

Add `src/services/artifacts/ArtifactJobStore.ts`.

Storage:

- Vault path: `<configured Nexus storage root>/data/artifact-jobs.jsonl`, for example `Nexus/data/artifact-jobs.jsonl` or `Assistant data/data/artifact-jobs.jsonl`.
- Resolve the root with `resolveVaultRoot(settings).dataPath`; never hardcode `.nexus` or `Nexus`.
- The data path uses `vault.adapter`, consistent with existing configurable Nexus data storage.
- One event per state transition so interrupted writes do not corrupt the whole registry.

Job shape:

```ts
type ArtifactJobKind = "video" | "research";
type ArtifactJobStatus = "queued" | "in_progress" | "completed" | "failed" | "expired";

interface ArtifactJobRecord {
  id: string;
  kind: ArtifactJobKind;
  provider: string;
  model: string;
  providerJobId: string;
  pollingUrl?: string;
  status: ArtifactJobStatus;
  outputPath: string;
  overwrite: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  promptPreview: string;
  error?: string;
  result?: Record<string, unknown>;
}
```

## New status/finalization tool

Add `promptManager.checkGeneratedArtifact`.

Inputs:

- `jobId` or provider details from a previous timed-out tool call
- optional `outputPath` override
- optional `overwrite`

Behavior:

- Loads the saved job record if `jobId` is provided.
- Polls the provider.
- If complete, saves the artifact to `outputPath`.
- Returns the same `status`, `path`, and `note` contract as `generateVideo` / `generateResearch`.

This is the tool the bot should call after it times out or after the user asks “did it finish?”

## `generateResearch`

Tool slug: `generateResearch`

Initial providers:

- `openai`
- `perplexity`

Parameters:

```ts
interface GenerateResearchParams {
  prompt: string;
  provider?: "openai" | "perplexity";
  model?: string;
  outputPath: string;
  overwrite?: boolean;
  format?: "report" | "brief" | "markdown";
  reasoningEffort?: "low" | "medium" | "high";
  pollIntervalMs?: number;
  timeoutMs?: number;
}
```

Default behavior:

- Resolve provider/model from new Research generation settings.
- Require `outputPath` ending in `.md`.
- Save Markdown with title, generated body, citations/sources, and provider metadata footer.
- Return a completion note that says where the report exists.

Provider adapters:

- `OpenAIResearchAdapter`
  - Start: `POST /responses` with `background: true`.
  - Poll: `GET /responses/{response_id}`.
  - Parse output text and URL citations from the response output array.
  - Expiration hint: roughly 10 minutes.
- `PerplexityResearchAdapter`
  - Start: `POST /v1/async/sonar` with `request.model = "sonar-deep-research"`.
  - Poll: `GET /v1/async/sonar/{request_id}`.
  - Parse `response.choices[0].message.content`, citations, and usage if present.
  - Expiration hint: 7 days.

## Implementation sequence

1. Finish `generateVideo` result notes and structured timeout results.
2. Add `ArtifactJobStore` and `checkGeneratedArtifact`.
3. Add research model/provider registry and defaults settings.
4. Add `ResearchGenerationService` with OpenAI and Perplexity adapters.
5. Add `generateResearch` PromptManager tool and dynamic registration.
6. Add unit tests for timeout job persistence, successful finalization, OpenAI response parsing, and Perplexity async response parsing.
7. Add gated live smoke tests:
   - OpenAI background timeout/retrieve without requiring a large paid report.
   - Perplexity async submit/retrieve with paid execution opt-in.

## Current implementation slice

`generateVideo` now:

- `status: "completed"` and a saved-path note on success.
- Persists timed-out video jobs to `<configured Nexus storage root>/data/artifact-jobs.jsonl`.
- Returns `status: "in_progress"`, Nexus `jobId`, provider job details, and an output-path note when the provider is still running after the tool timeout.

`checkGeneratedArtifact` now:

- Loads a saved generated artifact job by `jobId`.
- Supports video jobs for Google and OpenRouter.
- Polls the provider, saves the completed MP4 to the original `outputPath`, and updates the job record to `completed`, `in_progress`, or `failed`.
- Returns the same `status`, `path`, and `note` contract planned for future generated artifact tools.
