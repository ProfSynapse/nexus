# `src/ui`

UI layer for the native chat view and supporting UX (controllers, coordinators, renderers, suggesters, builders).

## What's Here

- `chat/` — chat view composition:
  - components (renderers/suggesters/factories)
  - controllers/coordinators
  - chat-specific services + utilities

## Improvement Ideas

- Keep UI state models in `src/types/` and avoid duplicating payload shapes across services/UI.
- Consider a single rendering pipeline abstraction for message/tool-call rendering.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
