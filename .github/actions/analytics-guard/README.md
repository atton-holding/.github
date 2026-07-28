# analytics-guard

Verifica que la analítica del repo **pueda medir**, no que compile.

## Por qué existe

El 28 de julio de 2026, `attonbazar.com` y `attoncreative.com` llevaban **30 días en producción sin registrar una sola visita**. Los descubrió una alerta de ausencia de datos, no una persona: un sitio que no mide se ve idéntico a un sitio sin visitas.

Fueron tres causas distintas, todas de código propio, y ninguna habría sido detectada por lint, tipos, tests o build. Esta acción verifica exactamente esas tres.

| Verificación | La falla que previene |
|---|---|
| PostHog inicializado exige sus hosts en la CSP | El navegador bloqueaba el script entero. Cero eventos, y el único rastro en la consola del visitante |
| `before_send` no pasa el evento entero por un redactor | El sobre (`api_key`, `token`, `timestamp`) es protocolo. Redactarlo daba `400`, o peor: `200 Ok` con el evento descartado en silencio |
| Un redactor de PII tiene tests | El redactor convertía cada `Date` en `{}`. Se declaró SSOT y se copió a varios repos sin una sola prueba |

## Uso

```yaml
- name: Guarda de analítica
  uses: atton-holding/.github/.github/actions/analytics-guard@main
```

En un repo con deuda pendiente, para engancharla sin frenar el CI:

```yaml
- name: Guarda de analítica
  uses: atton-holding/.github/.github/actions/analytics-guard@main
  with:
    modo: warn
```

`warn` es transitorio por definición: la REGLA #2 obliga a documentar el plazo para volver a `block`.

## Diseño

**Conservadora a propósito.** Solo falla ante evidencia clara. Una guarda con falsos positivos termina desactivada, y una guarda desactivada es peor que ninguna porque da la sensación de estar cubierto.

Cuando no puede ver la CSP (la pone un proxy o Cloudflare) emite un *warning*, no un error: dice que no pudo verificar en vez de afirmar que está mal.

**Verificada contra el caso real.** Corrida sobre los commits anteriores a los arreglos, detecta:

- `atton-creative` en `8909a3d` → la CSP sin los hosts
- `atton-bazar` en `4d5966a` → el `scrubValue(event)` y el redactor sin tests

Sobre los cinco sitios ya arreglados pasa limpia. Que no dé falsos positivos y que sí detecte los casos reales son dos propiedades distintas, y las dos están medidas.

## Referencia

CASE-427 · `aduana/velocity-method-cases/`
