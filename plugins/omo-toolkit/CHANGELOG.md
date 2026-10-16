# Changelog

## Unreleased

### Improvements

- Make category workers escalate unapproved material choices to their parent and keep refactor delegation proportional to independent work.
- Align debugging and Git guidance with observed evidence, user-owned decisions, and previously authorized commit cadence.
- Inject an agent selection protocol into the main agent's system prompt when the `task` roster lists omo-toolkit agents: domain-to-agent lanes, `deep-low` as the default, and handling of `ESCALATE: deep-high` and `ESCALATE: parent` results by re-dispatching with the same task `name`.

## [0.5.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.4.2...omo-toolkit@0.5.0) (2026-10-16)


### Features

* **omo-toolkit:** guide the main agent to pick agents by lane and handle escalations ([bb3e7c0](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/bb3e7c0d3186844a55da0f8588602d1de6c0db64))

## [0.4.2](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.4.1...omo-toolkit@0.4.2) (2026-10-14)


### Bug Fixes

* raise supported OMP floor to 18.10.4 ([9bdda2e](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/9bdda2ea3a1c547f8cd3447439819654ba448182))

## [0.4.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.4.0...omo-toolkit@0.4.1) (2026-10-10)


### Bug Fixes

* raise supported OMP floor to 18.5.1 ([217da70](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/217da70c138e3a5bd0ccaa0f7e1b3fb03b7d1b0f))

## [0.4.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.3.0...omo-toolkit@0.4.0) (2026-10-08)


### Features

* **omo-toolkit:** list designer and writer model roles in /models ([cbc5990](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/cbc5990d8c9a508ac15e23e7f83b71870cb10a57))

## [0.3.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.2.0...omo-toolkit@0.3.0) (2026-09-29)


### Features

* **omo-toolkit:** route librarian through tiny, writing through a writer role, and raise creative lanes to xhigh ([7ef81ff](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/7ef81ff4ba130fa7d1a4024659620a020788d908))

## [0.2.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.1.2...omo-toolkit@0.2.0) (2026-09-29)


### Features

* **omo-toolkit:** let visual-engineering prefer a designer model role before task ([3026f5c](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/3026f5cf02061c0beef1969c25d4ea238f1a43ec))

## [0.1.2](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.1.1...omo-toolkit@0.1.2) (2026-09-28)


### Bug Fixes

* **omo-toolkit:** respect decision ownership in worker workflows ([74b6718](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/74b6718204f8c47e9d8e5bfdbd045554b7eb9697))

## [0.1.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.1.0...omo-toolkit@0.1.1) (2026-09-28)


### Bug Fixes

* **omo-toolkit:** turn off thinking for librarian ([67c05f4](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/67c05f47430af82fdb831a9172109fe7c04d5244))
