# Changelog

## Unreleased

### Breaking Changes

* The judge no longer picks models. `selectModel`, `modelBudget`, `modelPick` and `providerWeights` are removed; map difficulties to models with `modelTiers` instead. Stored values of removed settings are ignored with a warning once per session.
* `judgeEffort` no longer writes the task's `effort`, which overrode every configured level. It moves the spawn's thinking level one supported step down for routine work or up for demanding work, from the level the agent would use, never to `off` and never past `task.maxEffort`.

### Features

* `modelTiers` runs routine or demanding work, for every agent or one agent, on a model role or model you choose; standard work and any tier that cannot apply keep the agent's own model.
* A task dispatched again under the same name after its child answered `ESCALATE: deep-high`, or failed on a route the plugin lowered, keeps the requested agent and is raised to demanding, or one difficulty higher.
* The judge reads each item's `solutionSpace` and is asked for a difficulty only when the answer can change the spawn.

### Bug Fixes

* Recognize both live task-agent roster formats without treating unknown policy as an empty list.
* Preserve workflow-owned reviewer roles, approved Prometheus execution routes, and read-only agent capabilities when judging task calls.

## [0.7.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/judge-dispatch@0.7.0...judge-dispatch@0.7.1) (2026-10-14)


### Bug Fixes

* raise supported OMP floor to 18.10.4 ([9bdda2e](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/9bdda2ea3a1c547f8cd3447439819654ba448182))

## [0.7.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/judge-dispatch@0.6.1...judge-dispatch@0.7.0) (2026-10-11)


### Features

* **judge-dispatch:** pin one task's model role or model by writing its agent as `<agent>@<role>` or `<agent>@<provider>/<model>`; the pin skips judge model selection, keeps agent and effort routing, and refuses the call instead of falling back to the agent's own model ([ee64dc8](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/ee64dc83d05d292c111670cf940aa6c6e2b1025b), [c357bd8](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/c357bd80e12bb996319ab70bd526ba72251d616c))

## [0.6.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/judge-dispatch@0.6.0...judge-dispatch@0.6.1) (2026-10-10)


### Bug Fixes

* **judge-dispatch:** keep a model the task call pins instead of rerouting it ([45b8736](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/45b8736a5beb752e8f97dc5450d61e1424608295))
* raise supported OMP floor to 18.5.1 ([217da70](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/217da70c138e3a5bd0ccaa0f7e1b3fb03b7d1b0f))

## [0.6.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/judge-dispatch@0.5.1...judge-dispatch@0.6.0) (2026-10-06)


### Features

* **judge-dispatch:** split agent routing from model selection and pick models from the flattened pool ([8797b60](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/8797b604894503b08a07c03ecb1f9897647b5567))

## [0.5.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/judge-dispatch@0.5.0...judge-dispatch@0.5.1) (2026-10-04)


### Bug Fixes

* raise supported OMP floor to 18.3.5 ([3872df5](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/3872df5c97904b74f5e42a35d9c79efdb881ff64))

## [0.5.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/judge-dispatch@0.4.0...judge-dispatch@0.5.0) (2026-09-30)


### Features

* **judge-dispatch:** show an immediate status line for every routed task call ([17dfcf6](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/17dfcf65ecd9f68a63bffa1de887360e8447852c))

## [0.4.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/judge-dispatch@0.3.0...judge-dispatch@0.4.0) (2026-09-30)


### Features

* **judge-dispatch:** show routing progress and record changed routes ([243246d](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/243246df732169d618868fe6dd91c45b67c8f728))

## [0.3.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/judge-dispatch@0.2.1...judge-dispatch@0.3.0) (2026-09-30)


### Features

* **judge-dispatch:** pick spawn models by task difficulty, intelligence and price with modelBudget ([822ed07](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/822ed07119ea83baacad76de0bb6d1bce516faa3))

## [0.2.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/judge-dispatch@0.2.0...judge-dispatch@0.2.1) (2026-09-28)


### Bug Fixes

* **judge-dispatch:** preserve workflow and read-only routing ([a5de3cc](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/a5de3ccaa4cb4c4321f96568739b992d254eae27))

## [0.2.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/judge-dispatch@0.1.1...judge-dispatch@0.2.0) (2026-09-28)


### Features

* **judge-dispatch:** drop the enhanced routing mode and its integrationMode setting ([7a566c6](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/7a566c6da4f4e5628a2320f8bbf1818786e25fa3))
* **judge-dispatch:** let the judge set task thinking effort ([2d110d9](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/2d110d9063ac9d65b64e09b6471b15d15b9b8d17))

## [0.1.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/judge-dispatch@0.1.0...judge-dispatch@0.1.1) (2026-09-28)


### Bug Fixes

* **judge-dispatch:** leave reserved audit agents out of routing ([3573758](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/35737582475280464ba6f7f20c10d361bfafad5b))
