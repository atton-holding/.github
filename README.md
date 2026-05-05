# .github

Atton Finance Group - Org-level profile and shared CI assets. Empoderando a la comunidad latina y LGBT a construir patrimonio y legado.

This repo hosts shared GitHub assets for every Atton repo:

- `profile/README.md` - org profile shown on github.com/atton-holding
- `.github/workflows/` - reusable workflows (`workflow_call`)
- `.github/actions/` - composite actions

---

## AI Multi-LLM Review Pipeline

Reusable workflow that runs two independent automated reviews on every pull request — one with Kimi (security and anti-phishing) and one with Claude (logic and correctness) — then posts a single consolidated comment with a consensus block on the PR. A Gemini reviewer (data flow and supply chain focus) is wired into the workflow but disabled by default; opt-in via the `models` input once the Gemini secret is provisioned in Sprint 2.

### Architecture

```
PR opened
   |
   +-- kimi-review     (security focus)    --+
   +-- claude-review   (logic focus)       --+--> aggregate --> 1 PR comment
   +-- gemini-review   (data-flow focus)   --+   (opt-in, Sprint 2)
```

Each review job is `continue-on-error: true`, so one provider failing never blocks the others. The aggregator runs `if: always()` and posts a comment with whatever findings it can collect.

### Adoption (one consuming repo)

In any Atton repo (e.g. `atton-finance-landing`, `atton-hub`, `atton-tech`, `atton-finance-v2`) add:

```yaml
# .github/workflows/security-review.yml
name: AI Security Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  ai-review:
    uses: atton-holding/.github/.github/workflows/ai-security-review.yml@main
    secrets: inherit
```

That is the entire integration. `secrets: inherit` forwards the org-level keys; the reusable workflow handles diff extraction, provider calls, and PR commenting.

### Required secrets (org level)

Add the following at https://github.com/organizations/atton-holding/settings/secrets/actions and grant them to all repos that adopt the workflow.

**Required (default `models = ''` runs Kimi + Claude):**

| Secret name | Naming in provider portal | Suggested cap |
|-------------|---------------------------|---------------|
| `ATTON_CI_GITHUB_ACTIONS_KIMI_PROD`   | `atton-ci-github-actions-kimi-prod`   | $50 / mo |
| `ATTON_CI_GITHUB_ACTIONS_CLAUDE_PROD` | `atton-ci-github-actions-claude-prod` | $20 / mo |

**Optional (Sprint 2 — opt-in via `models: 'kimi,claude,gemini'`):**

| Secret name | Naming in provider portal | Suggested cap |
|-------------|---------------------------|---------------|
| `ATTON_CI_GITHUB_ACTIONS_GEMINI_PROD` | `atton-ci-github-actions-gemini-prod` | $30 / mo |

If a key is missing, that provider's job emits an empty findings file with `"skipped": true` and the aggregator continues with the remaining providers.

### Workflow inputs (advanced)

| Input            | Default     | Description                                                                |
|------------------|-------------|----------------------------------------------------------------------------|
| `pr_number`      | _triggering PR_ | Override which PR to review.                                          |
| `models`         | _empty (= kimi+claude)_ | Comma-separated providers. Empty = `kimi,claude`. Add `gemini` once its secret is provisioned. |
| `diff_max_bytes` | `100000`    | Hard cap on the unified diff size (truncated past this for token budget). |
| `base_ref`       | _PR base_   | Override the base branch for the diff.                                    |

### Output format

Each provider job writes `findings-<provider>.json` and uploads it as an artifact. Example schema:

```json
{
  "provider": "kimi",
  "focus": "security",
  "model": "moonshot-v1-32k",
  "pr_number": "42",
  "findings": [
    {
      "file": "src/lib/api.ts",
      "line": 87,
      "severity": "high",
      "category": "command-injection",
      "title": "Unsanitized input flows into a shell-style spawn call",
      "detail": "...",
      "suggestion": "..."
    }
  ]
}
```

The aggregator promotes a finding to **Consensus** when 2+ providers report it on the same file with line numbers within ~10 lines of each other.

### Cost projection

At ~30 PRs / month with diffs averaging 30 KB:

- **Default (Kimi + Claude)**: ~**$0.13 / month** combined.
- **With Gemini opted-in**: ~**$0.20 / month** combined.

Both sit comfortably under the suggested combined caps.

### Files

```
.github/
  workflows/
    ai-security-review.yml         # reusable workflow (workflow_call)
  actions/
    llm-review/
      action.yml                   # composite action (1 provider per invocation)
      run.mjs                      # node 20 runner: calls provider, emits JSON
    aggregate-reviews/
      action.yml                   # composite action: posts the single PR comment
      aggregate.mjs                # node 20 aggregator: consensus + Markdown body
```
