# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.26.1 - 2026-08-08

Nothing in the binary changed. Almost every fix here is in
`scripts/deploy/smoke.sh`, the script that stands between a release and the
claim that the release is good — and they were found by chasing a test that
failed once in ten runs rather than dismissing it as noise.

### Fixed

- **The OpenAPI regeneration instruction produced an unreviewable diff.** The
  command the snapshot test prints when it goes stale wrote the document
  indented. Prettier 3 preserves an object's expansion when the input already
  had a line break inside it, so that formatting survived untouched and turned
  a 1,500-line document into 8,800 — in the one file whose entire justification
  is that its diffs get read in review. Nothing caught it: the tests compare
  parsed JSON, and the re-inflated document is byte-different but semantically
  identical, so it would have passed the gate and landed. The command now
  writes compact JSON and lets `bun run format` do the layout, which makes the
  diff for a one-word change one line.

- **A green tick over a check that was never made.** `/metrics` is
  unauthenticated by design and has to be gated by the reverse proxy, so the
  check asked for it from outside and treated anything other than `200` as
  proof of gating. But `000` is not a status — it is curl reporting that it
  never got an answer at all, and it is equally what a firewall dropping the
  packet and a broken network look like. Only the first of those is the
  deployment being correct, and nothing at that point can tell them apart. The
  run now says so and counts it as skipped. This is the third false green found
  in this file and the same shape as the other two: a check whose passing
  condition was the absence of bad news rather than the presence of good news.

- **An unreachable installation reported none of its checks.** `set -e` killed
  the script inside the first command substitution, so a host that did not
  answer produced one raw curl line and no list — on precisely the deployment
  somebody most needs the list for. A connection failure is now data, like a
  body's, so every check is asked, each says `got 000`, and the summary still
  prints.

- **A restart the script was too impatient for.** It runs seconds after the
  deployer moves a binary into place and restarts the unit, which is exactly
  when a connection refused means "still coming up" rather than "broken" —
  and it believed the first attempt. Connection-level failures are now retried
  (`SMOKE_CONNECT_RETRIES`, default 2), which also removes the flake this
  release started with: an occasional refusal against a loopback fixture under
  load made `bun run gate` non-deterministic, and a gate people re-run instead
  of read has stopped being a gate.

### Known

- **The page list and the linter disagree about the same pages, and 0.26.0's
  reasoning for the new rule was measured on the wrong one of them.** That entry
  motivated `unsourced-concepts` with "roughly a third of published pages carry
  no claims at all". That number came from the concept list, which counts every
  page. The rule counts a smaller set: it excludes revisions marked as import
  scaffolding. Held against a real installation of sixteen wikis, the list
  reports about fifty pages with no evidence and the rule reports thirteen — so
  the sentence is true about the list and misleading about the rule it was
  written to justify.

  The gap is not an error in either query; both do what they say. It is that
  two surfaces answer the same question differently, which is exactly what the
  same entry promised to avoid when it aligned search with the list. An
  operator looking at one wiki sees twenty-four pages reported with `sources: 0`
  in the index, opens the linter to find out what to do about them, and is told
  nothing is wrong.

  The excluded pages are not invisible furniture, either. They carry a title,
  they appear in the index, a reader can open them, and they are blank — their
  summary says they were created as targets for relations imported from
  elsewhere, and they now have no relations at all. Calling them "never a page
  anybody wrote to be read" describes where they came from, not what they are
  now.

  This is left open deliberately rather than settled here, because every way of
  closing it changes what an operator's linter says about their own wikis, and
  the three candidates differ in kind: report them as unsourced like any other
  page; give them their own rule that names what is actually wrong with them
  (leftover import stub — delete it, rather than "ingest a source"); or keep the
  exclusion and have the index stop presenting their zero as if it were a
  knowledge page's zero, the way a search hit omits evidence rather than
  reporting it as zero. Related: the exclusion list in `src/domain/lint.ts`
  hardcodes one installation's private migration tag, which is a fact about a
  particular deployment living in a product that otherwise knows nothing about
  where it runs.

### Added

- **The `/metrics` gate is now actually exercised.** It was the one check a
  loopback fixture skipped, so no test had ever run it — an unexercised check
  in a script whose whole job is to be exercised is the same bet as no check at
  all. `SMOKE_PROXIED=1` forces the judged branch, and all four outcomes
  (skipped on loopback, pass, open endpoint, no response) are now pinned.

## 0.26.0 - 2026-08-08

This release closes both items 0.24.0 left under **Known** — the `contradictions`
lint rule reading only half of a space's predicate declarations, and `/mcp` and
the OAuth plane accepting work from a draining process. Neither reappears below.

### Added

- **The linter now names the pages nothing archived stands behind.** 0.25.0 made
  this countable per page and the first thing it showed on a real installation
  was that roughly a third of published pages carry no claims at all — but the
  linter, which is where an operator goes to find out what needs attention, had
  no way to say so. It had a rule for a page nothing _links to_ and none for a
  page nothing _backs_.

  `unsourced-concepts` reports every readable page across whose visible claims
  there is not one citation, and says which of the two shapes it is: a page that
  makes no claims at all, or a page that makes claims and quotes nothing for any
  of them. Same fix in both cases — ingest a source and let synthesis quote it —
  but a different amount of prose is already at risk, so the count is in the
  line.

  It is a **warning**, deliberately between its neighbours. Not an error: a page
  somebody typed by hand is a legitimate thing to have in a wiki, the three
  error rules all describe states that are simply wrong, and a rule that shouts
  at a legitimate state is a rule an operator turns off — turning CI red on
  every installation the day it upgrades is not a call a lint rule may make on
  an operator's behalf. Not information: `info` is where "noticed, nothing
  expected of you" lives, and this one names an action which is the product's
  entire loop.

  A page with no claims trips both this rule and `empty-concepts`, and that is
  intended rather than an oversight. The information line records a stub; this
  one records that nothing archived stands behind it and says what would fix it.
  Suppressing either would make a page's reported severity depend on which rule
  reached it first, and would hide the actionable line behind the passive one.
  The counts in a lint report are a census of findings, never a headcount of
  pages.

- **Webhook delivery history can be asked for in full.** The deliveries list was
  the only list in this API with no `limit` parameter, so it answered fifty rows
  and there was no way to ask for more — including from its own console page,
  which had to state a ceiling it could not raise. Debugging an endpoint that
  had been failing for a while meant reading the most recent fifty attempts and
  guessing at the rest.

  `GET /v1/spaces/{space}/webhooks/{id}/deliveries` now takes `?limit=`, default
  fifty and up to two hundred, matching every other list here; the console asks
  for the ceiling. It is a bigger window and not pagination — there is still no
  cursor, and the page still says so rather than implying the history it shows
  is all of it.

- **Search results now say how well each page is evidenced.** 0.25.0 gave the
  page index three numbers per row — how many claims a page makes, how many of
  those quote nothing, and how many archived documents stand behind it — so a
  reader could tell, before spending a click, which pages the archive supports.
  Search was the other place that choice gets made, and it was still silent: a
  ranked headline tells you a page matched, never how the wiki knows what it
  says. Same question, same gap, one surface later.

  Every hit of `GET /v1/spaces/{space}/search` with `kind: "concept"` — and the
  same hits through the `wikikit_search` MCP tool — now carries the same
  `evidence` object the list carries, counted by the same aggregate over the
  same visible claims. A page therefore reports identical numbers whether it is
  found by browsing or by searching; two surfaces disagreeing about one page
  would not read as two code paths, it would read as a wiki that does not know
  what it holds.

  Two kinds of hit deliberately carry nothing. A **claim** hit raises a
  different question — "is _this_ claim quoted?" — which none of the three
  numbers answers; lending it the page's totals would put `claims: 12` on a
  single claim and invite `uncited_claims` to be read as a verdict on the
  matched one. A **source-evidence** hit is an archived paragraph nobody has
  reviewed, and its tier label exists to say exactly that: an evidence summary
  there would dress unapproved material in the badge of a curated page, which
  is the worst misreading this field admits. Absence therefore never means
  zero — where the object is served, `claims: 0` is a measured page that cites
  nothing, still the state this feature exists to make visible.

  The cost is one extra statement, issued only when a response actually holds
  concept hits, over at most the 50 slugs a search can return — a quarter of
  what the index already counts in a single statement. A search filtered to
  claims, or one that matches nothing, costs exactly what it cost before.

### Fixed

- **The contradiction warning on a review told some wikis nothing and other
  wikis the wrong thing.** It is the third surface on the review screen that
  answers "will approving this hurt?", and it was the last one still carrying
  its own copy of the rule. That copy read only the older of the two ways a
  space can declare which predicates hold a single value — so a wiki declaring
  them through the typed registry got **no contradiction findings at all**, and
  one declaring them the older way got findings for changes approval would not
  actually dispute. Both failures were silent: a query reading the wrong half of
  a settings object never errors, it just returns nothing.

  It now resolves the declaration through the same helper the proposal diff and
  the space-wide lint already use, which reads both, and it applies the same
  refinements approval itself applies. A frame split by context (`region:eu`
  against `region:us`), two values that are canonically the same thing (`1 GiB`
  against `1024 MiB`), two facts whose validity periods do not overlap, a
  reviewer's explicit "these complement each other", and a change that says
  outright which claim it supersedes are none of them contradictions, and
  approval never treated them as such. The message promises "approval disputes
  both", and that is now true of everything it reports.

- **A console tab left open through a long review signed you out mid-edit.** The
  session cookie renews on a read of the session, and the console only made that
  read when it loaded — so a tab focused all day never renewed anything, and the
  idle window expired underneath somebody who had been working in it the whole
  time. 0.24.0 documented this as the cost of the design; it was not.

  A visible tab now re-reads its session every ten minutes, and a hidden one
  re-reads on return. A hidden tab deliberately does **not** renew itself on the
  timer: the idle window exists so that an unattended session dies on schedule,
  and a minimized tab quietly renewing every ten minutes would convert every
  eight-hour idle window into the twenty-four-hour absolute cap for anybody who
  never closes a tab. The absolute cap is unchanged and still ends the session
  where it stands.

  Turning the renewal on exposed a worse failure that had been latent: the gate
  checked for an error before it looked at the answer it already had, so a
  single failed renewal — one blip, on a session the server never stopped
  honouring — would have replaced the whole console with "Could not reach
  WikiKit" and taken every unsubmitted edit with it. A known answer now outranks
  a failed attempt. A session that genuinely ended still signs the console out
  immediately; that is an answer, not a failure.

- **An identity's email could not be cleared, and the form said nothing.** The
  column is nullable, `''` is not `NULL`, and the update path kept every field
  the body left out — so an operator deleting a stale address closed the dialog
  on a request that changed nothing, with no error to tell it apart from
  success. 0.24.0 fixed exactly this for `display_name` and left this one
  pinned by a test that recorded why: the wire type had no way to say "clear
  it".

  It has one now. On `PUT /v1/identities/{provider}/{subject}`, `email` carries
  three states rather than two: absent keeps the stored address, `null` clears
  it, a string sets it. `null` rather than `''` because `NULL` is already what
  this column means by "no email" — the SSO callback writes it whenever the
  provider asserts no verified address — and a nullable column holding two
  kinds of empty is a distinction every reader downstream would have to carry
  forever. `''` is now refused (`400`) for the same reason. It is not a new
  convention either: this API already reads an explicit `null` as a value and
  an absent key as "leave it alone", on `base_revision_id` in a staged concept.
  `display_name` keeps the opposite spelling, because its column is NOT NULL
  with an empty default, so `''` is already what clears it.

- **The grant dialog announced a grant while the server performed an edit.**
  The console chose its wording from which button was pressed; the server
  decides by whether the row exists. Type the provider and subject of somebody
  who is already admitted into "Grant access" and the two disagreed — the
  dialog promised a new grant, and the request replaced a scope ceiling that
  person already held, which is the one case where the wrong word is dangerous.

  The dialog now reads the list the page has already loaded, so it can tell
  what the server will do without asking it: the title and the button say
  "Change what this person reaches" and "Set ceiling" the moment the typed
  identity matches an admitted row, and a warning names the ceiling that is
  about to be replaced — including the empty one, which reads as the lockout it
  is. It stays a warning and never a refusal: re-granting somebody from the top
  of the page is a legitimate thing to do, and a console that blocked it would
  be wrong in the other direction. A revoked match still points at Restore,
  where the server would answer `409`.

- **A draining process still took new agents and minted new tokens.** `/mcp`
  and the whole OAuth/session plane are mounted raw, ahead of the drain gate,
  so for the entire shutdown window an agent could open a session or a client
  could mint a token on an instance that was seconds from tearing both down —
  while the identical operation over REST got a clean `503 draining` and
  retried against an instance that was staying up. 0.24.0 wrote it down rather
  than fixing it, because the fix is not a reordering: it is deciding what a
  refusal sounds like in a protocol that is not HTTP. That decision is made.

  `/mcp` now refuses on every method, as a 503 carrying a **JSON-RPC error
  frame** rather than WikiKit's HTTP envelope. The status is for the load
  balancer, which reads statuses; the frame is for the client, which reads
  bodies as JSON-RPC messages and would have reported the envelope as a parse
  error — and a client that believes the server is broken does not retry
  somewhere else, which is the one outcome this refusal exists to prevent. The
  shape is the one WikiKit's own transport guards already use for a bad Origin
  and an unsupported protocol version, so no client learns anything new.

  The OAuth/session plane splits, and the line is not browser-versus-machine —
  it is who can act on the refusal. A program that gets a 503 retries, and
  every row its flow depends on is in the Postgres all the instances share, so
  the retry resumes rather than restarts: discovery, registration, the
  identity-assertion exchange, the token mint and its revocation all refuse. A
  human halfway through a redirect chain cannot retry — the login state they
  carry is single-use and already consumed, so a 503 at the callback means
  "sign in again from the start", announced by a blank page to the operator
  most likely to be watching the deploy that caused it. The sign-in funnel and
  the consent screen therefore finish what they started. The two halves compose
  because of that shared database: consent completed on the draining instance
  is exchanged for a token, one refusal and one retry later, against a live one
  reading the same row.

  The console keeps serving throughout, which was never in doubt. It is static,
  it holds no knowledge, and the API calls it makes are ordinary routes that do
  hit the gate — so it degrades to reporting the drain, which is true, instead
  of going blank, which reads as broken at precisely the wrong moment.

  Each raw mount now states its drain policy where it is mounted, and stating
  it is mandatory: there is no default, because a default would be a shutdown
  decision made silently for every mount added later.

- **The metrics label was computed twice and could disagree with itself.** The
  route label a request was counted, logged and billed under was recomputed
  after the response, by re-running the route table against a plain split of
  `req.url` — while the request had been dispatched on a properly resolved URL.
  The two differ for a path with dot segments and for the absolute-form request
  line a proxy may send, so a request served as `/v1/spaces/{space}` could be
  recorded as `(unmatched)`. The label is now written once, by the code that
  made the decision, and only read afterwards.

  What that does not change, deliberately: an unknown path answers `404` while
  draining exactly as it does otherwise, and is counted the same way. Nothing
  was refused — the path does not exist on this build and will not exist on the
  next one — so there is nothing to attribute to the drain. Refusals are
  attributable: they are `status="503"` under the refusing route's own label,
  next to `route="/ready"`. Drain volume is that series, never a delta in the
  404 bucket.

- **The deployment guide told operators a rollback was safe that no longer is.**
  `docs/DEPLOYMENT.md` still carried the release note of a much earlier version:
  it named a specific tag as "this change", and it stated that rolling back to
  v0.4 stayed schema-compatible because one nullable column and one defaulted
  function argument made it so. That was true when it was written and has not
  been for more than twenty migrations — an operator following it during an
  incident would have put a binary that predates most of the schema in front of
  a database that has all of it. The version-specific framing is gone, and the
  rollback guidance now says what actually holds: one release at a time, and
  only where that release's entry here says so.

### Known

- **A console tab left visible on an unattended machine now renews itself until
  the absolute cap.** This is the cost of the session fix above, stated plainly
  rather than buried: the renewal fires while the browser reports the tab as
  visible, and a browser cannot report whether a person is in front of it. Before
  this release such a tab would have been signed out by the idle window; now the
  twenty-four-hour absolute cap is the only bound on it, and that bound does
  still hold — it is stamped from the session's own expiry and no amount of
  renewing moves it.

  The narrower reading was rejected on purpose. A hidden tab does not renew, so
  a closed laptop still dies on the idle schedule; catching the unattended-but-
  visible case would mean inferring presence from input events, which is a
  guess, and a session that ends on a guess ends in the middle of somebody's
  review. Operators who need the shorter bound should shorten the absolute cap,
  which is the control that actually means what it says.

## 0.25.0 - 2026-08-08

### Added

- **The page list now says how well each page is evidenced.** WikiKit's premise
  is that every claim on a page carries a verbatim quote from an archived
  source. Until now the index would not tell you whether a given page honoured
  that. "How does this wiki know this?" — the first question a reader has, and
  the one this product exists to answer — could only be answered by opening the
  page, and then the next one, and then the one after that. The owner of an
  installation asked why the list was silent about the only thing that
  distinguishes a WikiKit page from a paragraph somebody typed. It no longer is.

  Every row of `GET /v1/spaces/{space}/concepts` now carries an `evidence`
  object of three numbers: **`claims`**, how many claims the page makes;
  **`uncited_claims`**, how many of those have no quote behind them; and
  **`sources`**, how many distinct archived documents the page draws on. Only
  visible claims are counted — `verified`, `disputed` and `deprecated` — never a
  `proposed` or `draft` one, because counting staged work would let an
  unreviewed change make a page look evidenced before anybody agreed it was.
  The three answer different questions and none is derivable from the others:
  five claims quoting one document and five quoting five are the same
  `uncited_claims` and very different pages.

  The state this makes visible for the first time is the **page written by hand
  that cites nothing at all** — zero claims, zero sources. It is a legitimate
  thing to have in a wiki, and it was also completely indistinguishable from a
  fully sourced page in every list WikiKit had ever drawn. It now reads as a
  measured `0` and is flagged in the console, which is the point: a reader can
  see, before spending a click, which pages the archive stands behind and which
  are somebody's memory. `0` is an answer here, never a blank — the console
  keeps its em dash for the row whose counts genuinely never arrived.

  The cockpit's page index gains a sortable **Evidence** column built on those
  numbers, placed second so it survives a narrow screen. It costs nothing extra
  to draw: the counts ride along on the list read the console was already
  making, in the same single statement, so a wiki of any size still answers the
  index in the queries it answered it in before.

## 0.24.0 - 2026-08-08

### Fixed

A second adversarial review, this time of the console shipped in 0.22.0 and of
the credential plane underneath it. Nothing here was visible to the gate — the
recurring theme is a surface that states something the server does not do, which
no assertion about the server can catch.

- **A crafted sign-in link ended the attempt on a 500 and burned it.**
  `GET /v1/identity/cockpit-login?return_to=…` rejected CR and LF and nothing
  else, but node's `res.setHeader` throws on any other non-printable code point
  too — and the single-use login state is marked consumed _before_ the redirect
  is built. So a link carrying a NUL, a DEL or a stray `U+2028` answered an
  operator's sign-in with a 500, with the attempt already spent and the page
  explaining nothing. A `return_to` is now printable ASCII or it is not used;
  the console builds it out of an already percent-encoded `location.pathname`,
  so nothing legitimate arrives outside that range. A refusal was never an
  error — the operator still lands signed in, one navigation from where they
  meant to be.

- **Working continuously signed you out after eight hours.** The session row's
  idle deadline slid on every authenticated read, exactly as documented, but the
  cookie's `Max-Age` was written once at sign-in and re-written only by
  login, consent and sign-out. The browser therefore dropped a cookie whose
  session was still alive — eight hours in, typically mid-review.
  `GET /v1/session` now re-stamps the same token with the deadline the renewing
  UPDATE actually returned, so the documented idle window is true on the browser
  side too and the 24-hour absolute cap still cannot be read past: the `Max-Age`
  comes from what `least(absolute_expires_at, …)` wrote, never from a fresh
  clock. It renews when the console loads rather than on a timer, so a single
  tab left open past the cap still needs a reload.

- **The cockpit's sign-in door was the cheapest row in the system to create from
  outside.** It takes no client, no credential and no consent, and every request
  past the already-signed-in check inserted a ten-minute login state while the
  housekeeping sweep only collects hourly. It is now metered per remote address
  like dynamic client registration, at twenty a minute — charged _after_ that
  short-circuit, so an operator moving around their own console never spends a
  slot, and set above the DCR limit because with `WIKIKIT_TRUST_PROXY` off a
  whole office behind one NAT shares a single bucket. The refusal renders as an
  HTML page in the same shell as every other funnel error, and `docs/openapi.json`
  now documents that 429 — along with the one `POST /v1/oauth/register` has been
  answering, undocumented, since it grew a limit.

- **A pending change showed disputes that approving it would not produce.** The
  review diff flagged a claim as colliding whenever any visible claim shared its
  subject and predicate with a different object. Approval disputes far less than
  that: only predicates the wiki has _declared_ functional, only inside the same
  context, only where the normalized values differ, only where the validity
  intervals overlap, and never across an adjudicated complement or an explicit
  supersession. The declared set is empty until somebody declares one, so in most
  wikis every ordinary multi-valued claim wore a `disputed` badge — in the diff
  and in the rendered review Markdown both — and then approval disputed nothing.
  The flag now carries every condition the apply applies, which also settles a
  standing disagreement with the `contradictions_count` the
  `wikikit.proposal.created` event reports about the same change.

- **The Split confirmation promised the wrong number of changes.** It counted one
  new pending change per page, but the server adds one more — a
  `<title> — decisions` child — whenever the change carries decisions or leaves
  relation removals stranded on pages it is not splitting out. The dialog and the
  toast that followed it described different events. The dialog now counts that
  child under the same rule the server uses, and names it.

- **A change's claim review advertised a "retired" state that could not occur.**
  Every group it renders is derived from the same staged set, so the branch was
  unreachable; the field and its documentation are gone rather than left as a
  promise.

- **Emptying an identity's display name did nothing.** The console omitted the
  field when it was blank and the server reads an omitted field as "keep what is
  stored", so an operator could clear the box, save, and watch the old name come
  back. Editing a grant now sends the empty string, which the column takes;
  creating one still omits it, because there is nothing to clear on a row that
  does not exist. Clearing an **email** is still a no-op and cannot be fixed from
  the console — the request type has no way to say "make this null" — so the
  current behaviour is pinned by a test until the contract grows one.

- **Re-submitting a page after somebody else changed it returned the stale
  change.** The console dedups a submission by hashing what it is submitting, and
  the base revision was not in the hash — so identical text staged against a page
  that had moved underneath handed back the earlier proposal, written against the
  old base, instead of staging a new one. The base is part of the anchor now. One
  consequence: a change staged by an older console and still pending across this
  upgrade will not dedup the first time it is resubmitted.

- **Three console lists claimed to show everything while showing a page.** The
  webhook delivery log said "every attempt WikiKit has made" over the fifty
  newest — the exact sentence that misleads the operator arriving with "our
  webhooks stopped last Tuesday". Connector streams took the server's default of
  fifty when two hundred were available, with Forget living in the row, so a
  stream past the ceiling could be neither seen nor forgotten. Search reported a
  per-tier count that read as a total. Streams now ask for the full two hundred,
  and all three state the ceiling when the answer comes back full and stay quiet
  when it does not. The delivery endpoint is the only list in this API with no
  `limit` parameter at all, so fifty stands there until it grows one.

- **The sidebar forgot it was collapsed.** The vendored component wrote a
  `sidebar_state` cookie nothing in this console ever read — upstream expects a
  server to read it back — so the sidebar sprang open on every reload while a
  dead cookie rode every `/v1/*` and `/mcp` request. The preference is kept in
  `localStorage` now, read before first paint so there is no flash, and sent
  nowhere.

- **The post-deploy smoke test would have passed a policy that allows inline
  script.** `scripts/deploy/smoke.sh` looked for `unsafe-inline` immediately
  after `script-src`, but the served directive is `script-src 'self' 'sha256-…'`
  — so the regression the check exists to catch, a source _appended_ to it,
  matched neither pattern and got a green tick. The hash check had the mirror
  flaw and would have failed a correct deployment with anything inserted before
  the hash. Both now extract the directive that actually governs `<script>`,
  fall back to `default-src` when the policy names no `script-src`, and fail when
  the policy constrains scripts with neither.

- **The System page was permanently red in the dev loop.** `vite` did not proxy
  `/.well-known`, where the service descriptor lives, so the page failed in
  development and worked in production. The proxy list is now a module a test
  holds against the navigation table, which is what will catch the next one.

- **Four comments described mechanisms their files do not have** — the HTTP
  header's account of the request pipeline (it now states the order `dispatch`
  really runs, and names what bypasses the drain gate), and the cockpit mount's
  claim that on-disk assets let a developer see a rebuild without restarting
  (they do not; the first `index.html` is pinned for the process lifetime).

### Known

- **The `contradictions` lint rule still overstates a change's consequences,
  for the same reason the diff did.** It is a third surface on the same review
  screen, with its own copy of the rule and its own "approval disputes both"
  message, and its copy reads only the legacy `functional_predicates` array —
  so a wiki that declares functional predicates through the typed registry gets
  no contradiction findings at all, and a wiki using the array gets the coarse
  over-reporting the diff has just stopped doing. Space lint next to it already
  reads both. The change is contained and the correct helper is in the same
  file; it is called out here rather than made on the way past, because it
  changes what a lint report says and deserves its own tests.

- **`/mcp` and the whole OAuth/session plane keep accepting work while the
  process is draining.** They are mounted raw, ahead of the drain gate, so an
  agent can open a session or mint a token seconds before `close()` tears it
  down, where the same operation over REST gets a clean `503 draining` and
  retries against an instance that is staying up. Correcting it means deciding
  how a JSON-RPC transport reports refusal, which is a behavioural decision and
  not a reordering; it is written down in `src/http/server.ts` rather than left
  to be rediscovered.

## 0.23.0 - 2026-08-08

### Changed

- **An SSO identity may now hold `admin`, and only ever by being written down.**
  Identities were capped at the knowledge scopes on the reasoning that an
  identity provider should not be a path to administration. That cost nothing
  while WikiKit had no console — administration was curl with a key either way.
  0.22.0 changed it: an operator signing in through SSO met a cockpit whose
  entire Installation block was absent, on the installation they own. A product
  whose own interface is mostly forbidden to the person who signed into it is
  not secure, it is broken.

  Three rules hold the trade in place, and each is the point of the other two:

  - **No default ever carries `admin`.** The global fallback stays
    `knowledge:read,knowledge:propose`, and a provider that declares no ceiling
    inherits exactly that. The parser refuses `admin` arriving from a fallback
    rather than from something an operator typed, so a future edit that widened
    a default cannot grant administrative SSO to every deployment on upgrade.
  - **`*` is refused outright**, and the distinction from `admin` is not
    squeamishness: `admin` is an authority you can enumerate, and what it
    reaches today it reaches tomorrow. `*` is "everything, including whatever is
    added later" — a grant whose contents are written nowhere and grow with the
    product. That belongs to a key somebody minted on the host with a shell,
    where the act itself is the record.
  - **A remote MCP client still cannot hold `admin`.** `OAUTH_SCOPES` does not
    contain it, so a client cannot request it and consent cannot offer it. An
    `admin` ceiling reaches the browser operator session and an SSO-minted API
    key, and stops there.

  Naming `admin` is a deliberate trade: an account takeover at the identity
  provider then reaches credential and identity management, with no second
  factor anywhere in WikiKit's own chain. Defensible when the provider enforces
  MFA and the allowlist is short — the shape a self-hosted installation usually
  has — and indefensible otherwise. WikiKit cannot tell which one it is in, so
  it takes the operator's word rather than deciding for them.

  Nothing changes for an existing deployment until it says so: no stored
  ceiling gains a scope, and `PUT /v1/identities/{provider}/{subject}` now
  accepts `admin` in its explicit `scopes` array — never through a role
  shortcut, which `knowledge:approve` has never had either.

## 0.22.0 - 2026-08-08

### Added

- **The cockpit** — WikiKit's first human interface, served by the same binary
  at `/cockpit`, on the same origin and at the same version as the API it talks
  to. It presents the product as what it is: a **wiki**. A space is a wiki, a
  concept is a Markdown page, sources are the evidence behind it, and editing a
  page submits a **change**. The button says "Submit change" and not "Save",
  because nothing a human writes becomes knowledge until somebody with
  `knowledge:approve` decides it does — and an interface that said Save would be
  promising something the server does not do.

  Reviewing is the surface the rest exists for: a change renders as a line diff
  per page, with its claims and their verbatim citations, its lint result (which
  never blocks the diff), and approve / reject / request-changes / defer each
  behind a confirmation that restates the exact effect. The public
  `/review/{id}` page is unchanged and still the URL an agent hands a human; the
  cockpit shows that address rather than replacing it.

  Twelve surfaces in three sidebar blocks — where you are, the wiki, and the
  installation folded away. Every write control gates on the scope the server
  will actually demand, and states its reason when it cannot act, rather than
  disappearing.

- **A credential plane for browsers.** `GET /v1/session` answers
  `{"session": null}` for an anonymous tab and **never** 401s — "nobody is
  signed in" is an answer a console renders, not a failure it recovers from.
  `GET /v1/identity/cockpit-login?return_to=…` enters the same provider chooser
  every other sign-in uses, and `DELETE /v1/session` signs out.

  The console is deliberately **not** an OAuth client. Consent exists so a third
  party can be told what it is about to be granted; an installation's own
  console is not a third party, and a consent screen for it is a screen that
  teaches people to click through consent screens. Migration `0032` gives a
  login state a `purpose`, with a CHECK constraint making the cockpit and
  authorization shapes mutually exclusive — a cockpit state with a
  `redirect_uri` would be an unvalidated authorization request, which is exactly
  the row an open redirect needs.

  The resulting operator cookie is a **fallback** REST credential: consulted
  only when a request carries neither `Authorization` nor `X-API-Key`, with a
  same-origin `Origin` required on every unsafe method. A header credential
  always wins, so no API-key client's 401 or 403 changes shape. A CSRF token was
  the alternative and was rejected: it has to reach JavaScript to be sent, which
  is the one property an HttpOnly cookie was chosen to avoid.

- **`contract/cockpit-ui.css` and `contract/COCKPIT-UI.md`** — the design
  contract the console implements, carried as text and identified by the sha256
  of the token bytes rather than by a version number a person types. The three
  sentinel regions in `apps/cockpit/src/index.css` are byte-identical to it,
  `lib/tokens.ts` restates the same table as data because an SVG stroke cannot
  read a Tailwind class, and a test compares all three. The built `index.html`
  announces the digest in a `<meta>` tag, derived at build time.

- **`scripts/deploy/smoke.sh`** and **`scripts/deploy/verify-cockpit-prod.md`** —
  post-deploy verification, driven entirely by `$WIKIKIT_DEPLOY_URL`. The first
  is read-only curl: the shell served `no-cache` under a hash-based CSP, a deep
  client route falling back to it, `/metrics` refused from outside, the chooser
  asking for no credential on step one. The second is the browser checklist for
  what curl cannot see — the sign-in round trip with a deep return address, the
  theme surviving sign-out and reaching the funnel, and the loop itself.

  Both were pointed at a deployment WITHOUT a cockpit before being trusted, and
  two checks passed that should not have: "no `unsafe-inline` in `script-src`"
  was satisfied by there being no policy at all, and "step one asks for no
  credential" by there being no chooser to ask. Absence now fails both, which
  is the entire difference between a smoke test and a green light.

- **`scripts/check-cockpit-browser.ts`** — the layout check no unit test can
  make: every navigable route at 390×844 and 1280×800, asserting the document
  itself does not scroll sideways, that every table scrolls inside its own
  container, and that no cell clips its own text. It signs in through the real
  funnel rather than forging a cookie, so a misconfigured `WIKIKIT_PUBLIC_URL`
  fails it instead of being routed around, and it reports how many
  route/viewport pairs it actually checked — a run that saw nothing says so.

- **`test/unit/cockpit-page-api.test.ts`** — closes the other half of CUI-NAV-2.
  The navigation test proved every DECLARED path exists; nothing proved a page
  reaches only what it declares, which is the drift the rule is about. This
  parses the `wk.*` facade and every page module and compares both directions,
  counting a download link as a reach — an export is a navigation the browser
  owns, not a fetch.

### Fixed

Everything below was found by an adversarial review of the change before it
shipped, or by walking the console in a browser. None of it was visible to the
gate, which is the point worth recording: a green suite is evidence about what
was asked, not about what was built.

- **Navigating the console silently changed which wiki you were reading.** A
  `<Link>` with no `search` prop does not inherit the query string, so clicking
  Pages while reading `?space=team-b` landed on `/cockpit/pages` with no space
  at all — and the resolver fell through to the first wiki the credential could
  see. Sidebar, page body and every subsequent request moved to a different
  wiki with nothing on screen saying so. Three pages had remembered to pass the
  search through and fourteen link sites had not, which is how a per-call-site
  convention fails. `retainSearchParams(['space'])` on the root route makes it
  one decision instead of eighteen.

- **`GET /cockpit/constructor` was an unauthenticated 500 with a stack trace.**
  The embedded-bundle lookup used a truthiness check on a plain object, so a
  path naming an `Object.prototype` member resolved an inherited function and
  `Buffer.from` threw — before the miss was cached, so it repeated forever and
  any anonymous caller could drive the 5xx rate and the error log.

- **Unknown cockpit paths were unbounded memory.** Caching misses looked like
  the obvious symmetry and was not: this mount runs before auth, so every
  distinct `/cockpit/<random>` added a permanent map entry nothing evicts. Only
  hits are cached now; a miss costs the stat it was avoiding.

- **A malformed `wk-cockpit-theme` cookie took the whole sign-in funnel down.**
  `decodeURIComponent('%')` throws, and the cookie parser was unguarded, so one
  bad cookie 500'd every HTML response in the funnel — the console's sign-in
  _and_ every MCP client's. The cookie is deliberately script-writable, so any
  page on the same registrable domain could set it. The comment claiming the
  worst it could achieve was a dark login page has been corrected along with
  the code.

- **A rollback's leftovers were servable.** The traversal guard compared
  against the bundle directory without a separator, so `assets/cockpit-old`
  satisfied `startsWith(assets/cockpit)`. Unreachable in a compiled binary,
  which has no `assets/` on disk — and fired on precisely what a rollback
  leaves behind.

- **The review queue truncated at 50 and then said it had not.** The read sent
  no limit, so it took the server's default, while the footer — which grades a
  whole-list read — announced "across all 50 changes, not just this page". In a
  wiki with more, the 51st-oldest pending change was unreachable from the
  surface the product exists for.

- **Reading the console counted as API demand.** `/cockpit` was not in the
  usage ledger's internal-route list, so every navigation and every
  fingerprinted chunk wrote an `organic` row — and the System page reported the
  operator's own browsing back to them as traffic.

- **The cockpit rendered "No wikis yet" on an installation with wikis.**
  `app/root.tsx` read `data.spaces`; every list read in this API answers
  `{items: [...]}`. The exact shape of failure an optional chain hides: no
  error, no empty response, a page quietly claiming nothing exists. Found by
  walking the console in a browser, not by a test.

- **The sign-in funnel described an authorization request to operators who were
  not making one.** The same three screens serve an MCP client asking to be
  authorized and an operator opening their own console; they now say which. A
  sign-in page that describes something the reader is not doing teaches them to
  stop reading sign-in pages.

- **`build-binary.sh` will not ship a binary with an empty console.** An empty
  embed compiles, boots, passes every test, and serves a 503 where the cockpit
  should be — the one failure the whole pipeline exists to prevent, and the one
  no unit test can see, because it is a property of the artifact.

### Changed

- **WikiKit is no longer "no web UI".** It is still headless for agents — no CLI,
  no console API, and every route the cockpit calls is one an agent could call.
  What changed is that humans now have one place to do the work instead of
  composing curl. README and `docs/ARCHITECTURE.md` say so; `docs/COCKPIT.md` is
  the operator's account of how it is served, signed into and verified.

- **The sign-in funnel follows the console's colour scheme.** The `.scheme-light`
  and `.scheme-dark` classes the shared token block has always carried are now
  set, from a non-HttpOnly `wk-cockpit-theme` cookie the console mirrors its
  choice into. The funnel stays script-free, so it could not have read the
  preference itself, and `vary: cookie` keeps two operators behind one proxy from
  being served each other's scheme. The pinned token bytes are untouched — the
  class goes on the document element, outside the sentinels.

- **`bun run gate` and CI build the console.** `assets/cockpit` and
  `src/cockpit-embedded.ts` are generated, committed and served — the compiled
  binary reads the embed — so a stale one ships last week's console against this
  week's API with nothing at runtime noticing. `check:cockpit-drift` rebuilds and
  fails on any diff, and `build-binary.sh` rebuilds rather than trusting the
  checkout.

## 0.21.0 - 2026-08-06

### Changed

- **The sign-in and consent pages follow the reader's colour scheme.** The shared
  funnel was `color-scheme: light` and nothing else, so anyone working in dark met
  a white page. It now declares both schemes and switches on
  `prefers-color-scheme`. WikiKit ships no console, so there is no explicit
  preference to honour — the media query is the whole answer here, and the
  optional `.scheme-light` / `.scheme-dark` classes the shared block carries are
  never set. No server change was needed, which is what that optionality is for.

  The block also moves to the family's cockpit token vocabulary, which fixes two
  defects the old one carried: `.deny:hover` was about to become invisible, and
  the page had no focus styling at all — it relied on the browser's default
  outline, which is invisible on a dark card.

- **The auth UI contract loses its version number.** `mcp-auth-v2` is now
  `mcp-auth`. The number existed so that a product which had NOT taken a change
  would fail loudly rather than render unstyled — but a change to this block
  lands in every product in one wave, so that product does not exist. What the
  number actually bought was a second thing to keep in step, hand-typed, which is
  exactly the failure it was meant to prevent: four repositories all asserted
  `content="2"` while nothing compared the bytes.

  `<meta name="mcp-auth-ui-contract">` now carries a digest computed from the
  stylesheet at module load. Two products serving different bytes announce
  different strings, in the DOM. Verified identical across watchkit, contentkit,
  wikikit and subkit: 3866 bytes, sha256 `ebdaece1`.

## 0.20.3 - 2026-08-05

### Added

- **`GET /.well-known/service-descriptor.json`** — version plus a sha256 per
  self-description artifact (`llms.txt`, `llms-full.txt`, `agent-guide.md`,
  `openapi.json`), in one small response. A monitor asking "has anything
  changed" otherwise downloads all of them on every poll — `llms-full.txt`
  alone is ~50 KB, every round, almost always to discover nothing changed. This
  is what makes a thirty-second drift check affordable instead of an hourly one.

  Hashes are of the bytes actually served and are computed per request rather
  than cached: the documents are embedded at build time and cannot change while
  the process lives, and a cached hash that went stale would make this endpoint
  lie in exactly the situation it exists to report. Only artifacts this build
  actually serves are listed — an entry for a document that answers 404 would
  send a watcher to fetch it and then report the miss as drift.

## 0.20.2 - 2026-08-05

### Fixed

- **Build**: `NODE_ENV` is no longer frozen at compile time. `bun build --compile`
  substitutes the exact expression `process.env.NODE_ENV` with the build runner's
  value, so the shipped binary never read the variable and a process started by
  systemd with `NODE_ENV=production` still took every development branch: the
  mandatory-configuration check was skipped, `.env.defaults` was read in
  production, `WIKIKIT_WEBHOOK_ALLOW_PRIVATE` fell back to permitting delivery to
  private addresses, and a `*`-scope bootstrap key would be minted and printed in
  plaintext on a first boot with no keys. Verified against this repository's own
  binary before and after.

  Two guards, because neither alone finds it: `build-binary.sh` carries the
  identity define `--define process.env.NODE_ENV=process.env.NODE_ENV` and a drift
  test fails the build if any compile invocation loses it; the same script then
  RUNS the artifact under `NODE_ENV=production` and requires it to refuse to boot.
  The source is correct either way — only the compiled binary knows whether it
  still reads the variable.

## 0.20.1 - 2026-07-25

### Changed

- **Docs**: document the per-space Charter for end users across the self-describing
  surfaces — a "Space charter" section in the built-in agent guide (served by
  `wikikit_guide` and `/agent-guide.md`), a Features entry in the README, an
  architecture subsection on how the charter steers synthesis, and the charter
  REST endpoints + MCP tools in the CONTRACTS reference tables. No behaviour change.

## 0.20.0 - 2026-07-24

### Added

- **Per-space Charter** — a versioned, human-owned "virtual document" per space
  (the llm-wiki `CLAUDE.md` equivalent): free markdown that steers synthesis and
  classification, rendered together with a KB-derived overview (concept index +
  counts). Stored in the new `wk_charter_revisions` table (migration
  `0031_wk_charter_revisions`), auto-versioned like a document — every write is a
  new `latest` revision with full history retained.
  - REST: `GET/PUT/DELETE /v1/spaces/{space}/charter` (GET negotiates
    `text/markdown`; `?rev=N` reads a version) and
    `GET /v1/spaces/{space}/charter/versions`.
  - MCP: `wikikit_charter` and `wikikit_charter_history` (read, `knowledge:read`),
    `wikikit_charter_set` and `wikikit_charter_delete` (write, `admin`).
  - Bidirectional: the authored text versions directly (human-owned config, no
    review gate); an edited overview block is routed through the review gate as a
    ChangeProposal, so knowledge changes still pass human approval.
  - Steering: the latest charter flows into `synthesize.v2` and `classify.v2`
    (new prompt versions) via the rendered user prompt, never the cached system
    block.

## 0.19.0 - 2026-07-24

### Changed

- **BREAKING**: `wk_oauth_identities.allowed_scopes` is now `NOT NULL`
  (migration `0030_wk_identity_ceiling_not_null`) — the stored array IS the
  identity's scope ceiling, full stop. The transitional pre-0028 NULL-ceiling
  inheritance is retired: a `grant_source='bootstrap'` row with
  `allowed_scopes=NULL` no longer inherits the provider's `allowed_scopes`
  at runtime (`oidcIdentityScopeCeiling` is removed; the grant lookups read
  the stored ceiling directly). Production carries no NULL rows (verified
  2026-07-24; the allowlist bootstrap path has written explicit ceilings
  since 0.18.0) — the migration still defensively backfills any stray NULL
  row with the minimal `{knowledge:read}` ceiling, deliberately NOT the
  provider set, which lives in runtime ENV config and is not available to
  SQL. An operator raises a backfilled row over
  `PUT /v1/identities/{provider}/{subject}`.
- `allowed_scopes` in the `/v1/identities` responses is now non-nullable
  (`string[]`), and the 0.18.1 `PUT` lockout guard simplifies accordingly:
  it now refuses (`422 unprocessable`) a metadata-only update onto a grant
  whose stored ceiling is an EMPTY array — an empty ceiling denies every
  login and there is no allowlist inheritance left to fall back on.

## 0.18.1 - 2026-07-24

### Security

- Closed the SSO API-key loophole (migration
  `0029_wk_identity_bound_api_keys`): `POST /v1/identity/sessions` used to
  mint an unbounded `wk_api_keys` snapshot of the identity's ceiling that
  identity revocation could not reach. Session keys are now BOUND to their
  `wk_oauth_identities` grant via the new nullable
  `identity_provider`/`identity_subject` columns:
  - `DELETE /v1/identities/{provider}/{subject}` additionally revokes the
    identity's bound API keys (idempotent, alongside the existing OAuth
    token/code kill), and a later `restore:true` never resurrects them — a
    fresh login mints a fresh key.
  - Authentication rechecks the grant row LIVE on every request, exactly
    like the OAuth-token path: a revoked or deleted grant answers `401`, and
    a downgraded ceiling cuts the key's stored scope snapshot immediately
    (honoring the approve→review implication). Plain operator keys
    (`identity_provider IS NULL`) are untouched.
  - The API-key login funnel applies the same rule: an SSO-minted key used
    as an operator credential inherits the grant's current ceiling and dies
    with the grant.
- The same migration drops the legacy vendor-named `provider` column default
  that pre-0005 deployments still carried on `wk_oauth_identities` — every
  writer names the provider explicitly, so a column default only invites
  silently mislabeled rows.

### Fixed

- `PUT /v1/identities/{provider}/{subject}` now refuses (`422 unprocessable`)
  a metadata-only update that would strip a grant to `allowed_scopes=NULL`
  under `grant_source≠'bootstrap'` — previously the `COALESCE` kept the NULL
  while stamping `'admin'`, silently locking the identity out because only
  `'bootstrap'` rows inherit the provider allowlist ceiling.
- The consent offer now honors the approve→review implication the
  enforcement side (`requireScope`) has always applied: an identity with a
  `knowledge:approve` ceiling is offered the `knowledge:review` checkbox
  instead of having it silently filtered from the consent page.

## 0.18.0 - 2026-07-23

### Added

- Admin REST for SSO identity grants (migration
  `0028_wk_identity_grants_admin`, scope `admin`):
  - `GET /v1/identities` lists every grant (provider, subject, email,
    display_name, `allowed_scopes` ceiling, `grant_source`, revocation and
    seen timestamps) — never tokens or hashes.
  - `PUT /v1/identities/{provider}/{subject}` idempotently creates/updates a
    grant. `role` XOR `scopes`: the named roles `reader`/`contributor`/
    `reviewer` are server-side shortcuts expanded into scope sets and never
    stored; `knowledge:approve` deliberately has NO shortcut and must be
    granted as an explicit scopes array. Sending both (or neither on a new
    grant, or an unconfigured provider id) is `422 unprocessable`. A PUT on a
    revoked grant without `restore:true` is `409 identity_revoked` —
    `restore:true` is the only way to clear a revocation.
  - `DELETE /v1/identities/{provider}/{subject}` revokes the grant and
    additionally kills the identity's live OAuth access/refresh tokens and
    pending authorization codes (idempotent).
- `wk_oauth_identities` grows `display_name` and `grant_source`
  (`admin`/`seed`/`signup`/`bootstrap`); pre-existing self-signup rows are
  backfilled as `signup`, allowlist rows as `bootstrap`. The deploy seeder
  manages only rows with `grant_source='seed'`; a manual PUT (stamped
  `admin`) takes the row out of the seeder's hands permanently.

### Changed

- The `wk_oauth_identities` row is now the SINGLE AuthZ truth, effective
  immediately (the auth path reads the row per request/token issue, no
  restart): a stored `allowed_scopes` ceiling wins over the ENV allowlist,
  and an allowlisted login mirrors the provider's `allowed_scopes` into the
  row (`grant_source='bootstrap'`) instead of resetting the per-row ceiling
  to NULL. Rows with `grant_source` `admin`/`seed`/`signup` are never
  overwritten by the allowlist path. The ENV allowlist is bootstrap-only;
  WikiKit warns at boot when it exceeds two entries.
- `POST /v1/identity/sessions` admits identities through the same DB-grant
  contract as the browser SSO callback: operator-granted identities work
  without an ENV allowlist entry, and the issued identity API key carries the
  stored ceiling (an unknown identity is now `403 access_denied` instead of
  `401 invalid_token`).

### Security

- `revoked_at` always wins: a revoked identity is denied even while its
  subject/email still stands in the ENV allowlist, and no login path
  un-revokes a row (previously an allowlisted login reset `revoked_at` to
  NULL, silently re-admitting revoked identities). Revocation also kills the
  identity's live OAuth tokens; re-admission is exclusively the explicit
  admin-REST restore.

## 0.17.0 - 2026-07-23

### Added

- URL-mode elicitation fallback for `wikikit_review_proposal` (MCP
  2025-11-25): the native in-client form stays the primary review channel —
  in a terminal client the in-terminal review dialog — and only when the
  client has no `elicitation.form`, or advertises one and provably never
  renders it, does the tool fall back to `elicitation.url`. The human
  consents to open the embedded review page
  (`GET /review/{id}?via=elicitation`), the tool returns
  `outcome: "url_review_started"` without blocking, the decision lands on the
  page with the reviewer's own key, and the server sends
  `notifications/elicitation/complete` to exactly the originating session
  (best-effort; `wikikit_proposals` polling stays the durable path).
- New audited review channel `url_elicitation` (migration
  `0027_wk_url_elicitation_channel`): the review page reports elicitation
  provenance via an optional `via` body field on the REST review endpoints —
  informational only, no auth effect.

### Fixed

- A form-mode cancel arriving faster than any human could read the form (a
  client that advertises `elicitation.form` but auto-cancels without
  rendering it) is no longer reported as a human cancel: the review degrades
  to the URL consent or the `human_review_required` hand-off, so the agent
  gets actionable instructions instead of repeated silent cancels.
- Elicitation capability detection now follows the spec's backwards
  compatibility rule: an empty `elicitation: {}` client capability counts as
  form support.

## 0.16.1 - 2026-07-23

### Fixed

- Coverage-gap lexeme capture now resolves the space's text-search config
  through the db.call whitelist instead of inlining the SQL function —
  db.query's identifier guard (correctly) rejected the inlined call, so
  opt-in gap topics silently recorded nothing.

## 0.16.0 - 2026-07-23

### Added

- Coverage insights endpoint `GET /v1/spaces/{space}/stats/coverage`
  (migration `0026_wk_coverage_stats`, schema `wikikit.coverage-stats.v1`):
  open disputed claims with the age of the oldest one, review latency and
  approve/reject counts for a window, concept freshness (share not updated
  for 90+ days), the most-read concepts (per-day aggregate read counters for
  explicit REST/MCP concept reads — actor-free by design), the most-linked
  concepts (inbound active relations), and — opt-in via
  `WIKIKIT_COVERAGE_GAP_TOPICS_ENABLED` (default `false`) — the stemmed
  lexemes of questions the base could not answer (never the question text;
  rows expire with the usage retention window).

## 0.15.0 - 2026-07-23

### Added

- Demand-vs-coverage telemetry (migration `0025_wk_usage_no_answer`): when a
  query call answers honestly that the knowledge base does not cover the
  question, the knowledge-surface usage row records the new outcome
  `no_answer` instead of `success` (transport rows keep their status
  semantics — a 200 stays a 200). Usage stats gain `no_answer` and
  `no_answer_ratio` metrics, measuring demand the curated base does not yet
  cover. Failed requests are never counted as `no_answer`.

## 0.15.1 - 2026-07-23

### Fixed

- The `/mcp` 401 `WWW-Authenticate` challenge now advertises the complete
  knowledge permission set from `scopes_supported`
  (`knowledge:read knowledge:propose knowledge:review knowledge:approve`)
  instead of only read/propose, so MCP clients offer review/approve on their
  consent surface too. `offline_access` is a token-mechanics scope and stays
  out of the challenge. Actual grants are still clamped to the identity's
  ceiling by the unchanged consent logic.

## 0.14.0 - 2026-07-23

### Added

- Self-signup for OIDC identities (`WIKIKIT_OAUTH_ENABLE_SIGNUP`, default
  `false`; migration `0024_wk_oauth_identity_signup`): when enabled, an
  unknown OIDC identity that authenticates at the SSO callback is
  auto-admitted and registered in `wk_oauth_identities` with its own
  per-identity permission ceiling of `knowledge:read` — never the provider's
  full `allowed_scopes` set. Disabled (the default) keeps today's behavior:
  unknown identities are rejected with the styled not-authorized page and the
  RFC 6749 `access_denied` client redirect. The switch governs only unknown
  identities — allowlist entries (`allowed_subjects`/`allowed_emails`) and
  already-registered identities keep working unchanged, allowlist removal
  still revokes access, and operator revocation (`revoked_at`) always wins
  over signup.

## 0.13.1 - 2026-07-23

### Fixed

- Browser GET failures in the OAuth login funnel (denied identity policy,
  unknown/expired/consumed login state, code-exchange errors) now answer
  humans with a "Sign-in failed" page in the shared auth shell instead of a
  raw JSON body; when the waiting OAuth client is known, the page's
  "Sign in again" action carries the RFC 6749 `error=access_denied` redirect
  so MCP connectors never hang. JSON stays the contract for
  token/register/API and `Accept: application/json`.

- Every "Continue with SSO" click now inserts its own login state with its
  own nonce and PKCE verifier instead of rewriting the pending row; earlier
  states stay valid until TTL, keeping the Back button safe.

## 0.13.0 - 2026-07-23

### Added

- Role presets for API keys (no migration): `POST /v1/api-keys` accepts
  `role: reader | contributor | reviewer` as an alternative to explicit
  scopes — three understandable bundles instead of a least-privilege maze.
  Roles expand to scopes at creation time and are never stored; scopes stay
  the only ground truth. Deliberately no `approver` preset:
  `knowledge:approve` remains an explicit, spelled-out grant.

- Cross-space federation (migration `0023_wk_space_refs`): relations can now
  point at concepts in OTHER spaces via qualified `other-space:slug` targets
  — allowed only when the target space is declared in the source space's
  `settings.imports` and the key can see both spaces (space-scoped keys get
  a deterministic 403), and only for targets that already exist as readable
  concepts (no cross-space writes, ever; citations stay strictly
  intra-space). Reads carry provenance (`relations[].space`; foreign targets
  are elided for space-scoped keys), search gains
  `include_imports=true` (fan-out over declared imports, every hit tagged
  with its origin `space` plus `searched_spaces`), briefings qualify
  concepts as `space:slug` and the context selector may add import-declared
  spaces at lower priority. A new `broken-cross-space-links` lint rule
  (warn) flags dangling `[[space:slug]]` markdown links. Knowledge is never
  copied between spaces.

- Richer claim semantics (migrations `0021_wk_claim_semantics` +
  `0022_wk_apply_claim_semantics`): claims can carry explicit temporal validity
  (`valid_from`/`valid_until` — written only when the source states them),
  a `context` partition of the frame (`region:eu`, `v2.x`), server-computed
  normalized objects (typed predicate registry
  `settings.predicate_defs` with explicit unit-conversion factors — no
  built-in ontology) and a staged, reviewer-visible `supersedes_claim_id`.
  The contradiction rule is now interval-, context- and normalization-aware
  everywhere it lives (pre-review matcher, staged-content lint, space lint,
  approval flip): disjoint validity is succession, not contradiction;
  `1 GiB` no longer contradicts `1024 MiB`; different regions coexist.
  Approval executes supersession deterministically (deprecate the target +
  `supersedes` relation; `claims_deprecated` in the result). Subject aliases
  (`settings.aliases`) resolve once at staging — stored claims are always
  canonical. The previously unwired `adjudicate.v1` prompt is now live: the
  pipeline classifies persisted-side frame collisions (capped per job,
  fail-open to the dispute path) — `complementary` verdicts exempt the claim
  from the dispute flip, `temporal` verdicts stage the supersession, and the
  proposal summary reports supersessions separately from contradictions.
  The synthesize prompt is evolved in place (temporal/context extraction,
  typed vocabulary rendering) — golden snapshots carry the reviewed diff.

- Review operations (migration `0020_wk_review_operations`): pending
  proposals can be **split** — fully (one pending child per concept plus one
  for decisions, parent → new terminal status `split`) or partially
  (**defer**: named concepts move to one child while the parent keeps its id
  and remainder) — via `POST /v1/proposals/{id}/split` (`knowledge:review`),
  atomically re-pointing every staged row including relation-removal
  markers. **Request-changes** (`POST /v1/proposals/{id}/request-changes`,
  note mandatory) rejects terminally with a machine-readable
  `changes_requested` flag — agents read the note as the revision brief for
  a fresh proposal. New `GET /v1/proposals/{id}/lint` checks STAGED content
  (uncited claims, frame collisions, stale base, dangling relation targets).
  The proposal wire gains `changes_requested`, `parent_proposal_id`,
  resolved `sources`, per-concept `stale` and full `claims` with citation
  quotes; new webhook events `wikikit.proposal.split` and
  `wikikit.proposal.changes_requested`.
- The human review page grew into a thin knowledge-ops surface: real line
  diffs (dependency-free LCS, CSP unchanged — zero external bytes), claims
  tables with expandable citation quotes and collision highlighting, a
  stale-base banner naming the moved concepts and the re-ingest remedy,
  staged-content lint, resolved sources, per-concept defer buttons and a
  request-changes action. Review-only keys (`knowledge:review`) can inspect,
  defer and request changes; approve/reject stay `knowledge:approve`.

- Versioned source-sync contract for external connectors (migration
  `0019_wk_source_sync`): ingest accepts `external_source_id`,
  `source_version`, `observed_at` and `effective_at`; every external
  document gets a `wk_source_streams` row (mutable head pointer + latest
  version + tombstone) while `wk_sources` stays a fully immutable
  append-only archive with write-once `supersedes_source_id` chains.
  Idempotent re-sync semantics: known content answers
  `200 {status:'unchanged'}` (head advance, no LLM) instead of 409 —
  connectors retry blindly; re-using a version marker for different content
  is a loud `409 sync_version_conflict`; content reverts move the head back
  without new rows. New endpoints `GET /v1/spaces/{space}/source-streams`
  and idempotent `DELETE /v1/spaces/{space}/source-streams/{external_source_id}`
  (tombstone; emits `wikikit.source.tombstoned`, resurrected by a later
  push). Tombstones never touch claims automatically — the new
  `tombstoned-sources` lint rule (warn) surfaces visible claims citing
  upstream-deleted documents for human review. Ingests without an external
  id keep today's semantics byte-for-byte.

- Optional hybrid retrieval (migration `0018_wk_embeddings`): with pgvector
  installed and `WIKIKIT_EMBEDDING_PROVIDER=openai|google` configured
  (Anthropic has no embeddings API), a background embedder fills a
  `wk_embeddings` side table for current revisions, visible claims and
  source chunks, and searches fuse the lexical and cosine arms via
  Reciprocal Rank Fusion (k=60) — deterministic, explainable
  (`matched_via: lexical|vector|both` on every hit), with visibility
  restated in the vector arm so proposed content stays invisible by
  construction. Everything degrades to pure lexical retrieval without
  pgvector, without a provider, or on any embedding failure — search never
  returns 503 because of embeddings. Local/CI Postgres image moves to
  `pgvector/pgvector:pg18` (plain-postgres deployments keep working: all
  vector DDL is guarded).

- Two retrieval tiers (migration `0017_wk_source_chunks`): archived sources
  are now chunked into a persisted, per-source-language retrieval index
  (`wk_source_chunks`, written at archive time and healed for existing
  sources by a background scan worker). Search and `/query` accept
  `mode: approved_only | approved_then_sources` — the default stays
  byte-identical to today; the opt-in mode appends archived source chunks as
  a separate `tier: 'source_evidence'` after every approved hit, never
  interleaved. Query answers (answer prompt evolved in place) must label statements
  grounded only in source evidence as uncurated and cite them as
  `[source:<id>]`; the wire gains `source_citations`. A found chunk feeds
  straight back into curation: proposal citations now accept `{ chunk_id }`,
  resolved server-side to the canonical `{source_id, verbatim quote}`.
  Ingest accepts an optional per-source `language` override.

- Multilingual search (migration `0016_wk_search_multilingual`): the space
  setting `settings.language` (`en` | `de` | `simple`, default `en`) now
  selects the PostgreSQL text search configuration per space — the v0.2
  landing zone named in migration 0001 becoming real. New configurations
  `wk_english`/`wk_german` install `unaccent` as a filtering dictionary, so
  indexing, `websearch` query parsing and headlines are accent-insensitive
  symmetrically; a query-side repair strips the German stopwords that
  survive unaccenting (`für` → `fur` etc.) from parsed queries. `pg_trgm`
  adds a deterministic typo-tolerance arm on concept slugs and titles with
  fixed, documented rank constants. Sources gain a nullable `language`
  column for per-source overrides. Changing a space's language recomputes
  its search vectors via the new whitelisted `wk_reindex_space` function.
  The migration re-vectorizes every existing revision and claim once — on
  large deployments expect the migration to hold locks noticeably longer
  than previous ones.
- German retrieval-quality benchmark: a seeded corpus and 30 golden queries
  with reviewed gating thresholds
  (`test/fixtures/retrieval/{corpus,golden}.de.json`), a CI gate
  (`test/integration/retrieval-eval.test.ts`, RUN_INTEGRATION=1) and a
  verbose tuning table (`bun scripts/retrieval-eval.ts`). Measured effect of
  the multilingual migration on the German set: recall@10 and MRR moved from
  0.467 (english stemming) to 0.967.

## 0.12.2 - 2026-07-23

### Changed

- Remove concrete production-domain and sibling-product references from the
  public documentation and enforce that boundary with a repository guard test.

## 0.12.1 - 2026-07-23

### Fixed

- Express the capture hook's transcript readability guard as an explicit
  conditional so the shipped shell hook passes the same ShellCheck gate used
  by CI.

## 0.12.0 - 2026-07-23

### Added

- Ship the missing UserPromptSubmit example hook (`wikikit-context.sh`) —
  per-prompt space selection via `POST /v1/agent/context`, reading the
  optional `.wikikit/agent.json` manifest — plus PowerShell 5.1 counterparts
  of all three lifecycle hooks (`wikikit-briefing.ps1`, `wikikit-context.ps1`,
  `wikikit-capture.ps1`) so native Windows needs no Git Bash, jq or Node.
- Serve an embedded agent hooks installer from every WikiKit server:
  `GET /install.sh` (strict POSIX, rustup-style, curl→wget fallback) and
  `GET /install.ps1` (PowerShell 5.1, TLS 1.2), with the six hook scripts
  individually downloadable at `GET /install/hooks/{script}`. The installer
  detects Claude Code, Codex and Cursor, merges hook entries without ever
  clobbering existing configuration, is idempotent on re-run, supports
  `--uninstall`, and keeps secrets in `~/.wikikit/env` (chmod 600) instead of
  harness configs.
- Document Cursor as a lifecycle-capable harness (hooks.json `version: 1`,
  `sessionStart`/`beforeSubmitPrompt`/`stop`) alongside Claude Code and Codex
  in the coding-agent integration guide and both LLM documents.

### Changed

- All example hooks source `~/.wikikit/env` (environment variables still win),
  so harness configs stay bare script paths with no inline secrets.
- Make OIDC identity subject-first: `sub` is mandatory, while email is optional
  and used only with `email_verified=true`. Each provider must still explicitly
  allow the exact subject, a verified email, or both.

## 0.11.0 - 2026-07-22

### Changed

- Make API-key and direct OIDC the complete WikiKit-owned MCP authentication
  model. WikiKit owns its OIDC client, callback, policy, sessions and secrets;
  no shared or externally hosted cross-product auth component is supported.
- Keep the family-wide SSO-first UI and public provider-neutral contract while
  implementing and configuring every auth operation inside WikiKit itself.
- Update README, contracts, configuration, OpenAPI and both LLM documents to
  the corrected independent-product architecture.

### Removed

- Remove the hosted assertion-adapter protocol and its POST callback surface.

## 0.10.0 - 2026-07-22

### Added

- Publish the complete common MCP-auth OpenAPI contract, including safe
  provider discovery and provider-neutral assertion exchange at
  `POST /v1/identity/sessions` with the shared
  `{api_key,principal_id,context_id,email}` response.
- Verify OIDC identity assertions through issuer discovery, pinned audience,
  cached remote keys, verified email and WikiKit's explicit identity policy.

### Changed

- Upgrade every WikiKit login and consent page to `mcp-auth-v2`, byte-identical
  shared styles, an opaque `login_state` handoff, and the fixed user actions
  `Continue with SSO` then `Continue with API key`.
- Keep configured provider labels and products out of the UI and public route
  model while preserving WikiKit-owned scopes, spaces, data and deployment.
- Update README, contracts, configuration, OpenAPI and both LLM documents to
  the exact common auth operation and schema contract.

### Removed

- Retain no provider-named routes, response aliases or compatibility parsing.

## 0.9.3 - 2026-07-22

### Changed

- Make all browser-auth examples and historical auth descriptions use only
  provider-neutral protocols, ids and endpoints.
- Extend the architecture contract to reject concrete provider products in
  both the auth runtime and its operator documentation.

## 0.9.2 - 2026-07-22

### Changed

- Replace the remaining provider-specific bootstrap migrations with a
  provider-neutral external-identity baseline and structural provider metadata.
- Extend the architecture contract to scan embedded migration sources so a
  clean installation cannot pass through a retired provider-specific schema.

### Migration

- Existing installations rename the two historical migration journal tags
  once before the binary cutover. The already-neutral production schema and
  all knowledge data remain unchanged; WikiKit backfills only the new hashes.

## 0.9.1 - 2026-07-22

### Added

- Enforce the provider-neutral auth boundary with a repository contract test:
  runtime auth may expose only generic identity routes and protocol
  discriminators, never vendor-named branches, configuration keys or route
  aliases.

## 0.9.0 - 2026-07-22

### Added

- Add proposal-staged relation removals: `relations_removed` on
  `POST /v1/spaces/{space}/proposals` and `wikikit_propose` marks existing
  active relations for removal; the structured diff, markdown rendering and
  the human review page show the pending removals, approval deactivates the
  marked edges atomically (soft delete, audit marker kept), and rejection
  leaves them untouched. Removal-only proposals are valid.
- Add one provider-neutral MCP browser-auth list that can offer one scoped API
  key plus multiple named direct OIDC adapters concurrently;
  provider products are configuration values rather than WikiKit modes.
- Apply verified-email and explicit allow-list policy to direct OIDC adapters
  without adding provider-specific branches.
- Add revocable operator sessions with an eight-hour idle limit, 24-hour
  absolute cap, live identity revalidation, explicit logout and account
  switching.
- Add the shared `mcp-auth-v1` sign-in and consent card with the WikiKit `W`
  badge and an OAuth 2.1 security scheme in OpenAPI.

### Changed

- Replace every provider-specific login route and config branch with
  `/v1/identity/login/start`, `/v1/identity/login/callback`,
  `/v1/identity/logout`, and the `protocol` discriminator. No legacy provider
  shape or route is accepted.

- Bind consent strictly to scopes requested by the client, supported by the
  server and currently permitted for the identity. `knowledge:read` remains
  mandatory and is never silently added to a request that omitted it.
- Allow reviewer credentials to inspect proposal details while keeping the
  irreversible approve/reject boundary on `knowledge:approve`.

### Removed

- Remove the former provider-specific configuration and login endpoints with
  no aliases or compatibility parser. Deployments must supply canonical
  `protocol` records before starting 0.9.0.

### Security

- Persist only opaque session/token hashes, recheck revocation and expiry at
  consent and token use, and keep credentials and identity assertions out of
  rendered pages, logs and history.

## 0.8.0

### Added

- Scope-matched hand-off instructions: the key is the policy. On a client
  without form elicitation, `wikikit_review_proposal` still returns the
  `human_review_required` hand-off with the `review_url`, but a key the
  operator deliberately granted `knowledge:approve` is now instructed that it
  may execute the user's clearly stated approve/reject instruction from the
  conversation over REST, quoting the user's words in the audit note. A
  `knowledge:review` key keeps the strict hands-off journey unchanged. Audits
  record the key name and `review_channel: "rest"`.

## 0.7.0

### Added

- Embedded human review page at `GET /review/{id}` — the one-click
  out-of-band surface for MCP clients without native form elicitation
  (ChatGPT connectors). The public shell is content-free; the proposal diff
  loads in the browser with the reviewer's own `knowledge:approve`
  credential, and approve/reject record `review_channel: "rest"`.
- The `human_review_required` hand-off from `wikikit_review_proposal` now
  carries a ready-to-share `review_url`, and the agent instructions tell the
  agent to hand exactly that link to the user.

## 0.6.0

### Added

- Structured hand-off for MCP clients without native form elicitation:
  `wikikit_review_proposal` now returns
  `outcome: "human_review_required"` with explicit agent instructions instead
  of an error. The proposal stays pending; a human reviews it out-of-band and
  the agent polls `wikikit_proposals` for the result. The hand-off is counted
  as its own content-free usage outcome (`handoff`).
- New scope `knowledge:review` gating `wikikit_proposals` and
  `wikikit_review_proposal`. `knowledge:approve` implies it, so existing keys
  keep working unchanged; the reverse never holds. The REST approve/reject
  endpoints still require `knowledge:approve`, which becomes the
  human-operator credential — agent keys minted with `knowledge:review` can
  never approve over HTTP.
- Documented per-client review journeys (native-form client, non-form client,
  human operator over REST) with the explicitly forbidden moves: collecting
  approve/reject in chat, passing the decision as tool input, and calling the
  REST review endpoints on the human's behalf.

### Changed

- Passing `decision`/`note` to `wikikit_review_proposal` is refused with a
  targeted `approval_requires_human` error before schema validation or any
  database access, replacing the generic strict-schema rejection.
- `elicitation_not_supported` is now a fail-closed backstop for mid-review
  capability loss; its guidance no longer points agents at the REST
  approve/reject endpoints.

## 0.5.0

### Added

- Native MCP form elicitation for ChangeProposal review. The agent supplies
  only the proposal id; the human chooses approve or reject and writes the
  optional review note inside the connected client.
- Durable `review_channel` provenance (`rest` or `mcp_elicitation`) on proposal
  responses, Markdown/OKF audit logs and approved/rejected webhooks.
- Configurable `WIKIKIT_MCP_ELICITATION_TIMEOUT_MS` and content-free outcome
  telemetry for accepted, declined, cancelled, timed-out and unsupported
  review attempts.

### Changed

- `wikikit_review_proposal` now accepts only `{proposal_id}`. MCP POSTs use SSE
  so `elicitation/create` and its response remain associated with the original
  tool call. Clients must reconnect/rescan the changed tool contract.

### Security

- MCP review fails closed when the client lacks form elicitation, returns an
  invalid response, declines, cancels or times out. None of those paths invokes
  the protected SQL review functions, and form contents are excluded from
  logs and usage telemetry.

## 0.4.0

### Added

- Opt-in, append-only, privacy-bounded usage telemetry for HTTP, MCP and the
  semantic knowledge/review workflows. Product-local HMAC actor/session ids
  support exact-window adoption without storing content, prompts, queries,
  tool arguments/results, network identifiers, credentials or dynamic ids.
- New aggregate resources: global `GET /v1/stats/mcp` and space-scoped
  `GET /v1/spaces/{space}/stats/http`, `/stats/usage` and `/stats/reviews`.
  They expose value state/kind, ratio evidence, exact-window uniques,
  latency/size distributions, traffic classes and quality metadata.
- Raw usage retention cleanup plus explicit organic/synthetic/internal
  traffic classification for production canaries and report collectors.

### Security

- Usage collection remains off by default and fails boot when enabled without
  an independent `WIKIKIT_USAGE_HMAC_SECRET`. Anonymous HTTP traffic is never
  fingerprinted and reporting/probe traffic is classified as internal.

## 0.3.2

### Fixed

- Proposal review details now expose every staged decision — including its
  context, decision, rationale and alternatives — consistently through HTTP
  JSON, human-readable Markdown and MCP, so reviewers see all rows an approval
  would activate.

## 0.3.1

### Fixed

- Automatic space routing scores each prompt word once at its strongest match,
  preventing a word and its stem from making one generic description term look
  like multiple independent routing signals.

## 0.3.0

### Added

- Dynamic, task-aware multi-space context selection through the
  `/v1/agent/context` HTTP endpoint and the `wikikit_context` MCP tool, with
  explicit manual space selection available for every project.
- Compact session briefings through `/v1/agent/briefing` and
  `wikikit_briefing`, plus discovery through `/v1/spaces` and
  `wikikit_spaces`.
- Per-space routing settings for stable descriptions, activation hints,
  priorities, and always-on behavior without a fixed primary/secondary
  taxonomy.
- WikiKit now ships immutable, code-versioned system knowledge for agents as
  `wikikit_guide`, `wikikit://system/agent-guide`, and `/agent-guide.md`.
  It includes dynamic multi-space routing and capability-based no-CLI setup
  for MCP clients without seeding tenant data.
- `/.well-known/llms.txt` and `/.well-known/llms-full.txt` mirror the embedded
  discovery documents for zero-configuration agent and connector discovery.

## 0.2.3

### Fixed

- The test suite strips an ambient `JOURNAL_STREAM` via a bun test preload,
  so logger tests no longer fail on systemd-launched or journal-forwarded
  environments (this broke the v0.2.2 release build). No runtime changes
  beyond 0.2.2.

## 0.2.2

### Added

- Log lines carry sd-daemon priority prefixes (`<3>` error, `<4>` warn) when
  running under systemd, so `journalctl -p err` surfaces application errors.
- Ingest jobs that hit provider quota exhaustion are parked in a new
  `quota_blocked` state with a `resume_at` parsed from the provider message
  (fallback +6h) and retried automatically, instead of failing permanently.

### Fixed

- OAuth authorize requests without PKCE parameters are rejected with
  400 `invalid_request` instead of failing with a 500 on the not-null
  constraint of `code_challenge`.
- Grounding drops ("quote not verbatim in source") are logged at info
  instead of warn — they are the validator succeeding, not a problem.

## 0.2.1

### Fixed

- Ingest status documentation now matches the existing no-review-work contract:
  `done` always carries the archived `source_id`, while `proposal_id` is null
  when classification finds no affected or new knowledge. HTTP OpenAPI, MCP
  tool help, README and LLM documentation now describe the same behavior.
- Release artifacts once again match the exact documented source revision and
  self-reported version, replacing the temporary 0.2.0 documentation hotfix.

## 0.2.0

### Added

- Space-scoped `/v1/spaces/{space}/stats/*` product analytics for ingest,
  knowledge growth/review, LLM usage and webhooks. Aggregates are read from
  WikiKit's PostgreSQL database and reuse existing `knowledge:read` keys.
- W3C Trace Context continuation and OpenTelemetry-aligned service,
  deployment, event, trace and span fields in structured runtime logs.

### Changed

- LLM call telemetry now distinguishes successful and failed provider calls;
  ingest and provider telemetry are wired into the production composition
  root instead of existing only as metric helpers.

## 0.1.15

### Changed

- Public documentation now describes the deployed remote-MCP contract
  consistently: product-local API-key and direct OIDC providers,
  the interactive `knowledge:approve` ceiling, and the separate proposal
  inspection/review tools.
- ChatGPT setup documents that an app scans and stores its tool and OAuth-scope
  contract. Recreate or rescan a connector after adding tools or scopes; do
  not silently elevate an existing grant.

### Fixed

- `llms.txt` now correctly identifies `wikikit_decisions` as a
  `knowledge:read` tool; only proposal inspection and final review require
  `knowledge:approve`.

## 0.1.14

### Added

- MCP proposal review is now complete: `wikikit_proposals` exposes the full
  staged diff and `wikikit_review_proposal` performs an explicit, confirmed
  approve/reject decision. Both require `knowledge:approve`.
- Remote MCP OAuth supports standard OIDC Authorization Code + PKCE providers
  and a provider-neutral chooser.
  Identity-provider allow-lists and the read/propose/approve permission ceiling
  are independently configurable.

### Changed

- OAuth does not grant `knowledge:approve` by default; a client must request it
  and the selected identity provider must explicitly allow it.

## 0.1.13

### Fixed

- Allow the already validated OAuth client origin in the consent page's CSP
  `form-action`, so browser-enforced CSP permits the successful authorization
  redirect back to ChatGPT.

## 0.1.12

### Fixed

- OIDC-authenticated MCP consent preserves the original PKCE challenge across
  browser login, allowing the authorization-code exchange to complete.

## 0.1.11

### Changed

- Remote MCP OAuth can use direct OIDC. WikiKit verifies the identity and an
  explicit email allow-list before showing OAuth consent, so ChatGPT need not
  receive a WikiKit operator API key.

### Security

- OIDC login states are opaque, single-use and server-stored. OAuth grants
  remain scoped, refresh rotation remains intact, and an inactive external
  identity immediately invalidates its MCP bearer token.

## 0.1.10

### Added

- OAuth 2.1 authorization for public remote MCP clients such as ChatGPT:
  protected-resource and authorization-server discovery, safe dynamic public
  client registration, authorization code + PKCE S256, consent, scoped bearer
  tokens, rotating refresh tokens and token revocation.
- Hourly OAuth housekeeping for expired authorization artifacts, revoked token
  retention and unused dynamically registered clients.

### Security

- OAuth tokens are HMAC-hashed at rest, bound to the canonical `/mcp`
  resource, and revalidated against the backing WikiKit API key on every
  exchange and MCP request. Refresh-token replay revokes the whole token
  family. OAuth grants cannot obtain human-only approval or admin privileges.

## 0.1.9

### Added

- Durable ingest leases with unique owners, heartbeats and bounded expiry.
  Long-running LLM work now renews its lease, while crashed workers still end
  as auditable `worker_lost` failures.
- Administrative `GET /v1/api-keys` and idempotent
  `DELETE /v1/api-keys/{id}` endpoints. Inventory responses expose usage and
  revocation metadata but never plaintext keys or hashes; space-scoped admins
  remain confined to their own space.

### Changed

- Contradiction detection is cardinality-aware. Only predicates explicitly
  listed in a space's `settings.functional_predicates` are single-valued;
  undeclared predicates are multi-valued and complementary objects stay
  verified. The migration reconciles disputes and synthetic contradiction
  relations produced by the old blanket matcher.
- Lint excludes revisions explicitly marked as structural migration references
  from empty/orphan findings. Isolated Subkit-migrated content pages receive
  deterministic relations to their domain anchor; genuine claim-free pages
  remain visible as hygiene findings.

### Fixed

- Exact concept-slug search now bypasses PostgreSQL web-search hyphen operator
  parsing and receives a stable rank boost. Existing non-null vectors remain
  untouched; legacy null vectors are backfilled.
- The ingest reaper no longer judges liveness from the original `started_at`,
  which previously killed healthy jobs after 15 minutes when concurrency was
  greater than one.

## 0.1.8

**No runtime changes** — the binary is byte-identical to v0.1.7 (verified by
building both and comparing hashes). Upgrading is optional; this release exists
so the work below is in the record.

### Changed

- The two drift suites are now one (`test/unit/drift.test.ts`). They checked
  overlapping things with slightly different scanners, and that split cost
  accuracy rather than merely duplicating effort: the stricter of the two
  env-var scanners forced `WIKIKIT_SKIP_DOTENV` — a test-harness-only
  variable — into the operator documentation, because "a drift test wants it"
  is indistinguishable from "an operator needs it" when there is more than one
  list. Each of the 12 surviving checks was verified to still fail when the
  drift it guards is introduced; the 5 tests that disappeared were duplicates,
  not coverage.
- `docs/ARCHITECTURE.md` now lists every drift gate (the prompt-file and
  provider-key guards were missing) and states that codegen drift stays
  separate in `embedded-drift.test.ts` on purpose.
- `CONTRIBUTING.md` points at the test-tier table instead of restating the
  tiers a second time, 30 lines below it — the copy did not know about e2e.

## 0.1.7

### Added

- **Coding-agent loop for Claude Code and Codex**
  ([docs/coding-agent-integration.md](docs/coding-agent-integration.md)): a
  SessionStart hook injects the space's concept index plus a grounding rule, and
  a SessionEnd/Stop hook captures what the session taught. Ready-to-use hook
  scripts in [`examples/agent-hooks/`](examples/agent-hooks) — no CLI, just curl
  and jq, and every failure path exits silently so a knowledge base being down
  can never break a session.
- **Session distillation** (`POST /v1/spaces/{space}/agent/sessions`): post a
  coding-agent transcript; the server distils **only durable rules a human
  explicitly taught or corrected** and stages them as one ChangeProposal. A
  routine session answers `no_learnings` and writes nothing — capture is a
  filter first, so the review queue stays worth reading. The transcript is
  distilled and dropped, never archived (transcripts carry secrets; sources are
  kept forever). Distilled rules flow through the normal ingest pipeline, so
  they inherit content-hash dedup (re-teaching a rule → `already_captured`, not
  a duplicate), the grounding guard, and contradiction detection against
  existing knowledge.
- **Push gate** (`bun run gate`, `bun run hooks:install`): one command runs
  every check CI runs — lint, typecheck, unit + contract, integration, e2e —
  and installs as a `pre-push` hook, so a red CI run should be a surprise. It
  fails loudly when Docker is missing rather than quietly checking less than
  you think, and prints any `SKIP=` bypass in the summary.
- **E2E tier** (`test/e2e`, `bun run test:e2e`): the real `ai` +
  `@ai-sdk/anthropic` against a stub Anthropic endpoint
  (`config.anthropicBaseUrl`), so the vendor edge is covered — request shape,
  `cache_control` placement, usage mapping, error mapping. Every other tier
  injects `FakeProvider` and is blind to all of it: losing prompt caching
  multiplies the input-token bill while nothing else fails. No key, no network,
  no cost.
- **Benchmarks** (`benchmarks/`, `bun run bench`): deterministic and
  network-free — prompt rendering, the grounding guard's O(claims × source)
  normalization, the markdown pipeline, chunking. It reports and never gates
  (wall-clock assertions are flaky and train people to bypass gates); the cost
  regression that _does_ gate is the new `test/unit/prompt-budget.test.ts`,
  which caps system-prompt tokens — a prompt is billed on every call of its
  kind, forever, and nothing else noticed it growing.
- **MCP self-description**: the server now advertises a `resources` capability
  and returns usage `instructions` on `initialize`. `resources/list` /
  `resources/read` serve `llms.txt` and `llms-full.txt` over MCP, so an
  agent that can only speak MCP can still read the documentation written for it.

### Changed

- `503 llm_not_configured` now names the key of the **selected** provider — an
  `openai` deployment is no longer told to set `ANTHROPIC_API_KEY`.
- The `LlmProvider` interface gains a fourth method, `distill()`.

### Fixed

- Documentation drift across README, CHANGELOG, `docs/CONTRACTS.md` §10,
  `.env.example` and `.env.defaults`, all of which had gone stale since v0.1.3.
  Drift tests now cover them, plus the env templates and the CHANGELOG itself —
  the docs CI checks stayed accurate, the ones it did not check did not.
- `SECURITY.md` described an Anthropic-only LLM boundary and did not mention
  that session capture sends whole transcripts to the model provider.
- Removed `test/evals/`, an empty placeholder referenced by nothing since the
  initial commit.

## 0.1.6

### Added

- **Document upload** (`POST /v1/spaces/{space}/ingest/document`): send a
  `pdf`, `docx`, `xlsx`, `md`, `txt` or `csv` file as the raw request body with
  a `?filename=` query param — the extension selects the extractor. The
  document is extracted to Markdown and enters the same pipeline as any other
  source: archived verbatim, deduped by content hash, synthesized, and staged
  as one pending ChangeProposal.

## 0.1.5

### Changed

- **Verbatim-quote grounding guard**: a synthesized claim is kept only when its
  supporting quote occurs verbatim in the source the model actually read
  (whitespace- and case-normalized). The schema always required a non-empty
  quote but never verified it — a paraphrased or invented quote is an
  unverifiable citation. Ungrounded claims are dropped and logged with a
  `dropped`/`kept` count. Benchmarked at 0 false positives across 43 real
  grounded claims.

## 0.1.4

### Added

- **Multi-provider LLM**: `WIKIKIT_LLM_PROVIDER` selects `anthropic` (default),
  `openai` or `google`, with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or
  `GOOGLE_GENERATIVE_AI_API_KEY` respectively. Switching provider is a config
  value, not a code change; an invalid value fails the boot.

### Changed

- **LLM calls run on the Vercel AI SDK 7** behind the unchanged three-method
  `LlmProvider` interface: classify/synthesize/answer are one
  `generateObject(schema)` call each, constrained to the same Zod objects the
  rest of the system validates with. Transient failures (429/5xx) are retried
  with backoff instead of failing an ingest on the first blip.
- Anthropic prompt caching now measures as intended — the byte-stable system
  prompt rides as a cache-controlled leading text part, so calls after the
  first read the cached prefix.

### Removed

- `@anthropic-ai/sdk` and `src/llm/anthropic.ts`, replaced by `ai` +
  `@ai-sdk/{anthropic,openai,google}`.

## 0.1.3

### Changed

- Documentation presents WikiKit standalone — all references to sibling
  products removed.

## 0.1.2

### Fixed

- `llms.txt` and `llms-full.txt` are embedded at compile time, so the release
  binary serves them instead of 404ing outside a source checkout.

## 0.1.1

### Fixed

- The MCP transport is mounted in `createApp`, fixing a `404` on `POST /mcp` in
  production builds.

## 0.1.0

Initial release: a headless, AI-native knowledge system for humans and agents.

### Added

- **Ingest pipeline** (`POST /v1/spaces/{space}/ingest`, async): sources
  (markdown, text or URL) are archived verbatim with sha256 dedup, classified
  against the concept index, synthesized into concept revisions with claims,
  citations and relations, checked for exact-frame contradictions, and staged
  as one pending ChangeProposal per run.
- **Review gate**: proposal content is staged as real rows, structurally
  invisible to readers; `GET /v1/proposals/{id}` renders a structured diff
  (JSON, or `text/markdown` via Accept); approve/reject are atomic SQL
  functions with stale-base protection, reviewer audit and space-epoch bump.
- **Claims model**: subject/predicate/object statements with confidence,
  verbatim-quote citations and a lifecycle
  (`proposed → verified → disputed → deprecated`); contradicting pairs are
  disputed on approval and linked with a `contradicts` relation.
- **Decisions** as first-class records (context, decision, rationale,
  alternatives), extracted from meeting-style sources.
- **LLM-free query core**: PostgreSQL full-text `search` with `<mark>`
  headlines, and `lint` (contradictions, missing citations, broken relations,
  stale claims, orphans, …) as a CI-consumable report.
- **Grounded Q&A** (`POST /v1/spaces/{space}/query`): answers only from
  retrieved evidence with inline citations, flags disputed claims, and says
  "not in the knowledge base" instead of hallucinating.
- **MCP server** (Streamable HTTP at `/mcp`): scope-gated tool visibility with
  `wikikit_spaces`, `wikikit_briefing`, `wikikit_context`, `wikikit_search`, `wikikit_read`, `wikikit_sources`, `wikikit_decisions`,
  `wikikit_history`, `wikikit_lint`, `wikikit_ingest`, `wikikit_ingest_status`,
  `wikikit_propose` — deliberately no approve tool; session leases with idle
  TTL, hard cap and hijack guards.
- **Export/import**: deterministic zip bundles as an Obsidian-friendly
  Markdown tree (claims round-trip losslessly via frontmatter) or as an OKF
  v0.1 bundle; imports pass the same review gate as LLM output.
- **Standard Webhooks**: signed events (`wikikit.proposal.created`,
  `proposal.approved`, `proposal.rejected`, `concept.updated`,
  `ingest.failed`) from a transactional outbox with backoff and a circuit
  breaker.
- **Auth**: scoped, optionally space-scoped `wk_` API keys hashed with an
  HMAC pepper; scopes `knowledge:read` / `knowledge:propose` /
  `knowledge:approve` / `admin`.
- **Ops**: OpenAPI 3.1 generated live from the route registry
  (`/openapi.json`, with a committed snapshot), `llms.txt`/`llms-full.txt`
  served, Prometheus `/metrics`, `/health` and `/ready` probes, structured
  JSON logs, graceful drain, self-migrating single Bun binary
  (`--migrate`/`--version` ops flags), zero-config local development, and
  drift tests keeping code, spec and docs in lockstep.
