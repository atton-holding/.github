# CLAUDE.md — .github (org atton-holding)

> **Repo:** `atton-holding/.github` | **Updated:** 2026-07-07

Repo especial del org: perfil público (`profile/`) + **workflows reutilizables** org-level.

## ai-security-review.yml (reusable workflow)

- Corre **Claude** security review (+ Gemini dataflow opt-in) en cada PR de los repos consumidores. El reviewer **Kimi fue eliminado** (TASK-0525, 2026-07 — cuenta Moonshot cerrada, sin BAA); no reintroducir su job ni el secret `ATTON_CI_GITHUB_ACTIONS_KIMI_PROD`.
- Secrets declarados en `workflow_call`: `ATTON_CI_GITHUB_ACTIONS_CLAUDE_PROD` + `ATTON_CI_GITHUB_ACTIONS_GEMINI_PROD` (org-level).
- **Los consumidores pinean por SHA de commit** (no `@main`) y pasan secrets EXPLÍCITOS (no `secrets: inherit`). Al cambiar este workflow: mergear aquí → actualizar el pin en cada repo consumidor (crm, bazar, finance, hub, attoncito, creative, group, tech).

## denylist-packages.txt + job `abandoned-package-denylist` (TASK-0540 · CASE-280 Capa 2)

- Denylist org-wide de paquetes npm abandonados. El job (en `ai-security-review.yml`) falla el PR de un repo consumidor si una línea AGREGADA introduce un paquete de la lista en `package.json` o lockfiles (diff-only: uso histórico existente no falla). Escape documentado: línea `denylist-ok: <razón>` en el body del PR.
- Para denylistar un paquete: PR a este repo editando `denylist-packages.txt` (una línea por paquete + comentario del porqué/CASE). La lista se lee de `main` en runtime: agregar entradas NO requiere bump de pin en consumidores; cambiar el JOB sí.
- Primer entry: `gray-matter` (DoS vía js-yaml, mitigado en command-center, CASE-280).
