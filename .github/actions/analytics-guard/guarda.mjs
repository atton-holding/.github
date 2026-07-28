#!/usr/bin/env node
// Guarda de analítica. Nace de CASE-427, donde attonbazar.com y
// attoncreative.com pasaron 30 días en producción sin registrar una sola
// visita, por tres causas distintas que ningún check habría atrapado.
//
// Verifica tres cosas, una por causa:
//
//   1. Si el repo inicializa PostHog, su CSP declara los hosts de PostHog.
//      Sin esto el navegador bloquea el script y no sale un solo evento, y el
//      único rastro vive en la consola del visitante. (attoncreative.com)
//
//   2. El `before_send` no pasa el evento ENTERO por un redactor de PII. El
//      sobre (`api_key`, `token`, `timestamp`, `distinct_id`) es protocolo:
//      redactarlo rompe la ingesta, a veces con un 400 y a veces con un
//      `200 Ok` que descarta el evento en silencio. (attonbazar.com, 2 de las
//      3 causas)
//
//   3. Si el repo tiene un redactor de PII, tiene tests. El archivo se declaró
//      SSOT del ecosistema, se copió a varios repos y no tenía una sola
//      prueba en ninguna copia. Ahí es donde el defecto vivió invisible.
//
// Es deliberadamente conservadora: solo falla ante evidencia clara, porque una
// guarda que da falsos positivos termina desactivada, y eso es peor que no
// tenerla. Cada fallo dice qué archivo, qué se esperaba y por qué.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const RAIZ = process.cwd()
const IGNORAR = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.vercel',
  '.turbo', 'out', '.worktrees',
])

const HOSTS_POSTHOG = ['us.i.posthog.com', 'us-assets.i.posthog.com']

/** Recorre el árbol devolviendo rutas de archivos de código. */
function archivosDeCodigo(dir, acc = []) {
  let entradas
  try {
    entradas = readdirSync(dir)
  } catch {
    return acc
  }
  for (const nombre of entradas) {
    if (IGNORAR.has(nombre)) continue
    const ruta = join(dir, nombre)
    let st
    try {
      st = statSync(ruta)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      archivosDeCodigo(ruta, acc)
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(nombre)) {
      acc.push(ruta)
    }
  }
  return acc
}

const fallos = []
const notas = []

const archivos = archivosDeCodigo(RAIZ)
const leer = (r) => {
  try {
    return readFileSync(r, 'utf8')
  } catch {
    return ''
  }
}
const contenidos = new Map(archivos.map((r) => [r, leer(r)]))
const rel = (r) => relative(RAIZ, r)

// ── 1. PostHog inicializado exige sus hosts en la CSP ────────────────────────

const inicializanPostHog = archivos.filter((r) =>
  /posthog\s*\.\s*init\s*\(/.test(contenidos.get(r)),
)

if (inicializanPostHog.length > 0) {
  // La CSP puede vivir en next.config, en un módulo propio, en el middleware o
  // en vercel.json. Se busca en todo el repo para no atarse a una convención.
  const declaranCsp = archivos.filter((r) =>
    /connect-src|Content-Security-Policy|cspDirectives/i.test(contenidos.get(r)),
  )

  const jsonCsp = ['vercel.json', 'next.config.js', 'next.config.mjs']
    .map((n) => join(RAIZ, n))
    .filter((r) => existsSync(r))
    .map((r) => [r, leer(r)])

  const textoCsp = [
    ...declaranCsp.map((r) => contenidos.get(r)),
    ...jsonCsp.map(([, t]) => t),
  ].join('\n')

  if (textoCsp.trim() === '') {
    notas.push(
      `PostHog se inicializa en ${rel(inicializanPostHog[0])} y no se encontró ninguna CSP en el repo. ` +
        `Si la CSP la pone un proxy o Cloudflare, esta guarda no puede verla: verificalo a mano.`,
    )
  } else {
    const faltantes = HOSTS_POSTHOG.filter((h) => !textoCsp.includes(h))
    if (faltantes.length > 0) {
      fallos.push(
        [
          `CSP sin los hosts de PostHog: ${faltantes.join(', ')}`,
          `  PostHog se inicializa en: ${rel(inicializanPostHog[0])}`,
          `  Pero la CSP del repo no permite ${faltantes.length === 1 ? 'ese host' : 'esos hosts'}.`,
          `  El navegador va a bloquear cada evento y el único rastro estará en`,
          `  la consola del visitante, donde nadie lo va a ver.`,
          ``,
          `  Agregá los dos hosts a 'script-src' y 'connect-src'.`,
          `  Referencia: atton-bazar/src/lib/csp.ts · CASE-427`,
        ].join('\n'),
      )
    }
  }
}

// ── 2. El before_send no toca el sobre del evento ────────────────────────────

// Se busca la forma exacta que rompió producción: pasar la variable del evento
// entera a una función de redacción. `scrub(event.properties)` está bien;
// `scrub(event)` no.
const REDACTORES = /(scrub|sanitiz|redact|clean|limpi)[A-Za-z_]*/

for (const [ruta, texto] of contenidos) {
  const m = texto.match(/before_send\s*:\s*\(?\s*([A-Za-z_$][\w$]*)/)
  if (!m) continue
  const evento = m[1]

  // Llamadas a un redactor con el evento entero como único argumento.
  const patron = new RegExp(
    `${REDACTORES.source}\\s*\\(\\s*${evento}\\s*[,)]`,
    'g',
  )
  const encontradas = texto.match(patron)
  if (encontradas) {
    fallos.push(
      [
        `before_send pasa el evento entero por un redactor: ${encontradas[0]}`,
        `  Archivo: ${rel(ruta)}`,
        `  El sobre del evento (api_key, token, timestamp, distinct_id) es`,
        `  protocolo, no datos del visitante. Redactarlo rompe la ingesta:`,
        `    - timestamp aplanado  -> 400, el evento se rechaza`,
        `    - api_key/token redactado -> 200 Ok, y el evento se DESCARTA`,
        `  El segundo caso no deja ninguna señal. Así se perdieron 30 días.`,
        ``,
        `  Redactá el contenido, no el sobre: properties, $set y $set_once.`,
        `  Referencia: atton-bazar/src/lib/observability/posthog-before-send.ts`,
      ].join('\n'),
    )
  }
}

// ── 3. Un redactor de PII sin tests no entra ─────────────────────────────────

const redactores = archivos.filter(
  (r) =>
    /scrub-pii|scrub_pii|redact-pii/i.test(r) &&
    !/\.(test|spec)\./.test(r),
)

if (redactores.length > 0) {
  const hayTests = archivos.some(
    (r) => /\.(test|spec)\./.test(r) && /scrub|redact|pii/i.test(r),
  )
  if (!hayTests) {
    fallos.push(
      [
        `Redactor de PII sin tests: ${rel(redactores[0])}`,
        `  Este archivo promete devolver una copia redactada y equivalente en`,
        `  todo lo demás. Sin un test que fije ese contrato, la diferencia`,
        `  entre redactar y DESTRUIR no se ve: en CASE-427 convertía cada Date`,
        `  en {} y nadie lo supo durante 30 días.`,
        ``,
        `  Copiá los tests de atton-bazar/tests/observability/scrub-pii.test.ts`,
      ].join('\n'),
    )
  }
}

// ── Reporte ──────────────────────────────────────────────────────────────────

for (const nota of notas) {
  console.log(`::warning::[guarda-analitica] ${nota}`)
}

if (fallos.length === 0) {
  const revisados = inicializanPostHog.length > 0 ? 'con PostHog' : 'sin PostHog'
  console.log(`[guarda-analitica] OK — repo ${revisados}, sin hallazgos.`)
  process.exit(0)
}

console.error(`\n[guarda-analitica] ${fallos.length} problema(s):\n`)
for (const f of fallos) {
  console.error(f)
  console.error('')
}
console.error(
  'Estas verificaciones existen porque cada una corresponde a una falla real\n' +
    'que estuvo 30 días en producción sin que nada la detectara (CASE-427).\n',
)
process.exit(1)
