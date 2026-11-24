# ARCHITECTURE.md — paseo (fork pocharlies-org/paseo)

Fork de getpaseo/paseo con canal de distribución propio. Tronco: main (fork);
upstream: origin getpaseo/paseo, integrado por el trabajo de compañía que abre
update-watch (SC-5509), nunca a ciegas.

## Clientes

- packages/app — Expo (React Native): iOS, Android, web y renderer de Electron.
  Botón de actualización y pills de Plan/Tareas.
- packages/desktop — wrapper Electron (Mac): electron-builder/electron-updater;
  único cliente con auto-actualización por botón.
- packages/cli + packages/server — daemon/CLI Node por npm; en la compañía corre
  en el pod paseo-0 (ns paseo, nodo atlantic), actualizado por
  k8s-paseo-pocharlies/k8s/cron-loop.yaml.

## Dependencias

- Consume: API de releases de GitHub (feed), npm (instalación CLI).
- Consumido por: dgx-infra update-watch (entrada paseo de ci/update-watch.yaml,
  compara upstream contra la release propia publicada) y k8s-paseo-pocharlies.

## Componentes canónicos

- Canal propio: packages/protocol/src/distribution.ts (DISTRIBUTION, única fuente;
  consumidores: desktop-updates, install-origin, npm-global-cli).
- Reescritura de empaquetado: scripts/set-distribution.mjs (--own fail-closed sin
  paquetes npm propios; en --own renombra CLI/server/client/protocol al scope propio
  y los marca bundleDependencies para que el tarball del CLI sea autocontenido y
  npm install -g no resuelva contra el registro público).
- Sustitución de Tareas: campo replaces en
  packages/app/src/plugins/buttons/model.ts (referencia:
  public-docs/plugins/reference.md).

## Reglas

- electron-builder.yml y DISTRIBUTION commiteados son los defaults oficiales:
  nunca editarlos a mano para el canal propio; la reescritura ocurre en empaquetado.
- El daemon resuelve el server por DISTRIBUTION.npmServerPackage (local-daemon.ts),
  nunca por el literal "@getpaseo/server".
- Nunca desactivar firma, notarización ni verificaciones para publicar.
- CI del fork: .github/workflows/own-distribution-ci.yml (runner arc-k8s); los
  jobs de release de upstream permanecen desactivados (INFRA-1218).

## Pruebas

- npm run typecheck y npm run lint; vitest focalizado:
  scripts/set-distribution.test.mjs, packages/protocol/src/distribution.test.ts,
  packages/app/src/plugins/buttons/model.test.ts.
- Tarball autocontenido: npm install -g <own-cli.tgz> en un prefix aislado sin
  acceso al registro; el daemon resuelve el server propio, no @getpaseo/server.
