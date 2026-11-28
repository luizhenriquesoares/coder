# CodeR — Architecture

The domain model in [DOMAIN.md](DOMAIN.md) came first. This document describes
how the code realises it, and the decisions that are not obvious from reading
one file. The council reviewed this code before its first release; what it
found and what changed is in [COUNCIL_REVIEW.md](COUNCIL_REVIEW.md).

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
│ webhook, access guard │      │  CoderApplication · ConductReview · AutoReview               │
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
  → HumanDecisionRecorded* → PublicationStarted → ReviewPublished | PublicationFailed
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
An append that fails is kept and written again by the next save, so a stream
never has a hole in it.

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
  moderator proposes passes through `applyVerdictPolicy`, which bounds it by
  the endorsed findings: no approval over an endorsed blocker, no request for
  changes without an endorsed blocker or major, and a merge risk never lower
  than those findings imply. A model can be wrong or be talked into
  something; these rules cannot.
- **The human's decisions reach what is published.** The same bound
  (`boundDecision`, `riskFloor`) is applied once more when the review is
  planned, this time to the findings that will really be published. Accepting
  a contested blocker on an approved change publishes a request for changes;
  dismissing the only grounds of one publishes a comment; when no human
  decided anything, the published decision is the verdict by construction.
- **A reviewer may fail without failing the review.** A refused, truncated or
  malformed answer, or one that does not arrive within fifteen minutes, is
  recorded as `ReviewerFailed` and the round goes on. Only an opening round
  where nobody spoke fails the session. If the moderator fails, the verdict is
  derived from consensus alone (`fallbackVerdict`), and it never approves
  while a finding is endorsed, contested or unreviewed.
- **Our own defects are not the reviewer's.** Only the call to the model is
  treated as a reviewer's failure. An error while recording an answer lets
  the round settle, so nothing that was paid for is dropped from the record,
  and then fails the session with its real reason.
- **Nothing stays in mid-air.** At start-up every stored session that is
  still in progress is failed with a message that says so, and so is a
  publication whose outcome was never recorded. On SIGINT or SIGTERM the
  running sessions are failed and saved before the process exits. At most
  four councils deliberate at once, and one per commit.
- **One malformed item does not sink a contribution.** Each finding, position
  and patch is validated by the aggregate on its own; an invalid one is
  dropped and logged.
- **What a model says about a line is checked against the file.** A finding
  carries a quote of the line. `codeAnchoring` places the finding where that
  quote actually is in the head version, nearest to the claimed line, so a
  model that miscounts lines does not put a comment in the wrong place. A
  finding whose line could not be confirmed is published in the summary, not
  on a line. A patch is placed at the occurrence of its original text nearest
  the findings it fixes, and is recorded as not applicable when that text is
  missing or the choice is ambiguous. The lines that replace the range are
  computed once, and both the preview and the published suggestion are made
  from them.

## 4. The model gateway

`ClaudeCouncil` implements the `CouncilAgents` port with the official
`@anthropic-ai/sdk`.

- **One cached prefix per pull request.** The system prompt carries only the
  council's rules. The whole pull request (description, diffs, head versions
  of the files, riskiest first, within a character budget) is the first block
  of the user turn, marked for the prompt cache. The seat and the task come
  after it, so ten calls pay for the pull request once. A small gate makes the
  first call for a pull request write the cache entry before the calls that
  arrive at the same moment read it.
- **Structured output.** Each round has a zod schema
  (`infrastructure/claude/schemas.ts`); answers come back validated. The
  domain validates again, because a schema cannot know that a finding id
  exists.
- **Adaptive thinking**, streaming, and a configurable effort.
- **Failure is translated.** A credential that is refused or cannot be
  renewed, a missing model, a rate limit, a refusal and a truncated answer
  each become a `CouncilAgentError` with a message a person can act on. The
  message is what gets logged and stored, and the other side may repeat what
  it was sent, so the adapter cleans it on the way out: what the client has
  presented as a credential is removed by its value, and anything shaped
  like a key or token of Anthropic's by its shape. The client's `fetch` is
  where the values are learnt (`infrastructure/claude/redaction.ts`): what a
  request carries in a header that authenticates, and the refresh token of a
  renewal. CodeR never holds the tokens of a sign-in, and of
  `ANTHROPIC_CUSTOM_HEADERS` it keeps only the names of the headers: both
  are known this way, like the key or token it does hold. A value under
  eight characters is a placeholder, and removing it would garble ordinary
  words. One failure quotes a credential before any request leaves, the
  runtime's error for a header it will not send: that one is replaced whole.
- **One credential, chosen once.** The configuration turns the environment
  into a `ClaudeCredential`: an auth token, the Claude Console sign-in stored
  on the machine, or an API key, preferred in that order. The one it takes is
  held to its rule there: a key or a token that could not travel in a header,
  or a profile name that looks like either, is refused by the name of its
  variable and without its value. The composition root builds the SDK client
  from the credential explicitly (`infrastructure/claude/credential.ts`), so
  the SDK does not read `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or
  `ANTHROPIC_PROFILE` for another one. It still sends what
  `ANTHROPIC_CUSTOM_HEADERS` holds: the composition root warns when that is a
  credential, and a refusal of the API then points at that variable first.
  An OAuth access token is handed to the SDK as a token provider, because
  that is the form in which the SDK announces OAuth to the API; a gateway's
  token goes as a plain bearer token. The council adapter receives the
  client, the words that name the credential and its fix, and the function
  that cleans a failure's text.
- **A sign-in is the SDK's to keep.** The SDK reads, renews and rewrites the
  tokens of a Console sign-in. CodeR reads only its settings
  (`infrastructure/claude/signIn.ts`) and checks at start-up what would
  otherwise fail hours later, at the first renewal: that the profile is a
  sign-in, that its tokens are there, private and in a directory that can be
  written to, and that neither the API's address nor the sign-in's own would
  carry it in the clear. When the SDK cannot get a token out of it during a
  review, only the status and the error code of the token endpoint's answer
  are repeated, and what became of the stored tokens is said in CodeR's
  words: the SDK's name the file, by a path that holds the home directory.
- **Untrusted input.** The pull request is written by its author, so it never
  travels in the instruction channel. It sits in the user turn inside a
  boundary derived for each commit by HMAC under a key made at start-up,
  which the author can neither guess nor close; the title, the description,
  branch names and paths are escaped. The rules say that everything inside
  the boundary is material to review, never instructions. The output is
  constrained to a schema, prose that gets published cannot notify people or
  link issues (`@name` and `#123` are wrapped in code spans), and nothing is
  published without a human.
- **A deadline per call.** The protocol gives every reviewer call an abort
  signal that fires after fifteen minutes; the adapter passes it to the SDK,
  and the protocol stops waiting even if an engine ignores it.

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
- **The inbox costs GitHub what changed, not who is watching.** Listings
  (paginated) and one-call summaries of followed pull requests are cached per
  source: sixty seconds with a token, ten minutes without one, because GitHub
  allows 60 unauthenticated requests an hour. Any number of open tabs share
  that. A refresh that fails keeps the last good answer and reports the error
  in the inbox instead of dropping rows.
- **Publishing degrades instead of failing.** GitHub refuses some reviews
  outright: approving or requesting changes on your own pull request, or a
  comment on a line it does not consider part of the diff. The adapter tries
  the planned review, then the same review as a plain comment (the body's
  headline already states the verdict), then everything folded into the body.
  Content is never dropped.
- The review is created on the commit the council reviewed. `CoderApplication`
  re-reads the pull request before publishing and refuses if the head moved.
  The session records `PublicationStarted` before GitHub is called and
  `ReviewPublished` or `PublicationFailed` after, so a review is posted once
  even if the process dies in between.
- GitHub's vocabulary stops here. The domain speaks of a `Decision`; only
  this adapter turns it into GitHub's review event. The webhook is GitHub's
  protocol too: the adapter verifies the signature over the raw bytes and
  translates the payload, and the composition root hands that function to the
  HTTP server, so no adapter imports another.

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
| `GET …/file?path=&sha=` | Both sides of one file. With `sha`, a conflict when the head is no longer that commit |
| `POST …/reviews` | Convene the council |
| `GET /api/sessions/:id` | Folded session state |
| `GET /api/sessions/:id/events` | Server-Sent Events. Replays after `Last-Event-ID` or `?after=`, then streams |
| `POST /api/sessions/:id/decisions` | Accept or dismiss a finding or a patch |
| `GET /api/sessions/:id/publication` | Exactly what would be published |
| `POST /api/sessions/:id/publish` | Publish the review |
| `POST /api/webhooks/github` | Signed `pull_request` webhooks, for automatic review |

**Who may call it.** With `CODER_API_TOKEN` set, every route except health
and the webhook requires the bearer token. The check is a hook on the scope
the routes are registered in, so it follows the route that matched and not
the spelling of the URL. Without a token the API only answers requests made
on this machine: a loopback `Host`, no foreign `Origin`, no cross-site fetch.
That closes cross-site requests from a web page and DNS rebinding. The
server refuses to start on a host that is not loopback unless a token is set.

Errors are `{ "error": { "code", "message" } }` with a message written for
the person at the screen. Adapters raise the application's own error codes,
so a pull request missing on GitHub answers 404 and a GitHub outage 502. The event stream subscribes to the bus before it
replays the store, so no event can fall between the two.

## 7. Persistence

`FileEventStore` is an append-only JSON-lines file per session under
`CODER_DATA_DIR`. A batch is written to the file before memory is updated.
On open, a torn last line from a crash is cut off the file, and a stream
whose sequence is not 1..n is set aside as `<file>.corrupt` and reported, so
a damaged file is never mistaken for a shorter history. It is enough for one
node and a demo. `EventStore` is a three-method port, so moving
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
- The workspace states no rule of the council. What is published, a finding's
  consensus level and whether a human may still decide are imported from the
  domain (`isPublished`, `levelOf`, `decisionsOpen`). Its own view rules live
  in `state/selectors.ts`, and the reducer behind `useWorkspace` is a pure
  exported function; both are tested without a DOM. The React components are
  not under test yet.
- A session is never drawn over code it did not review: when the pull request
  has new commits, the file view hides the session's markers and patches and
  says why.

## 9. Testing

Tests run without the network and without credentials. The SDK reads
`ANTHROPIC_*` variables on its own, so a setup file
(`tests/support/hermetic.ts`) drops the machine's before every test file and
points the API's address at one nothing listens on: a request reaches a
stand-in only when CodeR handed its address over. The same file refuses any
request to another machine.

| Suite | What it pins down |
|---|---|
| `change.test.ts` | Diff parsing, which lines can carry a comment, risk ranking |
| `deliberation.test.ts` | The aggregate's invariants, consensus and its boundary cases, the verdict policy and the fallback verdict, anchoring, where a patch lands, the publication selection and its rendering |
| `publishing.test.ts`, `restart.test.ts`, `persistence.test.ts` | The publication intent and its failure, what a restart finds and settles, the event log under a failed write, a torn file and a stream with a hole |
| `conductReview.test.ts`, `autoReview.test.ts`, `inbox.test.ts`, `catalog.test.ts` | The limit on concurrent councils, deadlines, a reviewer or a recording that fails, automatic review on partial knowledge, how many requests the inbox costs GitHub, the content budget |
| `demoCouncil.test.ts`, `demoTime.test.ts` | The whole protocol end to end on the fixtures, in both languages, and the fixtures' own consistency |
| `claudeCouncil.test.ts` | The official SDK against a local server speaking the Messages API streaming wire format: request shape, cache order, the prompt boundary under hostile input, fallback, refusals, truncation, a stalled reviewer, a refused credential |
| `claudeCredentials.test.ts` | Which credential the server presents, from the configuration to the request on the wire: the order of preference, an OAuth token against a gateway's, a key left in the environment, values that could not travel in a header, the line logged at start-up, what each refusal says, and that no key or token reaches the log, the session or the files, whichever variable or header it came from |
| `claudeSignIn.test.ts` | The Console sign-in as the server's credential: its use and its renewal, where its reviews and its renewals go, every state that stops the start, and what a reviewer says of each way it can fail during a review, with no token and no path in it |
| `github.test.ts` | Octokit against a local server speaking the REST API: pagination, merge base, contents, publishing and its fallbacks, the webhook receiver, error messages |
| `http.test.ts`, `liveMode.test.ts`, `config.test.ts` | The real server through the real HTTP client: one contract suite over both deliveries of the API, the access guards including encoded spellings, the event stream's life cycle, a full live review and publication, stale commits, webhooks, restart, import |
| `workspaceSelectors.test.ts`, `workspaceReducer.test.ts`, `workspacePolling.test.ts` | The workspace without a browser: its view rules, its reducer (replay, another session's events, a lost stream, a pull request that moved), the refresh that pauses while the tab is hidden |

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
| An intent event before publishing | A review is posted once, even if the process dies between GitHub's answer and our record of it | An interrupted attempt asks a person to look at the pull request before publishing again |
| Loopback only without a token | A developer's browser must not be a way into the API | Any shared deployment has to set `CODER_API_TOKEN` |
| Auto-review baseline in memory | Turning the feature on, or restarting, never triggers a burst of paid reviews | Pull requests that changed while CodeR was down are not reviewed automatically |
