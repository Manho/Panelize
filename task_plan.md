# Task Plan: Modify AI Providers Configuration

## Goal
Remove Perplexity from the providers list and reorder providers to place Google at the end.

## Current Phase
Phase 1

## Phases

### Phase 1: Requirements & Discovery
- [x] Understand user intent: Remove Perplexity, move Google to last position
- [x] Identify affected files: modules/providers.js
- [x] Check Git workflow requirements: Create feature branch
- **Status:** complete

### Phase 2: Git Branch Setup
- [x] Create feature branch from main
- [x] Verify clean working tree
- **Status:** complete

### Phase 3: Implementation
- [x] Read current providers.js configuration
- [x] Remove Perplexity from PROVIDERS array
- [x] Reorder providers: Google moves to last position
- [x] Update default enabledProviders list
- **Status:** complete

### Phase 4: Testing & Verification
- [x] Verify providers.js syntax is valid
- [x] Confirm provider count and order
- [x] Document changes in findings.md
- [x] Fix additional files with old provider order:
  - options/options.js DEFAULT_ENABLED_PROVIDERS
  - modules/settings.js DEFAULT_SETTINGS
  - background/service-worker.js enabledProviders and providerNames
- [x] Fix multi-panel to use providerOrder from settings
- [x] Test provider order logic with test script
- **Status:** complete

### Phase 5: Delivery
- [x] Stage changes
- [x] Commit with English message following conventional commits
- [x] Provide summary to user
- **Status:** complete

## Key Questions
1. Should Perplexity-related content scripts be removed from manifest.json? (Decision: No, keep for now - only remove from provider list)
2. Is the new order correct? ChatGPT, Claude, Gemini, Grok, DeepSeek, Google (Yes)

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Only modify providers.js | User only requested provider list changes, not full cleanup |
| Keep content scripts | Removing from manifest is separate task if needed |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Previously modified file directly on main | 1 | Restored file, now using proper Git workflow |
| Skipped planning phase initially | 1 | Now following planning-with-files skill correctly |

## Notes
- Following Git workflow: feature branch → commit → review
- Using conventional commits style: `feat:` or `refactor:`
