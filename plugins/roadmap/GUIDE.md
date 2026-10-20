# roadmap guide

English | [简体中文](GUIDE.zh.md)

When to use roadmap, how to size the work, and what a typical session looks like. Commands and limitations are in the [README](README.md).

## What it is for

Roadmap keeps a repository's goals and delivery record in `docs/roadmap/`, maintained by the agent. It answers what a single plan can't: why this work, what this round commits to, what has been proven and what is still owed. A fresh session can read it and continue without you explaining the project again.

| Piece | Owns |
| --- | --- |
| Roadmap | Goals, stages, dependencies, done criteria, deferred work, outcomes. |
| Prometheus | How one piece of work gets done: the plan. |
| Atlas | Running an approved plan and collecting evidence. |

Prometheus and Atlas come from `omo-prometheus`; roadmap works without it, but the plan features below need it. Roadmap never stores plans; it reads Atlas plan bundles when it needs to show them.

It needs a local Git repository but no remote or hosting service. Closing a stage checks that every criterion has evidence, not that the evidence is true. Closed stages and rounds are frozen, and a finished plan never closes a stage by itself.

## When to use it

Use it when work needs goals, order, decisions and open obligations kept across many executions:

| Situation | How to use it |
| --- | --- |
| A large new project | Detail the first round's stages; keep later rounds coarse. |
| Migrating or replacing a system | Make compatibility and rollback their own stages; put "old path removed" in the last stage's criteria. |
| Long-running product work | One product goal per round; deferred ideas become TODOs aimed at a later stage or a trigger. |
| Tech debt or performance work | Start with a baseline stage; later stages get measurable criteria and a stop condition. |
| Security or audit remediation | One criterion per finding or class; accepted risks are recorded with reasons. |
| Spike before building | A research stage whose result is an ADR linked to it; implementation stages depend on it. |
| Taking over or resuming a project | Initialize with today's code as the baseline. Don't backfill history. |

Skip it for one-session fixes, throwaway experiments, busy triage queues, and coordinating several repositories (each Git root has one roadmap and one active round). Work outside the roadmap doesn't need a stage; the agent can log it as free work.

## Rounds, stages and plans

A **round** has one goal you can judge at the end, such as "first users can complete the core flow". One round is active at a time. At close you record whether the goal was `achieved`, `partial`, `not_achieved` or `cancelled`.

A **stage** is a result you can verify on its own, such as "a user can log in and see their data", with two to six done criteria. Don't split by layer (backend, frontend, tests): none of those can be judged finished alone. Declare dependencies only for real prerequisites.

A **plan** covers some or all of a stage's criteria, and several plans can share a stage. Each plan declares what it owns:

```text
Roadmap criteria: DC1, DC3
```

Prometheus checks the line before you approve the plan. If a stage holds several large independent pieces from the start, split the stage instead.

Rules of thumb: three to eight stages per round. Five to eight plans fit one round; for more, keep one active round, one detailed planned round, and coarse rounds after that.

## Example

Replacing an authentication system takes about six plans, so it gets two rounds:

- R1 "prove the new system works": S01 document current login paths, S02 new login path works end to end, S03 rollback rehearsed.
- R2 "switch safely": S04 identity mapping, S05 small-cohort switch, S06 full switch and old-path removal.

While working on S02, the agent finds that password reset behaves differently. It records a TODO aimed at S05. When R1 closes, the TODO moves to R2 with the same ID and appears in the S05 handoff. S02 itself might take two plans, one declaring `DC1` and one declaring `DC2, DC3`; it closes once every criterion has passing evidence.

## A typical cycle

1. Run `/init-project` and confirm the preview. Draft later rounds with `/roadmap plan-round`.
2. Ask which stages can start. The agent sees which are ready and which wait on dependencies.
3. Start the stage, then plan with `/prometheus`, or the other way round. The handoff includes the round's goal, constraints and non-goals, what predecessor stages delivered, open TODOs, ADRs, and plans already made for the stage. Started inside planning, the stage only binds and stays planned; Atlas starts it and commits that start before its first task.
4. While working, scope changes become stage amendments, later work becomes TODOs, and decisions become ADRs. If the stage changes after a plan was approved, you get a notice; nothing pauses.
5. Before Atlas releases a plan, each out-of-scope finding is filed as a TODO, a duplicate or won't fix, and listed in the final report.
6. When a plan finishes, the reminder shows criteria coverage across all plans. Close the stage once every criterion has passing evidence.
7. When every stage is closed or dropped, run `/roadmap close-round`, record the goal outcome, and decide on the next round.

Things you can ask:

- "Which stages can start now? Recommend the next one. Don't plan yet."
- "Start S04. Check the round constraints and what earlier stages delivered first."
- "This plan is done. Can S04 close? List what isn't proven yet."
- "Before closing the round, tell me whether its goal was achieved."

Round-level changes always need your command and a confirmed preview.

## Repository format 2

Planned rounds, target dates and round goal outcomes need repository format 2. `/init-project` creates format-2 repositories; anyone sharing one needs a roadmap release newer than 0.2.3. A repository initialized by an earlier release is format 1: roadmap asks whether to upgrade when a session starts, and No changes nothing. You can also run `/roadmap upgrade`. After upgrading, **roadmap 0.2.3 and earlier can no longer read the repository**, so update the plugin for anyone sharing it first.
