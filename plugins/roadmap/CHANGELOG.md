# Changelog

## [0.6.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/roadmap@0.6.0...roadmap@0.6.1) (2026-10-14)


### Bug Fixes

* raise supported OMP floor to 18.10.4 ([9bdda2e](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/9bdda2ea3a1c547f8cd3447439819654ba448182))

## [0.6.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/roadmap@0.5.1...roadmap@0.6.0) (2026-10-11)


### Features

* **roadmap:** add a fullscreen console behind the uiMenu setting ([c7729f6](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/c7729f63c75ef1f2ed48900625332eda5e53b7b1))
* **roadmap:** show Atlas coverage and planning actions in the console ([55fa6c3](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/55fa6c36384b0332ec3309d40ac07827605e3718))

## [0.5.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/roadmap@0.5.0...roadmap@0.5.1) (2026-10-10)


### Bug Fixes

* make command completions distinct and name command arguments ([74a4cc2](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/74a4cc2686e61492ba8d3f0210c1b8042b7cf9c7))
* **roadmap:** initialize new projects at format 2 ([2d816d1](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/2d816d1795dd720fff2616bd8a27a4c08622e50b))

## [0.5.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/roadmap@0.4.0...roadmap@0.5.0) (2026-10-10)


### ⚠ BREAKING CHANGES

* **roadmap:** require the adr plugin and manage ADRs through its service instead of roadmap_adr

### Features

* **roadmap:** require the adr plugin and manage ADRs through its service instead of roadmap_adr ([c4989fb](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/c4989fb5edccc632523b7ee324159173305aba05))
* **roadmap:** track multi-plan stage coverage, readiness, round goal outcomes and a format-2 upgrade prompt ([db82adc](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/db82adca89f4daf1cd07a3d6cc46a84e033e081d))


### Bug Fixes

* raise supported OMP floor to 18.5.1 ([217da70](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/217da70c138e3a5bd0ccaa0f7e1b3fb03b7d1b0f))
* **roadmap:** report roadmap usability to Atlas and count late-bound plan completions in the close reminder ([fb26ac6](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/fb26ac6bcd47f44ba9cdea5c79d948741a6398bb))
* **roadmap:** write the format-2 upgrade with the round close and tell the user when the adr plugin is missing ([d2f5281](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/d2f5281c246d54f2f7ee5559fd7a47dbc6592a53))

## [0.4.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/roadmap@0.3.2...roadmap@0.4.0) (2026-10-09)


### Features

* **roadmap:** retain Atlas delivery summaries for stage closure ([ce73a17](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/ce73a17018c850bb394073a81c0322a4d5f187dc))

## [0.3.2](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/roadmap@0.3.1...roadmap@0.3.2) (2026-10-09)


### Bug Fixes

* **roadmap:** declare tool source path so Atlas accepts symlinked installs ([28c5bd3](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/28c5bd312172be69bf7c1e66ee616bc28d3399bc))

## [0.3.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/roadmap@0.3.0...roadmap@0.3.1) (2026-10-09)


### Bug Fixes

* **roadmap:** describe /roadmap argument completions ([1b5fccf](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/1b5fccf36232a9bcedcdb8d16b72bb876bd4e82b))

## [0.3.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/roadmap@0.2.3...roadmap@0.3.0) (2026-10-08)


### Features

* **roadmap:** plan rounds ahead with optional target dates in format 2 ([19faa99](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/19faa997cb9f41ceab6c4bbebf807a4f2fdfbc7a))

## [0.2.3](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/roadmap@0.2.2...roadmap@0.2.3) (2026-10-07)


### Bug Fixes

* **roadmap:** complete /roadmap arguments one level at a time ([5e8ecbc](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/5e8ecbc8f66d5bbd89e0fd98f124f412259bf9a6))

## [0.2.2](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/roadmap@0.2.1...roadmap@0.2.2) (2026-10-07)


### Bug Fixes

* **omo-prometheus:** let Atlas use authenticated roadmap devices and bind late-started stages ([6829cb1](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/6829cb14fe30f4c31c2249f61c8184d80fb301ac))
* **roadmap:** keep answering the Prometheus handshake when stage docs are unreadable ([e7b7afe](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/e7b7afee41766f401777e723d42e589a78aacd7e))

## [0.2.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/roadmap@0.2.0...roadmap@0.2.1) (2026-10-07)


### Bug Fixes

* write plugin state sidecars to a private runtime directory instead of the session directory ([ad085bc](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/ad085bce8fe43c78de16625d9a3e821d6f69e16d))

## [0.2.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/roadmap@0.1.1...roadmap@0.2.0) (2026-10-07)


### Features

* **roadmap:** add command forms for every dialog and publish roadmap status for clients ([0833867](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/0833867b9e983bf7c35f6d424914cff50b2750a7))

## [0.1.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/roadmap@0.1.0...roadmap@0.1.1) (2026-10-06)


### Bug Fixes

* **roadmap:** confirm previews from a single file menu instead of one editor per file ([6f3f4e9](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/6f3f4e9f9bbaae9271c29593e60d9289b1b9c7c4))
* **roadmap:** list preview files by repository-relative path ([1509dc5](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/1509dc5057db902ea64163eea7460c828c9f63c8))

## Changelog
