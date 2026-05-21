# Greenroom Case Study Memo

After reviewing the provided materials one root issue was recurring: the product lacks direction and it tells no clear settlement story. Resulting in downstream financial confusion for its users and the observed lack of adoption. This memo defines and defends the slice required to create that direction.

## The slice

Give Mariana a settlement she can trust: the deal terms she negotiates over email captured at deal inception, and the math she walks the agent through at 2am rendered as a line-by-line statement the tour manager can trace. These two moments — deal modeling and the 2am walkthrough — are the bookends of every settlement; their mishandling today is the clearest evidence of the product's missing direction. The slice covers the mechanisms she actually books (vs, %-of-net, ratchets, recoups) and closes both ends.

## Why this cut

The brief surfaced several obvious problem areas: Industry standard deal types going unsupported, a high level of disputes, and structured fields drifting from prose. Exploring the codebase, data, and transcripts surfaced more: expenses consume most of Mariana's settlement time, dispute frequency is higher than the dispute thread alone suggests, the engine silently mishandles tier ratchets, lifecycle states drift from underlying data, and the prose escape hatch is the actual source of truth used by customers. Each of these feeds into the 18% adoption number, the single figure this slice has to move. My aim was to choose from the following identified problems to create the highest impact slice:

* Deal modeling — only flat and %-of-gross settle in-app; vs and %-of-net (the majority of bookings) fall through
* Recoup terms — no structured representation; lives entirely in prose
* Expense management — distributed across accounts, manual entry, dominates Mariana's time
* Deal renegotiation — terms change after the initial deal entry (phone calls, last-minute adjustments) and the structured fields don't allow for updates
* Recoup lifecycle — recoups have their own state (agreed/disputed/withdrawn) that runs independently of the settlement's overall lifecycle. A paid settlement can carry a still-disputed recoup with no surface to resolve it, that is not handled.
* Dispute resolution — no way to handle disputed settlements in our product
* Real-time prediction — predict whether a settlement will be clean vs messy before show day
* Post-show comms — no clean way to share traceable settlement math after the show.
* Lifecycle hygiene — UI status and underlying data disagree (the brief's spotting-it test)
* Cap enforcement — expense caps and hospitality caps are set at deal time but no part of the workflow enforces them.

Each candidate was ruled against the same question - does fixing it significantly address why 82% of customers don't use the in-app tool? Most fail that filter:

* Expense management is the loudest pain point in the transcripts, but the collection problem (cards, paper receipts, distributed accounts) is upstream of Greenroom and would require OCR/AI work of its own scope. More importantly: perfect expense capture doesn't move the adoption number, because spreadsheets have the same expense problem. This should be considered a feature request.
* Deal renegotiation, recoup lifecycle, and cap enforcement are real findings surfaced during data exploration and all belong on the roadmap. None are inception problems, they're edit-time workflow gaps and runtime enforcement gaps that need to build on top of structured deal entry. Renegotiation handling is the highest priority of the three, but none move the adoption number on their own.
* Disputes, post-show communication failures, and lifecycle hygiene issues are downstream effects of unclear terms at deal inception via our in-app tool. This is proven by the provided dispute thread, where no clear terms were set pertaining to where the recoup would be administered as well as the common use of the free text field. Solving the root cause should be the top priority.
* Real-time prediction is a new capability layered on an engine that can't handle most deals. It predicts the wrong number faster. That's completeness, not craft, and again does not move the adoption number.

The remaining two, deal modeling and recoup terms, mine down to the same problem: there is no structured way to capture industry-standard deals at inception. This is the slice. Vs and %-of-net deals get full engine support; recoup terms get a structured representation; both flow through to a line-by-line worksheet Mariana and the tour manager can trace.

Capturing deal terms in a structured way at inception resolves the downstream issues by construction. Clear terms mean fewer disputes. A traceable worksheet is the comms artifact. Lifecycle hygiene solves itself when the data is structured, as its cause was the hacky use of the free text field in the first place. The slice aims to solves their upstream cause. Feature requests move onto the roadmap where they belong.

## Design choices

### Data model

**JSON columns over new tables.** Recoup clauses live as `recoupClausesJson` on the deal; settlement-time applications stay in the existing `recoupsJson`. New `recoup_clauses` and `recoup_applications` tables would have been cleaner, but with 340 production venues, migration coordination would have dwarfed the slice. The codebase already used JSON for bonuses so the pattern is native. Trade-off: cross-deal querying is weaker.

**Clause vs application split.** Negotiated rights (deal-time) and billed amounts (settlement-time) are deliberately separate, joined by clause ID. Collapsing them loses the "negotiated X / billed Y / disputed Z" view — which is the exact distinction the Coastal Spell dispute hinged on. Trade-off: two JSON shapes to keep in sync which is mitigated by typed parsers.

### Engine contract

**Hard-fail with a typed error contract.** Unsupported and misconfigured deals return `kind: "deal_type_unsupported" | "deal_misconfigured"`; the UI renders a deliberately jarring empty state. This avoids silent fallback to $0 or partial math that would result in disputes. Visible failure is honest and maintains trust.

**Door deals explicitly out of scope.** The schema declares `dealType: "door"` but ticketing doesn't split door receipts from presales, so the basis can't be computed. Rather than guess, door deals hard-fail with a clear reason.

**Capacity-fraction ratchets inferred from data, not schema.** The existing data has two coexisting ratchet shapes (dollar-axis bands and capacity-fraction step functions) under one schema. The engine infers basis from the tier values (`< 1` ⇒ capacity, otherwise dollars) and branches accordingly. A schema-level `basis` discriminator is the right end state and is marked TODO; doing it now would force a backfill on the case-study snapshot and is out of scope.

### UI ↔ engine fidelity

**Worksheet renders directly from engine output.** Every row on the page is a `SettlementStep` the engine emitted; the UI does no derived math. Sarah's "itemization + provenance" requirement breaks without this rule. Trade-off: the engine emits display-shaped steps (a `kind` field per row), slightly conflating math and presentation; mitigated by typing.

**PDF export of the worksheet.** Once the engine's step list became canonical, exporting it as a PDF was a small addition — wire the existing steps through `jsPDF`. The artifact gives Mariana something traceable to send the tour manager, which addresses most of the post-show comms problem without making it its own slice.

**Math-first test suite.** 29 vitest tests covering every deal-type path, both ratchet bases, all recoup waterfall positions, overage owners, parser hardening, and the Coastal Spell regression. The existential risk is silent math drift (the tier ratchet bug had hidden in plain sight for months). All mitigated by a strong mathematical test suite. 

### User trust & migration

**Kept `dealNotesFreetext`.** Prose is what Mariana trusts today, our structured fields should earn trust over time. Forcing migration loses the user, or at the very least provokes anxiety. The slice makes structured *valuable enough* that prose becomes redundant, it doesn't ban prose by decree. Trade-off: prose and structure can still drift; surfacing both side-by-side on the show page makes drift visible.

## What I found in the data

Querying the SQLite snapshot against what the UI displays surfaced 10+ issues. The ones that mattered for this slice fall into a single pattern: structured fields exist but no part of the workflow keeps them honest. Issues the slice addresses:

1. Percentage drift — deal's `dealNotesFreetext` describes an 85/15 net split after renegotiation, but `deals.percentage` still reads `0.75`. The engine reads the structured field, so the artist would be paid 10% less than what was negotiated.
2. Incorrect dispute state — `settlements.status = "disputed"` while `settlements.signoffText` reads "Looks good — TM. Wire to the usual account." The internal `notes` field clarifies the TM signed off Sunday; his assistant flagged a production-overage line Monday. Three fields, three different versions of truth in one record.
3. Systemic recoup disputes — querying `settlements.recoupsJson` for `status = "disputed"` and joining back to the artist's agent surfaces five Daniel Hwang (WME) shows with disputed `marketing` recoups. Recoup disputes are a pattern tied to recoup ambiguity at deal time, not isolated incidents.

Other non-addressed issues surfaced in the data:

4. Bonus threshold drift — prose says one number, `bonusesJson` says another after a phone renegotiation. Same root cause as percentage drift; both point at a renegotiation workflow gap (top of the roadmap, see below).
5. Wrong `dealType` — prose describes a vs deal, structured field still says `percentage_of_net` from before the renegotiation. Again points to a renegotiation workflow gap.
6. Recoup miscoded — "Spotify pre-show ad spend" filed under `production_overage` instead of `marketing`. This is indicative of a UX issue in expense reporting.
7. Paid settlement with a still-disputed recoup — recoups have their own lifecycle independent of the rest of settlement. The lifecycle has no state for "paid but unresolved"
8. Hospitality cap silently overrun — cap set at $400, actual spend $620, nothing flagged `absorbedByVenue`. Currently we offer no method of enforcement.
9. `countsTowardGross` flag false with a note saying "agreed these count toward gross", flag-vs-prose drift on comp accounting indicated another UX issue in reporting.
10. Reversed `submittedAt` / `signedAt` timestamps on a paid settlement. Bug fix.
11. Duplicate sound expense entered by Marcus 3 hours after Mariana's entry, indicates another UX issue or oppurtunity for gating.
12. Frequent artist with `priorShowCount = 0` despite 4+ shows. Bug fix.

## How I'll validate

The leading metric is in-app adoption. If 18% becomes 35% in two quarters at venues with this slice rolled out, the slice worked. If it doesn't move, the slice didn't address the actual blocker, and we need to find out fast whether that's because the structured fields still don't fit real deals, or because Mariana doesn't trust the math enough to abandon her spreadsheet, or because the rendering doesn't beat her sheet's clarity. Adoption is the right north star here because it's the only metric that's downstream of every assumption the slice makes. Secondary metrics include decreases in both dispute rate on in-app settled shows moving and in the use of the `dealNotesFreetext` field.

## What needs to be shipped next

1. Renegotiation workflow — structured fields go stale when terms change post deal inception. Build: a "renegotiate" action that requires structured re-entry.
2. Recoup lifecycle as a first-class state machine - gives orphaned recoups a queue users can work through seperate from its parent settlement.
3. Two-sided agent view of structured deal terms - gives the agent a full lifecycle view of upcoming settlements, fostering more trust between our customer and the agent.
4. Door deal support - for completeness of the `dealMath.ts` engine.
5. Pre-show deal health prediction - Explicit ask from Marcus now possible from the structured data model, not critical but a nice-to-have for our decision making customers (Marcus).
6. Expense management - Highest-impact item on the broader roadmap. Requires a major refactor of how expenses are collected and reported in our system, likely including an OCR/AI workflow. Huge time unlock for our customers, but also a major undertaking. Should not be considered until we feel the rest of the settlement product has met the "craft" bar.

## Why I didn't implement any AI features

Despite this case study being for an Applied AI PM role, I deliberately did not add AI features to this slice. The work here is deterministic: deal terms have structure, settlement math has rules, recoup waterfalls have positions. None of it benefits from probabilistic reasoning, and all of it benefits from being legible and traceable, which is exactly what users said they wanted.

AI can unlock huge product capabilities when used right. Used wrong, it erodes trust in the entire product and team. This is a classic wrong scenario, the equivalent of bolting Copilot into Notepad. Adding "ask AI about your settlement" doesn't move the 18% adoption number, it just gives our users one more thing to distrust at our current product stage.

The right place for AI in this product is the expense reporting workstream which surfaced as the loudest pain point for Mariana. Receipts arrive across cards, accounts, paper, and email. Classifying them by category, matching them to the right show, and flagging anomalies (duplicate entries, cap overruns, miscategorizations) is exactly the kind of high-volume, low-stakes-per-decision, human-in-the-loop work where an AI assist amplifies a working human flow rather than replacing it. That's the AI-PM slice once this product gets more well refined.

## Assumptions

* Deal creation exists upstream of this slice — 340 production venues and 24 months of seeded deals imply the entry flow lives somewhere I didn't have access to in the starter (an admin tool, an importer, or a contract-system integration).
* The patterns surfaced in the DB are representative of real venue behavior — findings like the Hwang recoup-dispute pattern, the prose/structured drift on percentage and dealType, and the orphaned disputed recoups on paid settlements were treated as evidence of real-world failure modes. 

---
By: Chip Herndon
Completed on: May 20th, 2026

