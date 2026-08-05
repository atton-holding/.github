// Tests de la guarda de analítica. Nacen de CASE-479: la guarda de CASE-427 se
// escribió sin un solo test propio, y por eso dos defectos suyos sobrevivieron a
// una verificación manual cuidadosa. Su verificación 3 exige que todo redactor de
// PII tenga tests; el vigilante se verifica con el mismo rigor que el vigilado.
//
// Dos cosas que estos tests hacen a propósito:
//
//   1. El test del shell lee el `run:` del action.yml REAL y lo ejecuta con el
//      invocador de GitHub Actions (`bash --noprofile --norc -eo pipefail`). No
//      con una transcripción del script ni con el bash de la laptop: probar una
//      copia mide la copia, y correr en otro shell mide otro programa. El defecto
//      de CASE-479 vivía exactamente en esa diferencia.
//
//   2. Cada verificación tiene su par: un fixture que DEBE fallar y el mismo
//      fixture corregido que DEBE pasar. Una aserción sin un mutante que la mate
//      no prueba que el test proteja nada.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const AQUI = dirname(fileURLToPath(import.meta.url))
const GUARDA = join(AQUI, 'guarda.mjs')
const ACTION_YML = join(AQUI, 'action.yml')

/** Crea un repo de mentira con los archivos dados y corre la guarda adentro. */
function correrGuarda(archivos) {
  const raiz = mkdtempSync(join(tmpdir(), 'guarda-test-'))
  try {
    for (const [ruta, contenido] of Object.entries(archivos)) {
      const destino = join(raiz, ruta)
      mkdirSync(dirname(destino), { recursive: true })
      writeFileSync(destino, contenido, 'utf8')
    }
    try {
      const salida = execFileSync('node', [GUARDA], {
        cwd: raiz,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { codigo: 0, salida }
    } catch (e) {
      return { codigo: e.status, salida: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  } finally {
    rmSync(raiz, { recursive: true, force: true })
  }
}

// ── Verificación 2: el before_send no toca el sobre del evento ────────────────

const CSP_OK = `export const csp = "connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com"`

test('detecta scrub(event) cuando el before_send es una arrow inline', () => {
  const { codigo, salida } = correrGuarda({
    'src/csp.ts': CSP_OK,
    'src/analytics.ts': `
      import posthog from 'posthog-js'
      posthog.init(KEY, { before_send: (event) => scrubPii(event) })
    `,
  })
  assert.equal(codigo, 1)
  assert.match(salida, /before_send pasa el evento entero/)
})

test('deja pasar scrub(event.properties), que es la forma correcta', () => {
  const { codigo } = correrGuarda({
    'src/csp.ts': CSP_OK,
    'src/analytics.ts': `
      import posthog from 'posthog-js'
      posthog.init(KEY, {
        before_send: (event) => ({ ...event, properties: scrubPii(event.properties) }),
      })
    `,
  })
  assert.equal(codigo, 0)
})

// El mutante de CASE-479: es el patrón que el propio script cita como canónico
// (atton-bazar/src/lib/observability/posthog-before-send.ts) y el que la guarda
// original NO detectaba, porque el archivo del handler no contiene 'before_send:'.
test('MUTANTE CASE-479: detecta scrub(event) con el handler factorizado en otro archivo', () => {
  const { codigo, salida } = correrGuarda({
    'src/csp.ts': CSP_OK,
    'src/analytics.ts': `
      import posthog from 'posthog-js'
      import { manejarAntesDeEnviar } from './observability/posthog-before-send'
      posthog.init(KEY, { before_send: manejarAntesDeEnviar })
    `,
    'src/observability/posthog-before-send.ts': `
      export function manejarAntesDeEnviar(event) {
        return scrubPii(event)
      }
    `,
  })
  assert.equal(codigo, 1)
  assert.match(salida, /before_send pasa el evento entero/)
})

test('el handler factorizado correcto pasa limpio', () => {
  const { codigo } = correrGuarda({
    'src/csp.ts': CSP_OK,
    'src/analytics.ts': `
      import posthog from 'posthog-js'
      import { manejarAntesDeEnviar } from './observability/posthog-before-send'
      posthog.init(KEY, { before_send: manejarAntesDeEnviar })
    `,
    'src/observability/posthog-before-send.ts': `
      export function manejarAntesDeEnviar(event) {
        return { ...event, properties: scrubPii(event.properties) }
      }
    `,
  })
  assert.equal(codigo, 0)
})

// No-regresión: el before_send del CRM está escrito con anotación de tipo. Una
// primera versión del arreglo de CASE-479 exigía `,` o `)` pegado al nombre del
// parámetro y dejó de verlo — pasaba limpio en los cinco sitios y sólo el sexto
// repo lo delató. Un caso que sólo un repo real tenía casi se lleva la detección.
test('detecta scrub(event) con el parámetro anotado en TypeScript', () => {
  const { codigo, salida } = correrGuarda({
    'src/csp.ts': CSP_OK,
    'src/analytics.ts': `
      posthog.init(KEY, {
        before_send: (event: unknown) => {
          const scrubbed = scrubValue(event) as typeof e
          return scrubbed
        },
      })
    `,
  })
  assert.equal(codigo, 1)
  assert.match(salida, /before_send pasa el evento entero/)
})

test('detecta scrub(event) con handler factorizado declarado como const arrow', () => {
  const { codigo, salida } = correrGuarda({
    'src/csp.ts': CSP_OK,
    'src/analytics.ts': `posthog.init(KEY, { before_send: limpiarEvento })`,
    'src/limpiar.ts': `export const limpiarEvento = (event) => sanitizeEvent(event)`,
  })
  assert.equal(codigo, 1)
  assert.match(salida, /before_send pasa el evento entero/)
})

test('detecta scrub(event) con before_send: function(event)', () => {
  const { codigo, salida } = correrGuarda({
    'src/csp.ts': CSP_OK,
    'src/analytics.ts': `
      posthog.init(KEY, {
        before_send: function (event) { return redactEvent(event) },
      })
    `,
  })
  assert.equal(codigo, 1)
  assert.match(salida, /before_send pasa el evento entero/)
})

test('avisa en vez de callar cuando el handler no se puede resolver', () => {
  const { codigo, salida } = correrGuarda({
    'src/csp.ts': CSP_OK,
    'src/analytics.ts': `
      import { bs } from 'algun-paquete-externo'
      posthog.init(KEY, { before_send: bs })
    `,
  })
  assert.equal(codigo, 0, 'no puede afirmar que está mal: no lo pudo ver')
  assert.match(salida, /::warning::/)
  assert.match(salida, /no pude/i)
})

// ── Verificación 1: CSP con los hosts de PostHog ──────────────────────────────

test('detecta la CSP sin los hosts de PostHog', () => {
  const { codigo, salida } = correrGuarda({
    'src/csp.ts': `export const csp = "connect-src 'self' https://vitals.vercel-insights.com"`,
    'src/analytics.ts': `posthog.init(KEY, {})`,
  })
  assert.equal(codigo, 1)
  assert.match(salida, /CSP sin los hosts de PostHog/)
})

test('la CSP con los dos hosts pasa limpia', () => {
  const { codigo } = correrGuarda({
    'src/csp.ts': CSP_OK,
    'src/analytics.ts': `posthog.init(KEY, {})`,
  })
  assert.equal(codigo, 0)
})

test('avisa, no falla, cuando no hay ninguna CSP visible en el repo', () => {
  const { codigo, salida } = correrGuarda({
    'src/analytics.ts': `posthog.init(KEY, {})`,
  })
  assert.equal(codigo, 0)
  assert.match(salida, /::warning::/)
})

// ── Verificación 3: el redactor de PII tiene tests ────────────────────────────

test('detecta el redactor de PII sin tests', () => {
  const { codigo, salida } = correrGuarda({
    'src/lib/scrub-pii.ts': `export function scrubPii(v) { return v }`,
  })
  assert.equal(codigo, 1)
  assert.match(salida, /Redactor de PII sin tests/)
})

test('el redactor de PII con tests pasa limpio', () => {
  const { codigo } = correrGuarda({
    'src/lib/scrub-pii.ts': `export function scrubPii(v) { return v }`,
    'tests/scrub-pii.test.ts': `test('redacta', () => {})`,
  })
  assert.equal(codigo, 0)
})

// ── El paso de Actions, con el invocador de Actions ───────────────────────────

/**
 * Extrae el script del `run: |` del action.yml REAL. Si el test transcribiera el
 * script, mediría la transcripción: el archivo podría cambiar y el test seguiría
 * verde sobre una copia que ya nadie ejecuta.
 */
function scriptDelPaso() {
  const yml = readFileSync(ACTION_YML, 'utf8').split('\n')
  const inicio = yml.findIndex((l) => /^\s*run:\s*\|\s*$/.test(l))
  assert.notEqual(inicio, -1, 'el action.yml debe tener un bloque `run: |`')
  const sangria = yml[inicio + 1].match(/^\s*/)[0].length
  const cuerpo = []
  for (const linea of yml.slice(inicio + 1)) {
    if (linea.trim() !== '' && linea.match(/^\s*/)[0].length < sangria) break
    cuerpo.push(linea.slice(sangria))
  }
  return cuerpo.join('\n')
}

/**
 * Corre ese script como lo corre GitHub Actions. `shell: bash` NO es el bash de
 * tu terminal: Actions lo invoca con `bash --noprofile --norc -eo pipefail {0}`,
 * o sea con errexit YA activo. Ese `-e` es todo el defecto de CASE-479.
 */
function correrPaso({ modo, salidaDeLaGuarda }) {
  const dir = mkdtempSync(join(tmpdir(), 'paso-test-'))
  try {
    const guardaFalsa = join(dir, 'guarda-falsa.mjs')
    writeFileSync(guardaFalsa, `process.exit(${salidaDeLaGuarda})\n`, 'utf8')
    const script = join(dir, 'paso.sh')
    writeFileSync(script, scriptDelPaso(), 'utf8')
    const env = {
      ...process.env,
      ATTON_GUARDA_MODO: modo,
      ATTON_GUARDA_SCRIPT: guardaFalsa,
    }
    try {
      const salida = execFileSync(
        'bash',
        ['--noprofile', '--norc', '-eo', 'pipefail', script],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
      return { codigo: 0, salida }
    } catch (e) {
      return { codigo: e.status, salida: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('el action.yml declara shell: bash (si cambia, el invocador de este test miente)', () => {
  assert.match(readFileSync(ACTION_YML, 'utf8'), /^\s*shell:\s*bash\s*$/m)
})

// El mutante de CASE-479: bajo el invocador real, el `-e` heredado abortaba el
// paso en la línea del `node` y la rama de warn nunca llegaba a ejecutarse.
test('MUTANTE CASE-479: con hallazgos y modo warn, el paso sale 0 y avisa', () => {
  const { codigo, salida } = correrPaso({ modo: 'warn', salidaDeLaGuarda: 1 })
  assert.equal(codigo, 0, 'en modo warn los hallazgos no frenan el CI')
  assert.match(salida, /::warning::/)
})

test('con hallazgos y modo block, el paso falla', () => {
  const { codigo } = correrPaso({ modo: 'block', salidaDeLaGuarda: 1 })
  assert.equal(codigo, 1)
})

test('sin hallazgos el paso pasa, en cualquier modo', () => {
  assert.equal(correrPaso({ modo: 'block', salidaDeLaGuarda: 0 }).codigo, 0)
  assert.equal(correrPaso({ modo: 'warn', salidaDeLaGuarda: 0 }).codigo, 0)
})

test('un modo desconocido se comporta como block, no como warn', () => {
  const { codigo } = correrPaso({ modo: 'bloque', salidaDeLaGuarda: 1 })
  assert.equal(codigo, 1, 'ante un modo mal escrito, frenar es el lado seguro')
})
