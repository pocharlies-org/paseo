# SC-5508 — evidencia: canal propio publicable

Rama `sc-5508-own-publish` (base `real/main` = pocharlies-org/paseo main 9a53b7d9d). Medido el 2026-11-22.

## 1. Prueba rojo → verde: tarball propio en un prefix aislado sin registro

Test: `scripts/own-cli-tarball.test.mjs` (`npm install -g --offline` de los `.tgz` en un prefix temporal;
`--offline` impide cualquier consulta al registro; después comprueba que no hay `@getpaseo/*` en el árbol
instalado y que `local-daemon.js` instalado resuelve `DISTRIBUTION.npmServerPackage` = `@pocharlies/server`
dentro del prefix). Falla (no se salta) si faltan los tarballs.

Se ejecutó en un worktree desechable (`/tmp/sc5508-pack`, `npm ci` limpio) para no ensuciar el de trabajo,
con el mismo test en las dos variantes de empaquetado:

**ROJO** — empaquetado previo al fix (`set-distribution.mjs --own` sin `--rewrite-packages`, `npm pack` plano
de `packages/cli` y `packages/server`): exit 1.

```
npm install -g --offline --ignore-scripts --no-audit --no-fund --prefix /tmp/paseo-own-prefix-o1WkUu getpaseo-cli-0.12.0-beta.2.tgz getpaseo-server-0.12.0-beta.2.tgz
npm error code ENOTCACHED
npm error request to https://registry.npmjs.org/@getpaseo/relay/-/relay-0.12.0-beta.2.tgz failed: cache mode is 'only-if-cached' but no cached response is available.
 Tests  1 failed (1)
```

El tarball plano sigue declarando `@getpaseo/*`: sin `--offline` instalaría el server oficial.

**VERDE** — flujo propio de la rama (el de `.github/workflows/own-release.yml`):

```
node scripts/set-distribution.mjs --own --npm-cli-package @pocharlies/cli --npm-server-package @pocharlies/server --rewrite-packages
  -> Distribution set to own: github pocharlies-org/paseo, npm @pocharlies/cli@latest, 775 package files rewritten
npm install --no-audit --no-fund            # relink de workspaces, contra el lockfile
npm run build:server                        # exit 0
node scripts/pack-own-release.mjs --out dist/own
  -> pocharlies-cli-0.12.0-beta.2.tgz (43 MB, 239 deps bundled), pocharlies-server-0.12.0-beta.2.tgz (43 MB)
PASEO_OWN_CLI_TGZ=… PASEO_OWN_SERVER_TGZ=… npx vitest run scripts/own-cli-tarball.test.mjs --bail=1
  Test Files  1 passed (1) · Tests  1 passed (1) · Duration 51.80s
```

Nota: la primera ejecución verde falló con `Test timed out in 5000ms` (el cuerpo es síncrono, la instalación
tarda ~50 s y vitest marca el timeout al volver). Corregido con timeout explícito de 300 s en el propio test.
`build:daemon-web-ui` no se ejecutó en local (el empaquetado no lo usa); el workflow sí lo ejecuta.

## 2. Tests focalizados (árbol oficial)

```
npx vitest run scripts/set-distribution.test.mjs scripts/pack-own-release.test.mjs \
  packages/protocol/src/distribution.test.ts \
  packages/server/src/server/session/daemon/npm-global-cli.test.ts \
  packages/app/src/plugins/buttons/model.test.ts --bail=1
 Test Files  5 passed (5)
      Tests  48 passed (48)
```

`model.test.ts` no se amplía: C1 (`replaces`, aislamiento por agente/workspace/host, positivo/negativo) ya está
cubierto desde #8 (`composer pill task replacement`, 3 tests) y su suite pasa sin cambios.

## 3. Calidad

- `npm run typecheck` (hook de pre-commit, todos los workspaces): verde. Antes hubo que reconstruir
  `packages/plugin/dist` y `packages/protocol/dist` locales, que estaban obsoletos tras un empaquetado propio
  anterior (errores TS7031/TS2741 ajenos a la rama; desaparecieron con `npm run build:plugin` y `build:client`).
- `npm run lint`: `Found 0 warnings and 0 errors` (4708 ficheros). `format:check` de los ficheros del commit: verde.
- `~/.local/libexec/x86-host-runtime/company-duplicados --base real/main --head HEAD`: `Sin duplicación nueva.`
- Barrido de código muerto tras el commit: `npm run knip` revienta en el plugin de expo de knip
  (`specifier.charCodeAt is not a function`, ajeno a la rama; knip no está en el CI). Barrido manual con `rg` de cada
  export nuevo: `ownCliTarballAssetName`, `defaultFetchJson` y `defaultDownloadFile` solo se usaban dentro de
  `npm-global-cli.ts` y dejan de exportarse; el resto tiene consumidor o test. `inspectLatestRelease` no tiene
  llamador de producción hoy: se conserva porque es el descubrimiento de versión por metadato que pide C2 y lo
  cubre un test con fixture `upstream: X.Y.Z`.

## 4. Por criterio de `00-spec.md`

- C1 (`replaces` Tasks → Plan): ya fusionado en #8; sin cambios aquí, suite verde.
- C2 (identidad al build, coherente entre descubrimiento, inspección y descarga): `DISTRIBUTION` única fuente,
  sin editar; `distribution.test.ts` (build propio nunca resuelve el feed oficial) y `npm-global-cli.test.ts`
  (instalación y descubrimiento desde la release propia, nunca el registro; el canal oficial no toca la API de releases).
- C3 (canal propio empaquetado, tests de metadata y canales): `set-distribution.test.mjs`, `pack-own-release.test.mjs`
  y el test del tarball de la sección 1. El feed Electron firmado no se toca (default oficial, reescrito en empaquetado).
- C4 (focalizadas, lint, tipos, barrido): secciones 2 y 3.
- C5 (release publicada + upgrade real): fuera de esta PR, bloqueada por el material de firma de SC-5871.
