#!/usr/bin/env node
// Atton AI Multi-LLM Review — aggregator.
//
// Reads provider findings JSON files from the artifacts directory:
//   <artifacts_dir>/findings-kimi/findings-kimi.json
//   <artifacts_dir>/findings-claude/findings-claude.json
//   <artifacts_dir>/findings-gemini/findings-gemini.json
//
// Writes a single Markdown comment body (argv[2]) suitable for `gh pr comment`.
//
// Consensus rule:
//   A finding is "high confidence" if 2+ providers report a finding on the
//   same file, with line numbers within +/- 5 of each other.
//
// Fault tolerance:
//   If a provider artifact is missing or contains an error, the aggregator
//   still produces a comment with the providers that did succeed.

import fs from "node:fs";
import path from "node:path";

const PROVIDERS = ["kimi", "claude", "gemini"];
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const SEVERITY_EMOJI = {
  critical: "[CRITICAL]",
  high: "[HIGH]",
  medium: "[MED]",
  low: "[LOW]",
};
const PROVIDER_TITLE = {
  kimi: "Kimi - Security & anti-phishing",
  claude: "Claude - Logic & correctness",
  gemini: "Gemini - Data flow & supply chain",
};

const artifactsDir = process.argv[2] || "artifacts";
const outPath = process.argv[3] || "comment.md";

function tryReadFindings(provider) {
  // download-artifact@v4 puts each artifact in its own subdir.
  const candidates = [
    path.join(artifactsDir, `findings-${provider}`, `findings-${provider}.json`),
    path.join(artifactsDir, `findings-${provider}.json`),
  ];
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      return { path: p, data: JSON.parse(raw) };
    } catch {
      /* try next */
    }
  }
  return null;
}

function clip(s, n) {
  if (!s) return "";
  s = String(s).replace(/\r/g, "");
  return s.length > n ? s.slice(0, n - 1) + "..." : s;
}

function escapeMd(s) {
  if (!s) return "";
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function normalize(provider, data) {
  const findings = Array.isArray(data?.findings) ? data.findings : [];
  return findings
    .filter((f) => f && (f.file || f.title))
    .map((f) => ({
      provider,
      file: String(f.file || "").trim(),
      line: Number.isFinite(+f.line) ? +f.line : 0,
      severity: (String(f.severity || "low").toLowerCase()),
      category: String(f.category || "").trim(),
      title: clip(f.title || "", 200),
      detail: clip(f.detail || "", 800),
      suggestion: clip(f.suggestion || "", 500),
    }));
}

function consensusKey(f) {
  // Bucket lines into windows of 10 to allow +/-5 line jitter between models.
  const bucket = Math.floor((f.line || 0) / 10);
  return `${f.file}::${bucket}`;
}

function buildConsensus(allFindings) {
  const byKey = new Map();
  for (const f of allFindings) {
    const k = consensusKey(f);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(f);
  }
  const consensus = [];
  for (const [, group] of byKey) {
    const providers = new Set(group.map((g) => g.provider));
    if (providers.size >= 2) {
      // Pick the highest severity item as the representative.
      group.sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));
      const rep = group[0];
      consensus.push({
        file: rep.file,
        line: rep.line,
        severity: rep.severity,
        title: rep.title,
        providers: [...providers].sort(),
        items: group,
      });
    }
  }
  consensus.sort(
    (a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0),
  );
  return consensus;
}

function providerSection(provider, payload) {
  const title = PROVIDER_TITLE[provider] || provider;
  if (!payload) {
    return `### ${title}\n_No artifact found. The job may not have run, or it timed out before producing output._\n`;
  }
  const data = payload.data;
  if (data?.skipped) {
    return `### ${title}\n_Skipped: ${escapeMd(data.reason || "no api key")}_\n`;
  }
  if (data?.error) {
    return `### ${title}\nProvider error: \`${escapeMd(clip(data.error, 200))}\`\n`;
  }
  const findings = normalize(provider, data);
  if (findings.length === 0) {
    const note = data?.parseError ? ` _(parse note: ${escapeMd(clip(data.parseError, 80))})_` : "";
    return `### ${title}\nNo findings.${note}\n`;
  }
  findings.sort(
    (a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0),
  );
  const rows = findings
    .slice(0, 25)
    .map(
      (f) =>
        `| ${SEVERITY_EMOJI[f.severity] || "[?]"} ${f.severity} | \`${escapeMd(f.file)}:${f.line || "?"}\` | ${escapeMd(f.title)} |`,
    )
    .join("\n");
  return `### ${title}\nModel: \`${escapeMd(data?.model || "?")}\` - ${findings.length} finding(s)\n\n| Severity | Location | Finding |\n|---|---|---|\n${rows}\n`;
}

function consensusSection(consensus) {
  if (consensus.length === 0) {
    return `### Consensus (2+ providers agree)\n_No consensus findings. The reviewers did not converge on the same file:line._\n`;
  }
  const rows = consensus
    .slice(0, 15)
    .map(
      (c) =>
        `| ${SEVERITY_EMOJI[c.severity] || "[?]"} ${c.severity} | \`${escapeMd(c.file)}:${c.line || "?"}\` | ${escapeMd(c.title)} | ${c.providers.join(", ")} |`,
    )
    .join("\n");
  return `### Consensus (2+ providers agree) - ${consensus.length}\n\n| Severity | Location | Finding | Reported by |\n|---|---|---|---|\n${rows}\n`;
}

function main() {
  const payloads = {};
  const allFindings = [];
  for (const p of PROVIDERS) {
    const r = tryReadFindings(p);
    payloads[p] = r;
    if (r?.data) allFindings.push(...normalize(p, r.data));
  }

  const consensus = buildConsensus(allFindings);

  const ok = PROVIDERS.filter((p) => payloads[p]?.data && !payloads[p].data.error && !payloads[p].data.skipped).length;
  const skipped = PROVIDERS.filter((p) => payloads[p]?.data?.skipped).length;
  const errored = PROVIDERS.filter((p) => payloads[p]?.data?.error).length;
  const missing = PROVIDERS.filter((p) => !payloads[p]).length;

  const header = `<!-- atton-ai-review:v1 -->
## Atton AI Multi-LLM Review

3 independent reviewers (Kimi, Claude, Gemini) inspected this PR's diff in parallel.

**Status:** ${ok} succeeded - ${skipped} skipped - ${errored} errored - ${missing} missing
**Total raw findings:** ${allFindings.length}
**Consensus findings (2+ providers):** ${consensus.length}

> Heuristic-based — treat findings as advisory. A human reviewer (Rodrigo) still merges.
`;

  const body = [
    header,
    consensusSection(consensus),
    "---",
    providerSection("kimi", payloads.kimi),
    providerSection("claude", payloads.claude),
    providerSection("gemini", payloads.gemini),
    "<details><summary>How this works</summary>\n\nEach provider reviews the diff independently with a different focus prompt: Kimi covers security and anti-phishing, Claude covers logic and correctness, Gemini covers data flow and supply chain. A finding is promoted to **Consensus** when 2+ providers report it on the same file with line numbers within ~10 lines of each other. Reusable workflow lives at `atton-holding/.github/.github/workflows/ai-security-review.yml`.\n</details>",
  ].join("\n\n");

  fs.writeFileSync(outPath, body);
  console.log(`Wrote ${outPath} (${body.length} bytes)`);
}

main();
