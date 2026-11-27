# The council reviews CodeR

CodeR's first pull request was reviewed by the council it implements. This is
the record of that session: who said what, what the council agreed on, what
changed because of it, and what was left for later.

## How the session was run

- **The seats** are the product's own. On the panel: the Solutions Architect,
  the Staff Engineer, the Refactoring School and the Clean Code School. The
  Pragmatic Implementer writes the patches and the moderator issues the
  verdict. They are archetypes of engineering schools of thought, not people.
- **The protocol** is the product's own: opening statements written in
  parallel and in isolation; a debate in which each reviewer reads the
  others' findings and takes a position on every one (`agree`, `refine` or
  `disagree`); consensus computed by code; implementation; verdict.
- **The consensus** below was computed by the product's own policy function,
  `computeConsensus` in `src/domain/deliberation/consensusPolicy.ts`, fed
  with the 34 findings and the 101 positions. No model and no person decided
  what was endorsed.
- **What was not the product.** The reviewers ran as sub-agents of the session
  that built CodeR, each briefed with its seat, and not through CodeR's Claude
  adapter: the build environment has no Anthropic API key. So this session
  was not anchored, stored or published by CodeR itself. The first review of
  a real pull request through the product's own adapter is still to be done
  (see "What is verified, and what is not" in the README).
- **The subject** was the whole first pull request at commit `4812901`:
  about 15,000 lines of TypeScript and CSS, 2,000 of them tests, with 75
  tests passing.

## At a glance

| | |
|---|---|
| Findings | 34: 1 blocker, 17 major, 15 minor, 1 nit |
| Positions taken in the debate | 101: 64 agree, 37 refine, 0 disagree |
| Consensus | 34 endorsed, 0 contested, 0 rejected |
| Reproduced with a script before the debate | all 10 findings of the Staff Engineer (S-6 at the rendering level only) |
| Reported independently by two or three seats | 5 defects (A-2 and S-8; A-3 and S-7; A-4, S-5 and C-1; A-5 and S-9; A-6 and S-10) |
| Verdict | **Request changes**, merge risk **high** |
| Outcome | All 34 acted on in this pull request: 26 fixed as settled in the debate, 8 fixed with part of the proposed remedy deferred or declined for a stated reason. Tests went from 75 to 173 |

## Opening statements

**Solutions Architect.** The layering holds (domain imports nothing outside itself, application imports no adapter, one CoderApi behind Fastify and inside a browser tab). Event-sourced ReviewSession with one shared fold, deterministic consensus and verdict rules, and the re-checked head commit before publishing are the right decisions. The weakness is at the edges: the event log is meant to be the truth, yet several decisions are taken from process memory (which sessions run, which commits were reviewed, whether a publication is in flight), so a restart or one failed upstream call leaves states nothing reconciles, and the file store's recovery path can drop events. Second gap: the human's side of the model. Side notes: http/server.ts imports the Claude and GitHub adapters' error classes to pick a status code (the application's own `upstream_failure` kind is never thrown); docs/DOMAIN.md:190 states a consensus rule (`support >= 2 and support > opposition`) that consensusPolicy.ts does not implement (`support - opposition >= 2`).

**Staff Engineer.** The core held up: the aggregate enforces its invariants, consensus and the verdict policy are deterministic code, the webhook HMAC is computed over the raw bytes and compared in constant time, the static route does not traverse, a failing reviewer is recorded while the round goes on, and the first model call gates the others so they read the prompt cache. The defects sit at the boundaries, where the code trusts something it does not control: the URL text instead of the matched route, the browser (no Origin or Host check in the default token-less mode), the model's text (located at the first matching line and published to GitHub verbatim), a single GitHub listing (the auto-review baseline), and the disk and process lifetime. None of these paths is tested. Below the cut: a refused or cut-off reviewer call is billed but never reaches the session's cost total; a model outside the four-entry price table is costed at $0; docs/DOMAIN.md:190 disagrees with the consensus code.

**Refactoring School.** The design earns its abstractions: every port has two live implementations and CoderApi is implemented both in process and over HTTP. One pure fold is the single definition of session state, and the policies are small pure functions with behaviour-level tests. Very little speculative structure. The smells that remain are one family: a rule or a shape is defined once in the domain and then written out again where it is consumed instead of being reused. Costliest case: publication, where choosing what to publish and rendering GitHub Markdown are a single phase. Plus one 300-line App function on the only side of the system that has no tests. Every step recommended is an Extract or a Move; none needs a new layer, interface or library.

**Clean Code School.** The Dependency Rule holds when checked mechanically; the one sideways dependency is the HTTP adapter importing two sibling adapters' error classes (C-5). The council's rules live in an event-sourced aggregate and small pure policy functions in the domain's own words; the ports that matter each have two real implementations; 75 tests run in about a second against wire-format stand-ins rather than mocks, with clock, pace and ids injected. The discipline thins at the edges: two behaviours that decide money and trust have no test at all (the auto-review baseline, which is also wrong when the first listing fails, and the workspace's HTTP client); several catch blocks turn a failure into a normal-looking result that nobody is told about. The rest is knowledge kept in two places: council rules copied across layers, a domain document that contradicts the code, and view rules duplicated around a 300-line App function.

## Findings and consensus

Ids carry the seat: `A` Solutions Architect, `S` Staff Engineer, `R`
Refactoring School, `C` Clean Code School. The author of a finding counts as
support, and `refine` is qualified support: the reviewer accepts the problem
and argues about the remedy, the severity or the order.

| Id | Severity | Finding | Raised by | Positions of the other seats | Consensus | Outcome |
|---|---|---|---|---|---|---|
| A-1 | major | Human decisions filter the findings but never reach the verdict that is published | Arch | Staff: agree · Refac: refine · Clean: agree | endorsed (4 for, 0 against) | Fixed: `ac0b103`, rule in `12874ae`, workspace in `15df9d8` |
| A-2 | major | A restart leaves in-flight sessions in_progress forever; nothing reconciles the log at boot or drains at shutdown | Arch | Staff: agree · Refac: agree · Clean: agree | endorsed (4 for, 0 against) | Fixed: `3c9b6f2` |
| A-3 | major | Every inbox refresh from every open tab is an uncached pass-through to GitHub | Arch | Staff: agree · Refac: refine · Clean: agree | endorsed (4 for, 0 against) | Fixed: `7312070`. Summaries stored in the watchlist: deferred |
| A-4 | major | Auto-review decides "already reviewed" from process memory instead of the event store | Arch | Staff: refine · Refac: refine · Clean: refine | endorsed (4 for, 0 against) | Fixed: `5191e0d`. Persisted baseline: declined |
| A-5 | major | The file event store updates memory before disk and never repairs a torn tail | Arch | Staff: agree · Refac: agree · Clean: agree | endorsed (4 for, 0 against) | Fixed: `a5d8dca` |
| A-6 | minor | "Published once" is guarded by a process-local Set, not by the aggregate | Arch | Staff: agree · Refac: refine · Clean: agree | endorsed (4 for, 0 against) | Fixed: `a5809ab`, workspace in `934d106` |
| A-7 | minor | The domain renders GitHub's markup and vocabulary, so the publication plan cannot be read as data | Arch | Staff: refine · Refac: refine · Clean: refine | endorsed (4 for, 0 against) | Fixed in part: `d50a9cb`. The renderer stays in the domain, by decision of the debate |
| A-8 | minor | The read API addresses an immutable snapshot by a mutable reference, so a session is drawn over code it did not review | Arch | Staff: agree · Refac: refine · Clean: refine | endorsed (4 for, 0 against) | Fixed: `27228df`, workspace in `e8515ca` |
| S-1 | blocker | The bearer-token check is skipped when the `/api/` prefix is percent-encoded | Staff | Arch: agree · Refac: agree · Clean: agree | endorsed (4 for, 0 against) | Fixed: `64b25e7` |
| S-2 | major | The default token-less mode accepts cross-site and foreign-Host requests: a web page can start paid reviews and, with DNS rebinding, read source and publish | Staff | Arch: agree · Refac: agree · Clean: agree | endorsed (4 for, 0 against) | Fixed: `4fabd45` |
| S-3 | major | A patch is located at the first place its snippet occurs, not at the finding it fixes | Staff | Arch: agree · Refac: refine · Clean: agree | endorsed (4 for, 0 against) | Fixed: `f80b058` |
| S-4 | major | Published comments are built from raw model text: the suggestion is not the patch that was previewed, a ``` inside it ends the block early, and @name / #n go out live | Staff | Arch: agree · Refac: refine · Clean: agree | endorsed (4 for, 0 against) | Fixed: `f80b058`, workspace in `15df9d8` |
| S-5 | major | Auto-review takes its baseline from a failed or 30-item listing and then convenes paid councils on old pull requests | Staff | Arch: agree · Refac: agree · Clean: agree | endorsed (4 for, 0 against) | Fixed: `5191e0d`, pagination in `7312070` |
| S-6 | major | Pull-request text is spliced into the system prompt with delimiters the author can forge | Staff | Arch: agree · Refac: agree · Clean: agree | endorsed (4 for, 0 against) | Fixed: `9231eca` |
| S-7 | major | The inbox poll re-reads a full snapshot of every imported pull request about every 20 seconds and exhausts the GitHub rate limit | Staff | Arch: agree · Refac: agree · Clean: agree | endorsed (4 for, 0 against) | Fixed: `7312070`, workspace in `9e62eb8`. ETags: deferred |
| S-8 | major | A review interrupted by a restart stays `in_progress` forever | Staff | Arch: agree · Refac: agree · Clean: agree | endorsed (4 for, 0 against) | Fixed: `3c9b6f2` |
| S-9 | major | After a torn or failed append the event log silently loses later events, including the record that a review was published | Staff | Arch: agree · Refac: agree · Clean: agree | endorsed (4 for, 0 against) | Fixed: `a5d8dca` |
| S-10 | minor | Publishing is a dual write with no intent record: decisions are accepted while the review is in flight, and a lost record allows a second review | Staff | Arch: agree · Refac: refine · Clean: agree | endorsed (4 for, 0 against) | Fixed: `a5809ab`, workspace in `934d106` |
| R-1 | major | Publication is decided and rendered in one phase, so the plan crosses every boundary as prose | Refac | Arch: refine · Staff: refine · Clean: refine | endorsed (4 for, 0 against) | Fixed: `d50a9cb` |
| R-2 | minor | The workspace keeps a hand-copied mirror of the domain's publication rule | Refac | Arch: agree · Staff: agree · Clean: agree | endorsed (4 for, 0 against) | Fixed: `d50a9cb`, workspace in `5b88a74` |
| R-3 | minor | App is one 300-line function holding all workbench state, and its navigation rules are already copied into the components | Refac | Arch: refine · Staff: refine · Clean: agree | endorsed (4 for, 0 against) | Step one fixed, workspace in `5b88a74`. Hooks: deferred |
| R-4 | minor | The fallback verdict re-derives the verdict policy's risk floor and endorsed-findings query in another layer | Refac | Arch: agree · Staff: refine · Clean: agree | endorsed (4 for, 0 against) | Fixed: `12874ae` |
| R-5 | minor | GitHub's pull-request payload is translated twice, the second time inside the HTTP server | Refac | Arch: refine · Staff: agree · Clean: refine | endorsed (4 for, 0 against) | Fixed: `0ea50c8` |
| R-6 | minor | Closed sets the domain already names are re-typed as string literals at the edges | Refac | Arch: refine · Staff: refine · Clean: agree | endorsed (4 for, 0 against) | Fixed: `281ae96` |
| R-7 | minor | Who speaks in which round is encoded three times, and only one copy is obeyed | Refac | Arch: agree · Staff: silent · Clean: refine | endorsed (3 for, 0 against) | Fixed: `80ab5ca`. Seating drawn from the session in the workspace: deferred |
| R-8 | nit | Extension points with no caller: subscribeAll, parseRefKey, the content-budget parameter | Refac | Arch: refine · Staff: refine · Clean: refine | endorsed (4 for, 0 against) | Fixed in part: `75a2162`. The clock and the content budget were kept and given tests |
| C-1 | major | The auto-review baseline has no test, and a failed first listing turns it into the burst of paid reviews it exists to prevent | Clean | Arch: agree · Staff: agree · Refac: agree | endorsed (4 for, 0 against) | Fixed: `5191e0d` |
| C-2 | major | The workspace and its HTTP client have no automated test; the server tests check the contract against a copy of the client | Clean | Arch: agree · Staff: refine · Refac: agree | endorsed (4 for, 0 against) | Fixed: `360aa03`, workspace in `5b88a74` |
| C-3 | major | Failures are turned into normal-looking results, with no log entry and no trace on screen | Clean | Arch: refine · Staff: agree · Refac: refine | endorsed (4 for, 0 against) | Fixed: `1e4548e`, `d50a9cb`, workspace in `f377523` |
| C-4 | minor | One try block in `speak` covers both the model call and the recording, so programming errors are reported as "Reviewer failed" | Clean | Arch: agree · Staff: refine · Refac: agree | endorsed (4 for, 0 against) | Fixed: `40f0f2b` |
| C-5 | minor | The HTTP adapter imports two sibling adapters to classify their errors, and "not found" answers 404, 500 or 502 depending on who was asked | Clean | Arch: agree · Staff: agree · Refac: agree | endorsed (4 for, 0 against) | Fixed: `02771e8` |
| C-6 | minor | Council rules are written twice, in different layers, and no test compares the copies | Clean | Arch: refine · Staff: agree · Refac: refine | endorsed (4 for, 0 against) | Fixed: `12874ae`, `d50a9cb`, workspace in `5b88a74` |
| C-7 | minor | The domain document, declared the source of truth, states a different consensus rule from the code and its test | Clean | Arch: agree · Staff: refine · Refac: agree | endorsed (4 for, 0 against) | Fixed: document corrected, boundary pinned in `bc48003` |
| C-8 | minor | `App` is one function of about 300 lines, and four view rules are written twice across the components | Clean | Arch: refine · Staff: refine · Refac: agree | endorsed (4 for, 0 against) | Step one fixed, workspace in `5b88a74`. Hooks: deferred |

## The debate

Nobody disagreed that a finding was real. The 37 refinements were about
remedies, severities and order, and these are the ones that changed what was
built:

- **Where the published decision comes from (A-1).** The Architect proposed
  deriving the review's decision inside the publication planner. The
  Refactoring School objected that this would state the blocker rule a third
  time, and could publish a comment under a verdict that says "request
  changes" when no human had decided anything. Settled: one rule over "the
  findings that stand" (`boundDecision`), applied to the endorsed findings
  when the verdict is issued and to the published findings when the review
  goes out.
- **Where the renderer lives (A-7 and R-1).** The Architect wanted the
  Markdown and the suggestion fence moved into the GitHub adapter. The other
  three seats chose the Refactoring School's Split Phase in place, because
  the publication preview and the demo source need the same rendering. The
  Architect withdrew that part and kept one: persist the domain's `Decision`
  in `ReviewPublished` instead of GitHub's event name, before a pilot has
  data. The Refactoring School in turn withdrew its own proposal to reuse the
  GitHub-shaped type.
- **How eagerly auto-review retries (A-4).** "Retry unless a session that did
  not fail exists" would buy a failing council again on every poll, said the
  Staff Engineer and the Clean Code School. Settled: a head commit that
  already has two failed sessions is left alone.
- **Whether publishing needs an intent event now (A-6 and S-10).** The
  Refactoring School preferred a one-line guard now and the event later. The
  other three seats wanted the event, on one condition from the Clean Code
  School: after the event log is made durable (A-5 and S-9), or the intent is
  not worth trusting. Settled for the event, in that order.
- **What a recording error does to a session (C-4).** The Clean Code School
  and the Architect: our own defect must fail the session with its real
  reason, not be reported as "the reviewer failed". The Staff Engineer: three
  other paid answers are in flight when that happens. Settled: the round
  settles and is recorded first, then the session fails with the real reason.
- **Dead parameters (R-8).** Three seats objected to deleting the catalog's
  clock and content budget: they had no caller only because the tests that
  need them did not exist. Kept, and given their first callers.
- **Who translates the webhook (R-5).** Moving the translation into the
  GitHub adapter and importing it from the HTTP adapter would recreate the
  adapter-to-adapter import that C-5 removes. Settled: the GitHub adapter
  owns the webhook and the composition root hands it to the HTTP server.
- **The consensus rule itself (C-7).** The domain document said "support of
  at least 2 and more than the opposition"; the code says "net support of at
  least 2". Settled for the code's rule, the more conservative one: with two
  for and one against, a finding is contested and a human looks at it. The
  boundary is now pinned by named tests and the document was corrected.
- **A defect behind a duplication (R-4).** While checking a duplicated rule,
  the Staff Engineer found that the copy was also wrong: with one surviving
  panelist and a failed moderator, the fallback verdict approved a change
  over a blocker that nobody had reviewed.
- **Order.** The Refactoring School and the Clean Code School asked for the
  net before the change: the round-trip test of the HTTP client before
  touching the server's guards, the single risk rule before the published
  decision, Split Phase before the patch fixes, the durable log before the
  publication intent. The implementation followed that order.

Severities the debate would lower: R-6 and R-7 to nit, and C-2 to minor until
a defect is shown in the client. The Refactoring School holds R-1 at major,
because four findings from three seats land in the function it splits.

## Verdict

**Request changes. Merge risk: high.**

One endorsed blocker is enough under the council's own policy: with an API
token configured, any route could still be called without it by
percent-encoding the path (S-1). The endorsed majors sit where a mistake
costs the most: what is published under a person's name (A-1, S-3, S-4),
what spends money unattended (S-2, S-6, A-4 with S-5 and C-1, A-3 with S-7),
and what a restart loses (A-2 with S-8, A-5 with S-9).

The core held up under four independent readings: the dependency rule, the
event-sourced aggregate with one shared fold, the deterministic consensus and
verdict policies, the signature check of the webhook. The defects are at the
edges, on paths that no test walked: the encoded URL, the failed listing, the
restart, the torn line, the repeated snippet, hostile text in a prompt or in
a comment.

## What changed

The Pragmatic Implementer took the endorsed findings in the order the debate
asked for, one commit per package, each with the test that would have caught
the defect. The suite went from 75 to 173 tests.

| # | What changed | Findings | Commit |
|---|---|---|---|
| 1 | First the net: one contract suite runs through both deliveries of the API, the in-process application and the real HTTP client against the real server. A live stream that is lost for good now tells its caller | C-2 | `360aa03` |
| 2 | The token check is a hook on the scope the API routes are registered in, so it follows the route that matched, whatever the spelling of the URL | S-1 | `64b25e7` |
| 3 | Without a token the API answers only this machine (loopback `Host`, no foreign `Origin`, no cross-site fetch); the server refuses to start on another address without a token; at most four councils at once, one per commit | S-2 | `4fabd45` |
| 4 | One rule over "the findings that stand" (`boundDecision`, `riskFloor`); the fallback verdict moved into the domain and no longer approves over a finding nobody reviewed | R-4, C-6 | `12874ae` |
| 5 | The publication plan is selected as data and then rendered; a finding whose line was not confirmed goes to the summary; the domain's `Decision` is persisted and only the GitHub adapter speaks GitHub's review events | R-1, A-7, R-2, C-6, C-3 | `d50a9cb` |
| 6 | A patch lands at the occurrence nearest its finding, or is not applicable when that is ambiguous; preview and suggestion are made from the same lines; deletions, nested fences, `@mentions` and `#123` are published safely | S-3, S-4 | `f80b058` |
| 7 | The published decision is the verdict's rule applied to what will really be published, and the review says when the human changed the outcome | A-1 | `ac0b103` |
| 8 | The event log is written to disk before memory believes it; a torn tail is repaired on open and a stream with a hole is set aside; a failed write is retried by the next save | A-5, S-9 | `a5d8dca` |
| 9 | Publishing records its intent before it calls GitHub, closes decisions while in flight, and records a failure | A-6, S-10 | `a5809ab` |
| 10 | The pull request's text left the system prompt: it travels in the user turn inside a boundary derived by HMAC per commit, with titles, branches and paths escaped | S-6 | `9231eca` |
| 11 | Sessions and publications interrupted by a restart are failed at start-up; a signal fails and saves running sessions; every reviewer call has a deadline | A-2, S-8 | `3c9b6f2` |
| 12 | The inbox reads GitHub once per interval whatever the number of tabs, from a paginated listing and one-call summaries; a failed refresh keeps the rows and reports the error | A-3, S-7, S-5 | `7312070` |
| 13 | Auto-review acts only on a complete listing and answers "already reviewed" from the stored sessions, with a bound on retries | A-4, S-5, C-1 | `5191e0d` |
| 14 | Failures are reported instead of smoothed over: unreadable files, a broken watchlist, a merge base that could not be found, a recording error in a round | C-3, C-4 | `1e4548e`, `40f0f2b` |
| 15 | Adapters raise the application's error codes; the GitHub adapter owns the webhook; closed sets, the seating plan and the revision key are each named once; dead extension points removed; the consensus boundary pinned by named tests | C-5, R-5, R-6, R-7, R-8, C-7 | `02771e8`, `0ea50c8`, `281ae96`, `80ab5ca`, `75a2162`, `bc48003` |
| 16 | A file is read against the commit a session reviewed | A-8 | `27228df` |
| 17 | The workspace states no rule of the council: it imports them from the domain. Its own view rules and its reducer each have one home, with tests | R-2, R-3, C-6, C-8, C-2 | `5b88a74` |
| 18 | The publish bar says what will really be posted, and says so when the human's decisions changed the outcome; the patch card shows the exact lines that will be published | A-1, S-4 | `15df9d8` |
| 19 | Publishing is shown as a state that survives a reload, with its failure and a way to try again; a preview that fails says why | A-6, S-10, C-3 | `934d106` |
| 20 | A session is never drawn over code it did not review; a lost live stream, each inbox error and closed pull requests are visible; the inbox stops polling while its tab is hidden | A-8, C-3, S-7 | `e8515ca`, `f377523`, `9e62eb8` |
| 21 | The inbox shows how a review was published, not only what the council asked for. Found by the workspace implementer while testing item 18 | A-1 | `4b88f97` |
| 22 | Each finding's card says what the human decided, and what was published once the review is out. Found while driving the finished demo | A-1 | `40e16d9` |

Behaviour that changed on purpose, for anyone who used the first version:
`GET /api/health` no longer needs the token; a decision is accepted only once
the session has concluded, and a late one answers 409; a pull request that
does not exist on GitHub answers 404 instead of 502; the published review no
longer starts with an English "Council verdict" line.

The implementer went beyond its brief in four small places, all kept: branch
names are escaped in the prompt too; a write that fails half-way removes its
fragment from the file; the repository never evicts a session that still has
unsaved events; and the policy-override line has a second wording for a
request for changes that became a comment.

## Deferred, with the reason

- **Persisting the auto-review baseline** (last part of A-4). Declined: a
  fresh baseline at every start errs toward not spending money, and a stored
  one would need a rule for when it is too old. The cost is documented: pull
  requests that changed while CodeR was down are not reviewed automatically.
- **Moving the renderer behind the source-control port** (the end state of
  A-7). When a second provider exists. Until then one renderer serves the
  preview, the demo and GitHub, and its input is data.
- **Hooks extracted from `App`** (step two of R-3 and C-8). The council asked
  for tests around the workspace first; the pure rules and the reducer now
  have them, the React components do not yet.
- **Conditional requests (ETags) for the inbox** (S-7). The cache removes the
  problem at this scale.
- **Storing summaries in the watchlist** (the larger remedy of A-3). The
  catalog's cache does the same job without a second copy of each summary.
- **Drawing the seating plan from the session in the workspace** (second half
  of R-7). Speculative until councils vary.
- **The first run against the real Anthropic and GitHub APIs.** Not a
  finding, but the largest thing this review could not check: everything
  above was verified against local stand-ins that speak both wire formats.
- **Two cost-accounting gaps the Staff Engineer noted below its cut.** A
  reviewer call that is refused or cut off is billed by the API but not added
  to the session's cost, and a model that is missing from the price table is
  costed at zero. Neither was raised as a finding, and neither is fixed here.

## What the session taught the product

- **The same defect under several ids.** Five defects were reported by two or
  three seats, each under its own id, and consensus was computed for each id
  separately. Independent discovery is the strongest evidence a council
  produces, and the product does not show it yet: findings that describe the
  same defect should be linked and their support counted once.
- **Agreement is cheap, reproduction is not.** No reviewer disagreed with a
  finding. What moved severities was the Staff Engineer's scripts: a measured
  357 requests an hour, a second review actually posted, a status code. A
  sandbox where a reviewer can run the change is the next capability worth
  building.
- **Refinements carry the real debate.** All 37 non-trivial positions were
  `refine`. The product counts a refinement as support and stores its
  argument, but the implementer and the human get them as prose per finding.
  A moderator's "settled remedy" per finding would make them actionable.
- **The verdict policy works on its authors.** The moderator could not have
  approved this pull request: an endorsed blocker forces "request changes" in
  code, whatever the model in the moderator's seat would have preferred.
