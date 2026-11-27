# CodeR — Domain Model (Domain-Driven Design)

> Business first, code second. This document is the source of truth for the
> language we use in conversations, in the UI and in the code.

## 1. The business problem

Code review is the bottleneck of every growing engineering team.

* A tech lead or CTO cannot read every pull request. PRs wait hours or days,
  or get a superficial "LGTM".
* Single-bot AI reviewers produce a flat list of comments: noisy, uncalibrated,
  and with no sense of *which* problems actually matter.
* Senior knowledge (architecture, refactoring discipline, clean code,
  pragmatic engineering) lives in a few heads and does not scale.

**CodeR gives every pull request a senior review council in minutes.**
Specialised AI reviewers examine the change through different lenses, *debate*
each other's findings, reach consensus (or record dissent), an implementer
writes the actual patches, and a moderator issues a verdict. The human stays in
charge: an IDE-grade workspace shows exactly what is changing, where the risk
is, and what the council agreed on, so the final decision takes minutes instead
of an hour.

### Value proposition per actor

| Actor | Pain today | What CodeR gives |
|---|---|---|
| CTO / Tech lead | Can't review everything; quality drifts | A calibrated verdict + the 3 things that need *human* attention |
| PR author | Waits for review; vague feedback | Fast, explained, prioritised feedback with ready-to-apply patches |
| Engineering org | Senior know-how doesn't scale | The same council reviews every PR, every repo, 24/7 |

### Why a *council* and not a bot (the differentiator)

1. **Multiple lenses** — architecture, correctness/security, refactoring,
   clean code. One prompt cannot hold them all at full depth.
2. **Debate as a filter** — a finding that survives cross-examination is worth
   a human's time; a finding nobody else endorses is probably noise. Debate
   turns quantity into signal.
3. **Show me the code** — the implementer converts agreed findings into
   concrete patches, which is what actually saves time.
4. **Transparent reasoning** — the human sees *why* (positions, dissent),
   not just *what*.

## 2. Subdomains

| Subdomain | Type | Why |
|---|---|---|
| **Review Deliberation** | **Core** | The council protocol, consensus and verdict. This is the moat. |
| **Change Intelligence** | Supporting | Understanding a change: files, hunks, risk hotspots, review order. |
| **Review Workspace** | Supporting | The human-in-the-loop experience (IDE view, decisions). |
| **Source Control Integration** | Generic | GitHub today, GitLab/Azure DevOps tomorrow. |
| **Model Gateway** | Generic | Access to Claude. Replaceable infrastructure. |
| Identity, Billing | Generic | Bought, not built (out of scope for the MVP). |

## 3. Bounded contexts and context map

```
            ┌───────────────────────┐
 GitHub ──▶ │ Source Control (ACL)  │  translates GitHub PRs/webhooks into our language
            └──────────┬────────────┘
                       │ PullRequestSnapshot (published language)
                       ▼
            ┌───────────────────────┐
            │  Change Intelligence  │  ChangeSet, FileChange, Hunk, Hotspot, RiskScore
            └──────────┬────────────┘
                       │ ChangeSet (published language, immutable snapshot)
                       ▼
            ┌───────────────────────┐        ┌──────────────────┐
            │ Review Deliberation   │ ─────▶ │  Model Gateway   │  (ACL: prompts, schemas,
            │ (CORE)                │  port  │  Claude adapter  │   structured outputs)
            └──────────┬────────────┘        └──────────────────┘
                       │ domain events (StatementMade, FindingRaised, PositionTaken, …)
                       ▼
            ┌───────────────────────┐
            │  Review Workspace     │  read models / projections, HumanDecision
            └──────────┬────────────┘
                       │ PublishReview
                       ▼
            Source Control (ACL) ──▶ GitHub review + inline comments + suggestions
```

Relationships:

* **Source Control → Change Intelligence**: Anticorruption Layer. GitHub's
  JSON never leaks past the adapter; we only see `PullRequestSnapshot`.
* **Change Intelligence → Review Deliberation**: Customer/Supplier. The
  deliberation consumes an immutable `ChangeSet` snapshot (a PR's new push
  is a *new* snapshot, never a mutation).
* **Review Deliberation → Model Gateway**: the core owns the `ReviewerAgent`
  port; Claude is one implementation behind an ACL that maps our persona
  briefs to prompts and JSON schemas. A scripted implementation powers demo
  mode and tests.
* **Review Deliberation → Review Workspace**: published domain events;
  the workspace builds projections (Conformist).

## 4. Ubiquitous language

| Term (EN) | Termo (PT) | Meaning |
|---|---|---|
| Pull Request | Pull Request | The external request to merge a change (Source Control context). |
| ChangeSet | Conjunto de mudanças | Immutable snapshot of what a PR changes at a given head commit. |
| File Change | Arquivo alterado | One file in a ChangeSet: path, status, hunks, language. |
| Hunk | Trecho | A contiguous block of changed lines in a file. |
| Hotspot | Ponto quente | A file whose risk score demands attention (size, sensitive area, missing tests…). |
| Risk Score | Pontuação de risco | 0–100 heuristic risk of a file or of the whole ChangeSet. |
| Council | Conselho | The set of reviewers convened for a review session. |
| Reviewer | Revisor | A council member with a persona and a lens. |
| Persona | Persona | The reviewer's identity: role, school of thought, voice. |
| Lens | Lente | What a reviewer looks for (architecture, correctness, refactoring, clean code). |
| Review Session | Sessão de revisão | One run of the council over one ChangeSet. Aggregate root. |
| Round | Rodada | A phase of the protocol: Opening, Debate, Implementation, Verdict. |
| Statement | Declaração | What a reviewer says to the council in a round. |
| Finding | Achado | A problem raised by a reviewer, anchored to a location, with severity and rationale. |
| Severity | Severidade | `blocker`, `major`, `minor`, `nit`. |
| Position | Posição | A reviewer's stance on someone else's finding: `agree`, `disagree`, `refine`. |
| Consensus | Consenso | Outcome of positions on a finding: `endorsed`, `contested`, `rejected`, `unreviewed`. |
| Dissent | Dissidência | A recorded disagreement that survives the debate (shown to the human). |
| Patch | Patch | A concrete code change proposed by the implementer for one or more findings. |
| Verdict | Veredito | The council's decision: `approve`, `request_changes`, `comment`, with merge risk. |
| Human Decision | Decisão humana | The human accepting or dismissing a finding or patch. Always wins. |
| Publication | Publicação | Sending the accepted review back to the Source Control system. |

## 5. The council (personas)

Personas are **inspired by the published work and public engineering style**
of well-known authors. They are archetypes, not impersonations: the product
never claims to be these people.

| Persona | Role in protocol | Lens |
|---|---|---|
| **Solutions Architect** | Opening, Debate | Boundaries, coupling, dependency direction, DDD fit, scalability, operability. |
| **Staff Engineer** | Opening, Debate | Correctness, edge cases, concurrency, security, performance, test coverage. |
| **Refactoring School** *(inspired by Martin Fowler's "Refactoring")* | Opening, Debate | Code smells, named refactorings, small safe steps, evolutionary design, YAGNI. |
| **Clean Code School** *(inspired by Robert C. Martin's "Clean Code")* | Opening, Debate | SOLID, naming, function size, the Dependency Rule, TDD, boy-scout rule. |
| **Pragmatic Implementer** *(inspired by Linus Torvalds' engineering style)* | Implementation | "Talk is cheap, show me the code": simple data structures, no special cases, writes the patches, pushes back on bikeshedding. |
| **Moderator (CTO)** | Verdict | Weighs consensus and dissent, issues the verdict and tells the human where to look. |

The Refactoring and Clean Code schools are intentionally in productive
tension (e.g. "extract a function now, polymorphism when the third case
arrives" vs "apply the Open/Closed Principle now"). That tension is the
discussion the human gets to read.

## 6. Aggregates, entities, value objects

### Change Intelligence

* **ChangeSet** (aggregate root, immutable): `pullRequest` reference,
  `baseSha`, `headSha`, `files: FileChange[]`.
  * Invariant: file paths are unique.
  * Behaviour: `stats()`, `file(path)`, `isCommentable(path, line)`
    (a line can carry an inline comment only if it is inside a hunk on the
    new side), `riskProfile()`.
* **FileChange** (entity inside ChangeSet): `path`, `previousPath?`,
  `status` (`added | modified | removed | renamed`), `hunks: Hunk[]`,
  `additions`, `deletions`, `language`.
* **Hunk** (value object): `oldStart`, `oldLines`, `newStart`, `newLines`,
  `lines: DiffLine[]`.
* **RiskAssessment** (domain service): scores each file from size, sensitive
  paths (auth, payment, migrations, crypto, config), deleted tests, absence of
  tests for changed source, etc. Produces **Hotspots** and a suggested
  **review order**.

### Review Deliberation (core)

* **ReviewSession** (aggregate root, event-sourced). State is rebuilt from
  its events; commands are methods that validate invariants and emit events.
  * Lifecycle: `convened → opening → debate → implementation → verdict → concluded` (or `failed`).
  * Invariants:
    1. Rounds happen in order; a reviewer speaks at most once per round.
    2. A finding must be anchored to a file of the ChangeSet (or explicitly
       `general`); its line is re-anchored by quote when the model miscounts.
    3. A reviewer cannot take a position on its own finding.
    4. A patch must reference at least one existing finding and its
       `original` snippet must exist verbatim in the head version of the file.
    5. A verdict can only be issued once and only after the implementation round.
    6. **Policy override**: a verdict cannot `approve` while an *endorsed*
       `blocker` exists (the moderator's opinion is constrained by consensus).
    7. A human decision may override anything; it is recorded, never lost.
* **Finding** (entity): `id` (F-1…), `author`, `severity`, `category`,
  `location {path, line, quote}`, `title`, `rationale`, `recommendation`,
  `principle` (named refactoring/principle).
* **Position** (value object): `reviewer`, `findingId`, `stance`, `argument`.
* **Patch** (entity): `id` (P-1…), `findingIds`, `path`, `original`,
  `replacement`, `explanation`, `applicable`.
* **Verdict** (value object): `decision`, `mergeRisk`, `summary`,
  `humanAttention[]`, `overriddenByPolicy`.
* **ConsensusPolicy** (domain service): the author counts as an implicit
  `agree`; `refine` counts as qualified agreement.
  `endorsed` if support ≥ 2 and support > opposition; `rejected` if
  opposition > support; `contested` otherwise when anyone else spoke;
  `unreviewed` if nobody else took a position.

### Review Workspace

* **HumanDecision** (value object): `target` (finding or patch), `action`
  (`accept | dismiss`), `note`, `at`.
* Projections: PR inbox, session timeline, findings by file/line, patch
  previews, metrics (time saved).

## 7. Domain events (published language)

```
ReviewSessionConvened   {sessionId, pullRequest, changeSet summary, council, engine}
RoundStarted            {round}
ReviewerStartedThinking {reviewer, round}
StatementMade           {reviewer, round, text}
FindingRaised           {finding}
PositionTaken           {position}
ConsensusComputed       {findingId, consensus, support, opposition}
PatchProposed           {patch}
VerdictIssued           {verdict}
ReviewSessionConcluded  {durationMs, usage}
ReviewSessionFailed     {reason}
HumanDecisionRecorded   {decision}
ReviewPublished         {url, inlineComments, summaryOnly}
```

Events are the integration contract between the core and the workspace, they
stream live to the UI (Server-Sent Events), and they make every review
auditable and replayable.

## 8. The deliberation protocol

1. **Convene** — capture the ChangeSet snapshot, assess risk, seat the council.
2. **Opening round** (parallel) — Architect, Staff Engineer, Refactoring
   School and Clean Code School each review the change through their lens,
   make a statement and raise findings.
3. **Debate round** (parallel) — the reviewers read each other's findings and
   take positions (`agree / disagree / refine`) with arguments.
4. **Consensus** — `ConsensusPolicy` classifies every finding (deterministic,
   no model involved).
5. **Implementation round** — the Pragmatic Implementer writes patches for the
   endorsed findings worth fixing now, and says which ones it rejects and why.
6. **Verdict** — the Moderator issues the verdict; `VerdictPolicy` enforces
   invariant 6.
7. **Human decision & publication** — the human accepts/dismisses and
   publishes to GitHub as a review with inline comments and suggestions.

## 9. Out of scope for the MVP (next bets)

* Learning from human decisions (dismissed findings tune the council per repo).
* Org-specific personas and policies ("our architecture rules").
* GitLab / Azure DevOps / Bitbucket adapters.
* Re-review on new pushes showing *resolved* vs *still open* findings.
* SSO, multi-tenant billing.
