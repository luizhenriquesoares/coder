# CodeR — Architecture

The domain model in [DOMAIN.md](DOMAIN.md) came first. This document describes
how the code realises it, and the decisions that are not obvious from reading
one file.

## 1. The shape

```
                         ┌──────────────────────────── web/src ───────────────────────────┐
                         │  React workspace (Monaco diff editor)                          │
                         │  folds the same events with the same code as the server        │
                         └───────────────┬──────────────────────────────┬─────────────────┘
                                         │ HTTP + Server-Sent Events    │ in process
                                         ▼                              ▼ (standalone demo)
┌─ infrastructure/http ─┐      ┌──────────────────────── application ─────────────────────────┐
│ Fastify routes, SSE,  │ ───▶ │  CoderApi  (the one interface every delivery mechanism uses) │
│ webhook, auth         │      │  CoderApplication · ConductReview · AutoReview               │
└───────────────────────┘      │  PullRequestCatalog · SessionRepository                      │
                               │  ports.ts: SourceControl · CouncilAgents · EventStore ·      │
                               │            EventBus · Watchlist · Logger                     │
                               └───────────────┬──────────────────────────────▲───────────────┘
                                               │ uses                         │ implement
                                               ▼                              │
                               ┌──────────── domain ───────────┐   ┌──── infrastructure ─────┐
                               │ change/        ChangeSet,     │   │ claude/   ClaudeCouncil │
                               │                risk, diff     │   │ github/   GitHub ACL    │
                               │ deliberation/  ReviewSession, │   │ demo/     scripted      │
                               │                events, state, │   │           council, PRs  │
                               │                policies,      │   │ persistence/ JSONL      │
                               │                publication    │   │ bus/      in memory     │
                               └───────────────────────────────┘   └─────────────────────────┘
```

**The dependency rule.** `domain` imports nothing outside itself. `application`
imports `domain`. `infrastructure` imports both and implements the ports.
`composition` is the only place that knows every concrete class. Nothing in
`domain` or `application` touches the network, the file system or the clock
directly: time is a `Clock` passed in.

| Layer | Bounded context it serves | What lives there |
|---|---|---|
| `src/domain/change` | Change Intelligence | `ChangeSet` (immutable), unified diff parsing, language detection, `assessRisk` |
| `src/domain/deliberation` | Review Deliberation (core) | `ReviewSession` aggregate, events, the state fold, consensus and verdict policies, code anchoring, patching, the publication planner, the personas |
| `src/application` | Use cases | `ConductReview` (the protocol), `CoderApplication` (queries, decisions, publishing), `AutoReview` (policy), ports |
| `src/infrastructure` | Source Control, Model Gateway, delivery | Adapters. Each one is an anticorruption layer: it translates between an outside vocabulary and the domain's |
| `src/composition` | — | `server.ts` and `standalone.ts`: two wirings of the same application |
| `web/src` | Review Workspace | The UI. Depends on `CoderApi` and on domain types; only `web/src/api/createApi.ts` knows how the application is reached |

## 2. One aggregate, event sourced

A review session is the unit of consistency. `ReviewSession` enforces the
protocol's invariants (rounds strictly in order, who may speak in which round,
no position on your own finding, a cap of findings per reviewer, a verdict
before conclusion, one publication) and records what happened as events.

```
ReviewSessionConvened → RoundStarted → ReviewerStartedThinking → StatementMade
  → FindingRaised* → PositionTaken* → ConsensusComputed → PatchProposed* / FindingDeclined*
  → VerdictIssued → ReviewSessionConcluded | ReviewSessionFailed
  → HumanDecisionRecorded* → ReviewPublished
```

State is never stored. `foldEvents` in `domain/deliberation/state.ts` rebuilds
`SessionState` from the stream, and it is used in three places:

1. the aggregate itself, to check invariants on the write side;
2. the server, to answer `GET /api/sessions/:id` and build the inbox;
3. **the browser**, which subscribes from sequence 0 and folds the events as
   they arrive.

Because the workspace runs the same fold as the server, there is no second
read model to keep in sync, and the live session on screen is exactly what a
reload or a restart will show.

Why event sourcing here, when it is often overkill: the product *is* the
transcript. A reviewer needs to see who said what and in which order, the
session log is a feature, the live stream is the same data, and a stored
session can be replayed for audit. The event log is the natural shape of the
data rather than an added mechanism.

**Concurrency.** `SessionRepository` keeps exactly one in-memory instance of
each live session and serialises its saves, so the council writing while it
deliberates and a human deciding at the same moment append to one ordered
stream. Events are appended to the store first and published to the bus after.

## 3. The protocol as a use case

`ConductReview.start` captures the pull request, convenes the session, returns
its id and lets the council work in the background. `Protocol` then runs four
rounds:

| Round | Who | Model calls | What is recorded |
|---|---|---|---|
| Opening | Architect, Staff Engineer, Refactoring, Clean Code, in parallel | 4 | Statements, findings |
| Debate | The same four, on each other's findings | 4 | Statements, positions, then `ConsensusComputed` |
| Implementation | Pragmatic Implementer | 1 | Statement, patches, declined findings |
| Verdict | Moderator | 1 | Statement, `VerdictIssued` |

Things that are deliberate:

- **Deterministic rules are in the domain, not in a prompt.** Consensus is
  `computeConsensus`, a pure function over positions. The verdict the
  moderator proposes passes through `applyVerdictPolicy`, which refuses an
  approval over an endorsed blocker and raises the merge risk to what the
  endorsed findings imply. A model can be wrong or be talked into something;
  these two rules cannot.
- **A reviewer may fail without failing the review.** A refused, truncated or
  malformed answer is recorded as `ReviewerFailed` and the round goes on. Only
  an opening round where nobody spoke fails the session. If the moderator
  fails, the verdict is derived from consensus alone (`fallbackVerdict`).
- **One malformed item does not sink a contribution.** Each finding, position
  and patch is validated by the aggregate on its own; an invalid one is
  dropped and logged.
- **What a model says about a line is checked against the file.** A finding
  carries a quote of the line. `codeAnchoring` places the finding where that
  quote actually is in the head version, nearest to the claimed line, so a
  model that miscounts lines does not put a comment in the wrong place. A
  patch is marked applicable only when its original text exists in the file.

## 4. The model gateway

`ClaudeCouncil` implements the `CouncilAgents` port with the official
`@anthropic-ai/sdk`.

- **One cached prefix per pull request.** Every call sends the same first
  system block: the council's rules and the whole pull request (description,
  diffs, head versions of the files, riskiest first, within a character
  budget). It is marked for the prompt cache. The persona and the task come
  after it, so ten calls pay for the pull request once. A small gate makes the
  first call for a pull request write the cache entry before the calls that
  arrive at the same moment read it.
- **Structured output.** Each round has a zod schema
  (`infrastructure/claude/schemas.ts`); answers come back validated. The
  domain validates again, because a schema cannot know that a finding id
  exists.
- **Adaptive thinking**, streaming, and a configurable effort.
- **Failure is translated.** A rejected key, a missing model, a rate limit, a
  refusal and a truncated answer each become a `CouncilAgentError` with a
  message a person can act on.
- **Untrusted input.** The pull request is material to review. The rules say
  so explicitly, the output is constrained to a schema, and nothing is
  published without a human, so the worst a hostile pull request can do is
  produce a bad review that a person reads.

`ScriptedCouncil` implements the same port from fixtures, with a `Pace` that
decides how long each reviewer "thinks". It is what the demo and most tests
run, and it goes through exactly the same protocol, aggregate and policies.

## 5. Source control

`GitHubSourceControl` is the anticorruption layer for GitHub (github.com and
Enterprise Server).

- A pull request's diff is computed against the **merge base**, not the tip of
  the base branch, so the left side of the editor is what GitHub shows.
- Files are read at an exact commit. A blob at a sha never changes, so
  `PullRequestCatalog` caches it without expiry; snapshots are cached for
  twenty seconds.
- **Publishing degrades instead of failing.** GitHub refuses some reviews
  outright: approving or requesting changes on your own pull request, or a
  comment on a line it does not consider part of the diff. The adapter tries
  the planned review, then the same review as a plain comment with the verdict
  in the text, then everything folded into the body. Content is never dropped.
- The review is created on the commit the council reviewed. `CoderApplication`
  re-reads the pull request before publishing and refuses if the head moved.

`DemoSourceControl` serves three sample pull requests from fixtures and
simulates publication.

## 6. One application, two deliveries

`CoderApi` (`application/api.ts`) is the whole surface of the product: inbox,
pull request detail, file contents, start a review, read a session, subscribe
to its events, decide, preview and publish.

- On the **server**, `CoderApplication` implements it and Fastify exposes it.
- In the **browser**, `HttpCoderApi` implements it over HTTP for the normal
  build. In the standalone build `createStandaloneApplication` wires the real
  `CoderApplication` to in-memory adapters *inside the tab*.

The React code cannot tell the difference. That is how the single-file demo
runs the genuine domain and application code with no server, and why the demo
is evidence about the product rather than a mock-up of it.

### HTTP API

| Method and path | |
|---|---|
| `GET /api/health` | Liveness |
| `GET /api/config` | Mode, available engines, what GitHub access allows. Never secrets |
| `GET /api/pulls` | Inbox: open pull requests with their latest session |
| `POST /api/pulls/import` | Follow one pull request by URL |
| `GET /api/pulls/:provider/:owner/:repo/:number` | Detail: files, stats, risk, sessions |
| `GET …/file?path=` | Both sides of one file |
| `POST …/reviews` | Convene the council |
| `GET /api/sessions/:id` | Folded session state |
| `GET /api/sessions/:id/events` | Server-Sent Events. Replays after `Last-Event-ID` or `?after=`, then streams |
| `POST /api/sessions/:id/decisions` | Accept or dismiss a finding or a patch |
| `GET /api/sessions/:id/publication` | Exactly what would be published |
| `POST /api/sessions/:id/publish` | Publish the review |
| `POST /api/webhooks/github` | Signed `pull_request` webhooks, for automatic review |

Errors are `{ "error": { "code", "message" } }` with a message written for
the person at the screen. The event stream subscribes to the bus before it
replays the store, so no event can fall between the two.

## 7. Persistence

`FileEventStore` is an append-only JSON-lines file per session under
`CODER_DATA_DIR`. A torn last line from a crash is ignored on load. It is
enough for one node and a demo. `EventStore` is a three-method port, so moving
to Postgres or a dedicated event store touches one file and the composition
root. The bus is in memory for the same reason.

## 8. The workspace

```
web/src/api/         HttpCoderApi, and the choice between server and standalone
web/src/state/       useWorkspace (loading, selection, live session), selectors, i18n
web/src/editor/      Monaco set-up, themes, the diff view with findings inside the code
web/src/components/  title bar, activity bar, explorer, tabs, overview, file view,
                     council chamber, timeline, cards, bottom panel, status bar
web/src/styles/      design tokens (dark and light) and the stylesheet
```

- The diff editor is Monaco, imported selectively with its worker inlined. A
  selected finding's card is rendered by React into a Monaco *view zone*, so it
  sits between two lines of code and its buttons are real buttons.
- All layout state that is worth keeping (theme, language, diff layout) is a
  per-viewer preference in local storage, read defensively. Everything else is
  derived from the session state.
- Below 980px the three columns become one pane with a bottom dock.

## 9. Testing

Tests run without the network and without credentials.

| Suite | What it pins down |
|---|---|
| `change.test.ts` | Diff parsing, which lines can carry a comment, risk ranking |
| `deliberation.test.ts` | The aggregate's invariants, consensus, verdict policy, anchoring, patching, the publication plan |
| `demoCouncil.test.ts`, `demoTime.test.ts` | The whole protocol end to end on the fixtures, in both languages, and the fixtures' own consistency |
| `claudeCouncil.test.ts` | The official SDK against a local server speaking the Messages API streaming wire format: request shape, cache order, fallback, refusals, truncation, bad key |
| `github.test.ts` | Octokit against a local server speaking the REST API: pagination, merge base, contents, publishing and its fallbacks, error messages |
| `http.test.ts`, `liveMode.test.ts` | The real server: event stream life cycle, static app, API token, a full live review and publication, stale commits, webhooks, restart, import |

The stand-ins for Anthropic and GitHub are servers, not mocks of our own
classes, so the real SDKs and our adapters are exercised together. What that
cannot prove is that the real services behave as the stand-ins do; that needs
a run with real credentials.

## 10. Decisions and their cost

| Decision | Because | The cost |
|---|---|---|
| Event-sourced session | The transcript is the product; live stream, log, audit and replay come from one source | Reading the inbox folds every stored session. Fine at this size; a projection is the next step |
| Consensus and verdict policy as code | The differentiator must be explainable and not negotiable by a prompt | The rule is simple on purpose; it will need per-team tuning |
| Same fold in server and browser | No second read model | The web build imports from `src/`, so the domain must stay free of Node APIs |
| `CoderApi` as the only seam for delivery | The demo runs the real application | Every feature has to fit that interface |
| JSON-lines files, in-memory bus | No infrastructure to install for a pilot | Single node |
| Four reviewers in parallel, twice | Depth per lens, and a debate that filters | Ten model calls per review; the prompt cache makes nine of them cheap on input |
| Personas as archetypes | The council needs distinct, recognisable schools of thought | They must never be presented as the people who inspired them |
