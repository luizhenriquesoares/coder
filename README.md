# CodeR

**A senior review council for every pull request, in an IDE-grade workspace.**

A tech lead cannot read every pull request. CodeR convenes a council of
specialised AI reviewers on each one. They examine the change through
different lenses, *debate* each other's findings, an implementer writes the
patches, and a moderator issues a verdict. You open one screen, see the code
that is going up, where the risk is and what the council agreed on, decide in
minutes, and publish the review to GitHub.

![The council in session: reviewers debating each other's findings next to the pull request](docs/images/session.png)

| A finding inside the code, with the debate beside it | The verdict, and where a human should look |
|---|---|
| ![A finding opened under the line it is about, with accept and dismiss](docs/images/finding.png) | ![The verdict stamp with the moderator's summary](docs/images/verdict.png) |

## Why a council and not a bot

1. **Several lenses.** Architecture, correctness and security, refactoring,
   clean code. One prompt cannot hold them all at full depth.
2. **Debate is the filter.** A finding that survives cross-examination is worth
   your time. One the panel argues against is probably noise. The consensus is
   computed by a deterministic rule, not by a model.
3. **Show the code.** The implementer turns what survived into patches you can
   preview on the file and publish as GitHub suggestions.
4. **You see why.** Every position, every dissent and every event of the
   session is on screen and stored.

| Seat | Speaks in | Lens |
|---|---|---|
| Solutions Architect | Opening, debate | Boundaries, coupling, dependency direction, data ownership, operability |
| Staff Engineer | Opening, debate | Correctness, edge cases, concurrency, security, performance, tests |
| Refactoring School | Opening, debate | Code smells, named refactorings, small safe steps, YAGNI |
| Clean Code School | Opening, debate | SOLID, naming, function size, the Dependency Rule, TDD |
| Pragmatic Implementer | Implementation | Writes the smallest patch that fixes it, declines what is not worth it |
| Moderator (CTO) | Verdict | Weighs consensus and dissent, tells the human where to look |

The Refactoring and Clean Code schools are in deliberate tension about when
an abstraction pays for itself. That argument is the discussion you get to
read.

The seats are archetypes inspired by published work and public engineering
style: Martin Fowler's *Refactoring*, Robert C. Martin's *Clean Code*, Linus
Torvalds' approach to patches. CodeR never claims to be, or to speak for, any
of these people.

## Try it in one minute

You need Node.js 22 or newer. Nothing else: no keys, no network.

```bash
npm install
npm run build
npm start
```

Open <http://127.0.0.1:4317>. Three sample pull requests are waiting. Open
"Add coupon support to checkout", press **Convene the council** and watch the
session. This is demo mode: a scripted council replays a real-looking session
on sample code, so it costs nothing and works offline.

There is also a single-file version of the demo, useful for sending to someone
or presenting without a server:

```bash
npm run build:demo
```

Then open `web/dist-standalone/coder-demo.html` in a browser. In that file the
whole application, the same domain and application code the server runs,
executes inside the browser tab.

## Use it on real pull requests

Copy `.env.example` to `.env` and fill in what you need. The file documents
every setting. Keep keys in that file only: it is ignored by git.

```bash
cp .env.example .env
```

| You set | You get |
|---|---|
| A Claude credential ([which one](#the-claude-credential)) | The real council: Claude reviews any pull request you open. |
| `GITHUB_TOKEN` | Private repositories and publishing reviews. A fine-grained token with *Pull requests: read and write* and *Contents: read-only*. |
| `GITHUB_REPOSITORIES=owner/repo,owner/other` | The open pull requests of those repositories in the inbox. |
| `AUTO_REVIEW=true` | The council reviews every new commit of every open, non-draft pull request, without anyone asking. |

Then `npm run build && npm start`.

- **One pull request, right now.** Paste its URL in the box above the inbox.
  Public pull requests can be read without a GitHub token, within GitHub's
  limit of 60 requests an hour: without a token the inbox re-reads GitHub
  every ten minutes, with one every minute.
- **A whole repository.** List it in `GITHUB_REPOSITORIES`.
- **Automatically.** With `AUTO_REVIEW=true` CodeR polls the listed
  repositories. Pull requests that were already open when it started are the
  baseline and are not reviewed, so switching it on never triggers a burst of
  paid reviews. A commit is reviewed once: CodeR asks its stored sessions, so
  a restart or a redelivered webhook does not pay twice, and a commit whose
  review failed twice is left alone. Pull requests that changed while CodeR
  was not running are not reviewed automatically. Instead of polling you can
  point a GitHub webhook (event *Pull requests*, content type
  `application/json`) at `POST /api/webhooks/github` and set
  `GITHUB_WEBHOOK_SECRET`.

### The Claude credential

CodeR calls the Claude API, so it needs a credential of a
[Claude Console](https://platform.claude.com) organization, or of a gateway
in front of one. That organization is where the usage is billed. Any one of
these will do:

| You set | What it is | Where it fits |
|---|---|---|
| `ANTHROPIC_AUTH_TOKEN_SSM_PARAMETER` | The name or ARN of a parameter of AWS Systems Manager Parameter Store that holds the auth token below. CodeR reads it when it starts, with the AWS credentials of the machine. | A token your team already keeps in AWS. |
| `ANTHROPIC_AUTH_TOKEN` | A bearer token. Either your LLM gateway's, with `ANTHROPIC_BASE_URL` pointing at the gateway, or a short-lived access token of your Console sign-in, which `ant auth print-credentials --env` prints ready for `.env`. | A gateway, or a first try. |
| `ANTHROPIC_PROFILE=default` | Your Console sign-in on this machine, made once with [`ant auth login`](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/authentication). No key is created and nothing is pasted anywhere. CodeR renews the token by itself until the sign-in runs out, some weeks later. | Your own machine. |
| `ANTHROPIC_API_KEY_SSM_PARAMETER` | The name or ARN of a parameter of AWS Systems Manager that holds the API key below, read at start-up like the token above. | A server on AWS. |
| `ANTHROPIC_API_KEY` | A static key from the [Console](https://platform.claude.com/settings/keys). | A server, with the key in its secret store. |

That is also CodeR's order of preference: with more than one set it uses the
first and warns about the others at start-up. The line it logs when it starts
listening names the kind of credential and the address of the API, never the
credential.

- **A Claude plan's login is not one of them.** What Claude Code signs in
  with, or a token from `claude setup-token`, is meant for Claude Code and
  Anthropic's own apps; a product that calls the API uses a Console
  credential ([Anthropic's rule](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)).
  CodeR cannot tell one token from the other by looking at it: it sends what
  you set, and the API is what refuses it. A Max, Ultra or Team plan does
  include
  [monthly API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)
  that you can claim for a Console organization, and CodeR runs on those like
  on any other credits.
- **Set `ANTHROPIC_PROFILE` in `.env`, not with `export`.** Claude Code reads
  the same variable, and with it exported would move to that sign-in and to
  its billing. It works the other way round too: a token, a profile or an
  address that your shell already exports for Claude Code is read by CodeR,
  and a token or a profile there comes before the key in `.env`.
- **Paste a key or a token alone, on one line.** CodeR does not start on a
  value with a space, a quote or a line break in it, and says so by the name
  of the variable, without printing the value. A value on the
  `ANTHROPIC_PROFILE` line that looks like a key or a token, by how it begins
  or by its length, is refused the same way. Only the credential CodeR uses
  is held to this: a placeholder on a line it sets aside stops nothing.
- **A token or a key kept in AWS Systems Manager** is read once, at start-up, and
  then treated like one pasted in `.env`. A parameter that holds the token
  of a Claude plan (Claude Code's, from `claude setup-token`) is no more
  usable this way than the same token pasted in `.env`. CodeR finds the AWS credentials as
  the AWS CLI does: the `AWS_*` variables, a profile of `~/.aws` (with
  `AWS_PROFILE`), a single sign-on session, or the role of the instance,
  container or function it runs in. The region is the one in the parameter's
  ARN, else `AWS_REGION`, else `AWS_DEFAULT_REGION`, else the profile's. That
  identity needs `ssm:GetParameter` on the parameter, and `kms:Decrypt` on its
  key when the key is one of your own rather than the default `aws/ssm`. A
  parameter that cannot be read stops the start with what AWS refused and
  what to change; a token kept as a plain `String` instead of a
  `SecureString` is used, with a warning. A new value in the parameter is
  read at the next start. `AWS_ENDPOINT_URL_SSM` points CodeR at a VPC
  endpoint, over https.
- **A sign-in that could not work stops CodeR at start-up**, with the command
  or the change that fixes it: no sign-in under that name on this machine,
  settings that cannot be read, tokens that are missing or that other users
  of the machine can read, a tokens directory CodeR cannot write to (a
  renewed token is saved there), or an address that would carry the sign-in
  over plain http to another machine. A profile that holds a workload
  identity federation is refused as well: CodeR does not take those yet.
  Whether the tokens still work is for the API to say, at the first review.
- **When a credential fails during a review**, the reviewer's place in the
  session says which credential it was and what to do. For a credential the
  API refuses, that is the API's own reason and the fix: a new token,
  `ant auth login` again, or another key. For a sign-in that could not be
  renewed, it is the status the token endpoint answered. For a sign-in whose
  stored tokens can no longer be used, it is what became of them, without
  the path of the file. What the API denies, does not find or will not take
  (an organization without credits, for one) is passed on in the API's words.
- **A key or a token that the other side repeats is taken out** before the
  text is logged or stored. CodeR learns them as they leave: what a request
  carries in a header that authenticates, whichever variable or file it came
  from, and the refresh token of a renewal. Anything shaped like a key or a
  token of Anthropic's is taken out as well.
- **Where the requests go.** Reviews go to `ANTHROPIC_BASE_URL`. Without it,
  a sign-in sends them to the address in its own settings when they name
  one, and everything else goes to Anthropic. A sign-in is renewed at the
  address in its settings when they name one, and where the reviews go
  otherwise. The SDK that sends them also reads `ANTHROPIC_CUSTOM_HEADERS`:
  a credential written there goes out as written, over or next to the one
  CodeR chose. CodeR warns about it at start-up, and a refusal of the API
  then says to look at that variable first.

**Cost.** A session is ten model calls: four opening statements, four debate
statements, the implementer and the moderator. The pull request is sent once
and the other nine calls read it from the prompt cache. The status bar shows
the tokens and the estimated cost of each session. `CODER_MODEL` and
`CODER_EFFORT` are the two dials. At most four councils deliberate at once,
and a reviewer that does not answer within fifteen minutes is recorded as
failed while the others go on.

## How a review works

```
convene ──▶ opening ──▶ debate ──▶ consensus ──▶ implementation ──▶ verdict ──▶ you ──▶ GitHub
            4 lenses    positions   a rule,       patches for        moderator   accept,   one review,
            in parallel on each     no model      what survived      + policy    dismiss   inline comments
                        other's                                                            and suggestions
                        findings
```

**Consensus** is a rule over the positions the other reviewers took. The
author of a finding counts as support. A finding is *endorsed* when support
outweighs opposition by two or more, *rejected* when opposition is larger,
*contested* in between, and *unreviewed* if nobody else spoke.

**The verdict is bounded by consensus.** The council cannot approve while an
endorsed blocker exists, cannot request changes without an endorsed blocker
or major finding to ground it, and the merge risk is never lower than what
the endorsed findings imply. When the policy overrides the moderator, the
review says so.

**You decide.** Once the council has concluded, accept or dismiss any finding
or patch. Your decision always wins over the council's, and that includes the
outcome: accept a blocker the council had left contested and an approval is
published as a request for changes; dismiss everything that grounded a
request for changes and it is published as a comment. The publish bar tells
you which, before you press the button.

**What gets published.** A finding is published when you accepted it, or when
the council endorsed it and you did not dismiss it. It becomes an inline
comment when its line is part of the diff and was confirmed in the file,
otherwise it goes into the review summary. A patch becomes a GitHub
suggestion the author can commit with one click, made of exactly the lines
you previewed. A session is published once, and only against the commit it
reviewed: if the pull request has new commits, CodeR refuses and asks you to
convene the council again. If the server stops in the middle of publishing,
CodeR records that the outcome is unknown and asks you to look at the pull
request before publishing again.

## The workspace

- **Inbox** with the state of each pull request: not reviewed, in session,
  the verdict, new commits since the review.
- **Overview**: risk score, an estimate of what a careful human review would
  take, the verdict, and the files to read first.
- **Diff editor** (the editor VS Code is built on) side by side or inline,
  unchanged regions folded, findings marked in the gutter. Selecting a finding
  opens its card under the line.
- **With council patches**: the same file after the implementer's patches.
- **Council chamber**: the live transcript, the findings by consensus level,
  the patches, and the publish bar.
- **Session log**: every domain event of the session, in order.
- English and Portuguese, dark and light, and a phone layout.

| Key | |
|---|---|
| `n` / `p` | Next and previous finding |
| `a` / `d` | Accept or dismiss the selected finding |
| `o` | Overview |
| `l` | Session log |
| `?` | Shortcuts |

## Security notes

- The server listens on `127.0.0.1`, and without a token it only answers
  requests made on that machine: a request with a foreign `Host` or `Origin`
  is refused, so a web page open in your browser cannot reach the API.
- To expose it, set `HOST` **and** `CODER_API_TOKEN`; the server refuses to
  start on any other address without a token. Every API call must then carry
  `Authorization: Bearer <token>`. Only `GET /api/health` and the signed
  webhook are outside that rule.
- Webhooks are accepted only when `GITHUB_WEBHOOK_SECRET` is set, and their
  signature is verified over the raw bytes.
- Pull request titles, descriptions and file contents are written by the pull
  request's author. They are given to the models as material to review, in
  the user turn and inside a boundary the author cannot forge, never as
  instructions. Text the models write cannot mention people or link issues
  when it is published. Treat the output as a review to read, which is why
  nothing is published without a person pressing the button, except what you
  opt into with `AUTO_REVIEW` (which reviews, and still does not publish).
- Keys live in `.env` on your machine. They are never sent to the browser.
- Session logs are files under `CODER_DATA_DIR`. A file that was damaged is
  set aside as `<name>.corrupt` and reported at start-up; it is never read as
  a shorter history.

## What is verified, and what is not

| | |
|---|---|
| The whole codebase | Reviewed by the council itself before the first release: 34 findings, all endorsed. See [docs/COUNCIL_REVIEW.md](docs/COUNCIL_REVIEW.md) for what was fixed and what was deferred |
| Domain rules, protocol, consensus, verdict policy, patching, publication planning | Unit tests |
| Demo council end to end, in English and Portuguese | Tests, plus the browser at desktop, wide and phone sizes, in both themes |
| The workspace | Its rules and its reducer are unit tested; the screens were driven in a browser (convene, decide, preview, publish, a stale pull request, a lost connection). The React components have no automated tests yet |
| Server over HTTP with live event streaming, the access guards, restart recovery, webhooks, import by URL | Tests against a running server, through the same HTTP client the workspace uses |
| Event log, inbox caching, automatic review | Tests for a failed write, a torn file, a rate-limited listing, a restart |
| Every push | GitHub Actions runs the type check, the tests and both builds |
| Claude council | Tests drive the official SDK against a local server that speaks the Messages API streaming wire format: request shape, prompt caching order, model fallback, refusals, truncation, a rejected key |
| GitHub adapter | Tests drive Octokit against a local server that speaks the REST API: pagination, merge base, file contents, publishing, and GitHub refusing a review |
| **The real Anthropic and GitHub APIs** | **Not exercised yet.** This build was made in an environment without credentials. Expect to adjust details the first time you run it with real keys. |

```bash
npm test          # 243 tests
npm run typecheck
```

## Development

```bash
npm run dev        # API on :4317 with reload, web on :5173 with hot reload
npm run build      # web/dist and dist
npm run build:demo # web/dist-standalone/coder-demo.html, one self-contained file
```

```
src/domain/          the business: change sets and risk, the review session, policies
src/application/     use cases and ports (what the application needs from the outside)
src/infrastructure/  adapters: Claude, GitHub, HTTP, persistence, the scripted demo
src/composition/     where adapters are wired to the application (server, standalone)
web/src/             the workspace (React, Monaco)
tests/               everything above, without the network
docs/                the domain model, the architecture, and the council's review of this code
```

Read next:

- [docs/DOMAIN.md](docs/DOMAIN.md): the business problem, the ubiquitous
  language, bounded contexts, aggregates, events and the protocol. Written
  before the code.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the code is organised and
  why.
- [docs/COUNCIL_REVIEW.md](docs/COUNCIL_REVIEW.md): the council reviewed its
  own codebase. Findings, debate, verdict and what was fixed.

## Roadmap

- Learn from human decisions: what a team dismisses tunes its council.
- Team-specific seats and policies ("our architecture rules").
- Re-review on new commits: resolved versus still open.
- Link findings that describe the same defect, so independent discovery by
  several reviewers counts as the evidence it is.
- A sandbox where a reviewer can run the change and attach a reproduction.
- GitLab, Azure DevOps and Bitbucket adapters.
- A database-backed event store, sign-in and multi-tenant operation.

## Em português

O CodeR reúne um conselho de revisores de IA para cada pull request. Eles
analisam a mudança por lentes diferentes (arquitetura, correção e segurança,
refatoração, clean code), debatem os achados uns dos outros, um implementador
escreve os patches e um moderador dá o veredito. Você vê tudo em uma tela com
cara de IDE, decide em minutos e publica a revisão no GitHub.

Para ver funcionando, sem chave e sem internet:

```bash
npm install
npm run build
npm start        # abra http://127.0.0.1:4317
```

Para usar com PRs de verdade, copie `.env.example` para `.env` e preencha
uma credencial do Claude, `GITHUB_TOKEN` e `GITHUB_REPOSITORIES`. O que você
escreve nesse arquivo fica só nele, na sua máquina. A interface tem
português: use o seletor EN/PT no topo.

A credencial do Claude não precisa ser uma chave de API. Na ordem em que o
CodeR prefere: `ANTHROPIC_AUTH_TOKEN_SSM_PARAMETER` (o nome do parâmetro do AWS
Systems Manager onde o token está guardado: o CodeR lê na partida, com as
credenciais AWS da máquina ou da role; `ANTHROPIC_API_KEY_SSM_PARAMETER` faz
o mesmo para uma chave de API), `ANTHROPIC_AUTH_TOKEN` (um token de
acesso, ou o token do seu gateway), `ANTHROPIC_PROFILE=default` (o login da Claude Console feito uma
vez com `ant auth login`, sem chave e renovado sozinho; os tokens desse login
ficam na pasta do próprio `ant`, não no `.env`) ou `ANTHROPIC_API_KEY`. Cole
a chave ou o token sozinho, em uma linha só: com espaço, aspas ou quebra de
linha o CodeR não inicia. O login de um plano Claude, o que o Claude Code
usa, não serve: é reservado ao Claude Code e aos apps da Anthropic. Os
detalhes estão em [The Claude credential](#the-claude-credential).

O próprio conselho revisou este código antes da primeira versão: 34 achados,
todos endossados, corrigidos ou adiados com justificativa. O registro está em
[docs/COUNCIL_REVIEW.md](docs/COUNCIL_REVIEW.md).
