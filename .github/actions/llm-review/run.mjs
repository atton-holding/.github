#!/usr/bin/env node
// Atton AI Multi-LLM Review — single-provider runner.
//
// Reads:
//   - /tmp/pr.diff           (truncated diff produced by composite action)
//   - /tmp/pr.files          (name-status list)
//   - env.PROVIDER           (kimi | claude | gemini)
//   - env.FOCUS              (security | logic | dataflow)
//   - env.ATTON_LLM_API_KEY  (provider API key)
//   - env.PR_NUMBER          (informational, included in prompt)
//
// Writes:
//   - argv[2] (default findings-<provider>.json) with shape:
//       { provider, focus, model, pr_number, raw, findings: [
//           { file, line, severity: "low"|"medium"|"high"|"critical",
//             category, title, detail, suggestion } ] }
//
// Design notes:
//   - No npm install. Uses native fetch (Node 20). For Anthropic/Gemini we
//     hit the HTTPS endpoints directly to avoid SDK install latency in CI.
//   - Fault-tolerant: any provider error is caught and written as a findings
//     file with `error` set so the aggregator can show that the review failed
//     without breaking the run.
//   - API key is read from env, never logged.

import fs from "node:fs";

const PROVIDER = process.env.PROVIDER || "";
const FOCUS = process.env.FOCUS || "security";
const API_KEY = process.env.ATTON_LLM_API_KEY || "";
const PR_NUMBER = process.env.PR_NUMBER || "";
const OUT = process.argv[2] || `findings-${PROVIDER}.json`;

const DIFF_PATH = "/tmp/pr.diff";
const FILES_PATH = "/tmp/pr.files";

const FOCUS_PROMPTS = {
  security: `You are a senior fintech security reviewer auditing a pull request.
Concentrate on:
- Security vulnerabilities (CWE-78 command injection, CWE-79 XSS, prototype pollution, hardcoded secrets, weak crypto, SSRF)
- Anti-phishing patterns (suspicious URLs, urgency wording, credential requests, spoofed brand text in user-facing copy)
- Suspicious code (obfuscation, eval-style patterns, network exfiltration, unexpected outbound calls)`,
  logic: `You are a senior staff engineer reviewing a pull request for correctness.
Concentrate on:
- Logic bugs and off-by-one errors
- Race conditions / concurrency hazards
- Edge cases (empty/null/undefined, boundary inputs)
- Type safety holes (any-casts, unsafe assertions, missing exhaustiveness)
- Business-logic correctness vs. the apparent intent of the diff`,
  dataflow: `You are a senior privacy and supply-chain reviewer auditing a pull request.
Concentrate on:
- Data flow: where untrusted input enters and where it lands (sinks)
- Dependency risks (new packages, version bumps, install scripts, transitive risk)
- Supply-chain concerns (typosquatting, unmaintained packages, deprecated APIs)
- Privacy / PII leakage (logging, telemetry, third-party calls, broken redaction)`,
};

const SYSTEM = (focus) => `${FOCUS_PROMPTS[focus] || FOCUS_PROMPTS.security}

Output STRICT JSON (no prose, no markdown fencing) matching this schema:

{
  "findings": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "low" | "medium" | "high" | "critical",
      "category": "short-kebab-tag",
      "title": "One-line summary",
      "detail": "Why this is a problem in this PR",
      "suggestion": "Concrete fix"
    }
  ]
}

Rules:
- Only include findings clearly visible in the diff.
- If you find nothing, return {"findings": []}.
- Never invent file paths or line numbers — use only what appears in the diff hunks.
- Keep title <= 80 chars, detail <= 500 chars, suggestion <= 300 chars.`;

const USER = (diff, files) => `PR #${PR_NUMBER}

Files changed:
${files.slice(0, 8000)}

Unified diff (may be truncated):
\`\`\`diff
${diff}
\`\`\`

Return STRICT JSON only.`;

function readSafe(path) {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function writeOut(obj) {
  fs.writeFileSync(OUT, JSON.stringify(obj, null, 2));
  console.log(`Wrote ${OUT}`);
}

function parseFindings(raw) {
  if (!raw || typeof raw !== "string") return { findings: [], parseError: "empty" };

  // Strip code fences if any.
  let body = raw.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1].trim();

  // Attempt direct parse.
  try {
    const obj = JSON.parse(body);
    if (Array.isArray(obj.findings)) return { findings: obj.findings.slice(0, 50) };
    if (Array.isArray(obj)) return { findings: obj.slice(0, 50) };
    return { findings: [], parseError: "no findings array" };
  } catch (e) {
    // Try to recover: find the first `{` and last `}`.
    const first = body.indexOf("{");
    const last = body.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        const obj = JSON.parse(body.slice(first, last + 1));
        if (Array.isArray(obj.findings)) return { findings: obj.findings.slice(0, 50) };
      } catch {
        /* fall through */
      }
    }
    return { findings: [], parseError: String(e && e.message ? e.message : e) };
  }
}

async function callKimi(systemPrompt, userPrompt) {
  const res = await fetch("https://api.moonshot.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: "moonshot-v1-32k",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 4096,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Kimi ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return {
    model: "moonshot-v1-32k",
    raw: data?.choices?.[0]?.message?.content || "",
  };
}

async function callClaude(systemPrompt, userPrompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { model: "claude-haiku-4-5-20251001", raw: text };
}

async function callGemini(systemPrompt, userPrompt) {
  const model = "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n");
  return { model, raw: text };
}

async function main() {
  const diff = readSafe(DIFF_PATH);
  const files = readSafe(FILES_PATH);

  const base = {
    provider: PROVIDER,
    focus: FOCUS,
    pr_number: PR_NUMBER,
    findings: [],
  };

  if (!diff.trim()) {
    writeOut({
      ...base,
      empty: true,
      reason: "empty diff",
    });
    return;
  }

  const systemPrompt = SYSTEM(FOCUS);
  const userPrompt = USER(diff, files);

  try {
    let result;
    if (PROVIDER === "kimi") result = await callKimi(systemPrompt, userPrompt);
    else if (PROVIDER === "claude") result = await callClaude(systemPrompt, userPrompt);
    else if (PROVIDER === "gemini") result = await callGemini(systemPrompt, userPrompt);
    else throw new Error(`Unknown provider ${PROVIDER}`);

    const parsed = parseFindings(result.raw);
    writeOut({
      ...base,
      model: result.model,
      raw: result.raw.slice(0, 12_000),
      parseError: parsed.parseError || null,
      findings: parsed.findings,
    });
  } catch (err) {
    // Fault tolerant — write an error finding so the aggregator can surface it.
    const msg = String((err && err.message) || err);
    console.error(`[${PROVIDER}] error:`, msg);
    writeOut({
      ...base,
      error: msg,
      findings: [],
    });
    // Do NOT throw — exit 0 so the workflow continues.
  }
}

main().catch((e) => {
  console.error("fatal", e);
  // Even fatal: write something so the aggregator artifact exists.
  writeOut({
    provider: PROVIDER,
    focus: FOCUS,
    pr_number: PR_NUMBER,
    error: String((e && e.message) || e),
    findings: [],
  });
});
