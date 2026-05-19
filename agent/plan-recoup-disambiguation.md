# Plan: Recoup Disambiguation

Prototype implementation spec for capturing recoup terms as structured deal-time data with deterministic settlement math.

## Goal

Recoups have two phases that the current schema conflates:

1. **Clause** — the *negotiated right* to recoup, defined at deal creation. Includes waterfall position, amount model, and cap. Always knowable at deal time.
2. **Application** — the *actual amount billed* against a clause on settlement night. Only knowable post-show.

This plan splits the two so that the waterfall placement (the Coastal Spell ambiguity) is locked in at deal time, while actual amounts are entered at settlement time. No new tables — both objects live in JSON columns, matching the existing `bonusesJson` pattern.

---

## Backend changes

### New column: `deals.recoupClausesJson`

Recoup *terms* live on the deal as a JSON array, alongside `bonusesJson`.

```ts
// Added to the existing deals table
recoupClausesJson: text("recoup_clauses_json"),
```

Shape (documented in a schema comment, mirroring how `bonusesJson` is documented):

```ts
export type RecoupClause = {
  id: string;                          // stable ID, referenced by applications (see ID generation below)
  label: string;                       // "Marketing recoup — radio + IG boost"
  category:
    | "marketing"
    | "prior_advance"
    | "production_overage"
    | "hospitality_overage"
    | "backline"
    | "damages"
    | "other";

  // Where this recoup applies in the settlement waterfall.
  //   "off_gross"             — deducted from gross before split or cap
  //   "inside_expense_cap"    — counts against the deal's expense cap
  //   "outside_cap_pre_split" — separate deduction off net, before split
  //   "post_split"            — comes out of artist's share after split
  waterfallPosition:
    | "off_gross"
    | "inside_expense_cap"
    | "outside_cap_pre_split"
    | "post_split";

  // "fixed"           — amount is the billed amount; no settlement-time entry
  // "actual_up_to"    — actuals billed, capped at capAmount
  // "actual_uncapped" — actuals billed, no ceiling
  amountModel: "fixed" | "actual_up_to" | "actual_uncapped";

  fixedAmount: number | null;          // set when amountModel = "fixed"
  capAmount: number | null;            // set when amountModel = "actual_up_to"

  // Who eats the overage when actuals exceed capAmount.
  // Only meaningful when amountModel = "actual_up_to".
  overageAbsorbedBy: "venue" | "artist" | "split" | "n_a";
  overageSplitPct: number | null;      // artist's share, 0..1, when "split"

  // Free-text note from the booker on intent / source.
  // Booker can paste the deal-email sentence here if useful.
  rationale: string | null;
};
```

### Existing column: `settlements.recoupsJson` — unchanged shape

Current shape stays as-is:

```ts
{ id, category, label, amount, status }
```

Reinterpretation (documentation-only change):

- `id` now references a `RecoupClause.id` on the deal.
- `amount` is the actual billed amount (`actualAmount`).
- `category` and `label` remain as denormalized snapshot fields so historical settlements render correctly even if the clause label is later edited.
- `status` unchanged: `"agreed" | "disputed" | "withdrawn"`.

Zero migration on this column. The only thing that changes is what new writes mean.

### Settlement engine (`lib/dealMath.ts`)

The engine currently doesn't handle recoups. Add waterfall-aware application:

```
gross  = sum(ticket_sales.gross)
fees   = sum(ticket_sales.fees)

# 1. off_gross recoups deduct first
gross_after_off_gross = gross - sum(applications where clause.position = "off_gross")

# 2. CC/platform fees come off gross-after-recoups
net = gross_after_off_gross - fees

# 3. expense cap covers expenses + inside_cap recoups together
expenses_subject_to_cap = sum(expenses)
                        + sum(applications where clause.position = "inside_expense_cap")
capped_expenses = min(expenses_subject_to_cap, deal.expense_cap)

# 4. outside_cap_pre_split recoups deduct after the cap, before split
net_after_expenses = net - capped_expenses
                   - sum(applications where clause.position = "outside_cap_pre_split")

# 5. split (% or vs)
artist_share = apply_split(deal, gross, net_after_expenses, guarantee)

# 6. post_split recoups come out of artist's share last
artist_payout = artist_share - sum(applications where clause.position = "post_split")
```

Each step emits a `steps[]` entry so the settlement statement renders line-by-line.

Engine reads:
- Clauses via `parseRecoupClauses(deal)` — new helper, modeled on `parseBonuses`.
- Applications via existing `recoupsJson` parse.
- Joins them by `application.id === clause.id`.

### ID generation for clauses

Clause IDs need to be stable and unique — they're the link target for settlement applications. Two contexts generate them differently:

- **Runtime (booker adds a clause in the deal form)**: `crypto.randomUUID()` generated client-side at the moment the row is added. The UUID is the React key for the row, the form-state identifier, and the permanent clause ID once the deal is saved. Client-side generation is required because the live waterfall preview needs an ID before the deal hits the server.
- **Seed (`db/seed.ts`)**: match the existing settlement-recoup ID pattern: `recoup_${showId}_${id++}` (see [db/seed.ts:654](db/seed.ts#L654)). Determinism matters in the seed — back-compat plants like BC12 reference recoup IDs by name across multiple settlements. When seeding deals with `recoupClausesJson`, use this same pattern so a seeded clause and its matching seeded application share the same ID.

The application side (`settlements.recoupsJson` entries) keeps using whatever the seed assigns or whatever the clause's ID is — applications never generate their own IDs, they only reference clause IDs.

### Deliberate divergence from `parseBonuses` `parseBonuses` returns `[]` on any failure — malformed JSON, missing fields, anything. That all-or-nothing behavior is part of why half the deals at The Crescent route bonuses into prose instead. `parseRecoupClauses` is more granular:
- Malformed top-level JSON → return `[]` (matches `parseBonuses`).
- Individual clause missing a required field (`label`, `waterfallPosition`, `amountModel`) → omit *that clause* from the result with a logged warning; keep the well-formed clauses.

The reasoning: losing all clauses because one is broken is worse than losing one. Settlement-time validation catches the missing clause when the booker tries to sign off. Implementers should preserve this divergence — it's intentional, not a bug.

### Engine: error type contract

Reuses the `{ supported: false, kind, reason }` shape introduced in [plan-vs-and-net-deals.md](plan-vs-and-net-deals.md). Recoup-driven failures use `kind: "deal_misconfigured"` — they're fixable by editing the deal, not unsupported deal types.

### Back-compat handling

For settlements created before this change:

- `deals.recoupClausesJson` will be `null` — old deals have no clauses.
- `settlements.recoupsJson` rows exist but their `id` doesn't reference any clause.
- Engine falls back to treating an orphan application as a clause with `waterfallPosition = "outside_cap_pre_split"` and `amountModel = "fixed"`. This is the safest default — produces the least payout drift from prior behavior.

### Validation rule

At settlement signoff, every clause on the deal must be resolved:

- `fixed` clauses auto-resolve (the amount is the clause's `fixedAmount`).
- `actual_up_to` and `actual_uncapped` clauses require either an `actualAmount` entry or a `status: "withdrawn"`.
- Submitting a settlement with unresolved clauses is blocked with a clear error pointing at the missing rows.

This is the backstop against "we forgot the marketing recoup" surprises at 2am.

### Type exports in `db/schema.ts`

```ts
export type RecoupClause = { /* as above */ };
export type WaterfallPosition =
  | "off_gross"
  | "inside_expense_cap"
  | "outside_cap_pre_split"
  | "post_split";
```

Existing `Recoup` type stays as the application-side shape.

### Migration

- One additive migration: add nullable `recoup_clauses_json` column to `deals`.
- No changes to `settlements` table.
- No data backfill required.

---

## Frontend changes

### Deal creation / edit form

Add a **Recoups** section next to expense cap / hospitality cap. Empty by default with a single "+ Add recoup" button.

Each clause row exposes:

| Field | UI control | Notes |
|---|---|---|
| Label | text input | Required. Placeholder: "Marketing recoup — radio + IG boost" |
| Category | select | Dropdown matching the enum |
| Amount model | segmented control | "Fixed $" / "Actuals up to $" / "Actuals (uncapped)" |
| Fixed amount | money input | Shown only when model = "fixed" |
| Cap amount | money input | Shown only when model = "actual_up_to" |
| Waterfall position | radio with descriptions | See below |
| Overage absorbed by | select | Visible only when model = "actual_up_to"; default "venue" |
| Rationale | textarea | Optional. Booker can paste source language here if useful |

### Waterfall-position picker

Labeled radio options, not a bare dropdown. Each option shows label + one-line description + inline math hint:

```
Where does this recoup apply?
○ Off gross                  Deducted from gross before anything else
                             (gross − recoup) × split
○ Inside expense cap         Counts against the deal's expense cap
                             Bundled with expenses; cap still applies
○ Outside cap, before split  Separate deduction off net, after expenses
                             (net − expenses − recoup) × split
○ Post-split                 Comes out of the artist's share last
                             artist_share − recoup
```

No default — booker must pick. Forces explicit resolution of the Coastal Spell ambiguity.

### Live waterfall preview

Below the recoups list, render a **"What this deal pays at $X gross"** card. Default gross to a midpoint (e.g., 70% of capacity × average ticket price). Updates reactively as fields change.

```
At $20,000 gross:
  Gross                          $20,000
  − Marketing recoup (off gross)   −$900
  = Adjusted gross                $19,100
  − CC fees (10%)               −$1,910
  = Net                          $17,190
  − Expenses (capped at $2,500)  −$2,500
  = Net after expenses           $14,690
  × 80% to artist                $11,752
  ─────────────────────────────
  Artist payout                  $11,752
  Venue keeps                     $5,448
```

Include a gross slider/input so the booker can sanity-check multiple scenarios. For `actual_up_to` clauses, the preview assumes actuals === cap (worst case for the artist).

### Templates

"Start from template" affordance at the top of the Recoups section:

- "Marketing recoup (off gross)"
- "Marketing recoup (inside cap)"
- "Prior advance (post-split)"
- "Production overage (inside cap)"

Selecting a template prefills label, category, amount model, and waterfall position.

### Settlement screen — Recoups section

New section that auto-populates from the deal's clauses. One row per clause:

- **Fixed clauses** — pre-filled, read-only amount. Display only.
- **`actual_up_to` clauses** — money input next to the cap hint: *"Marketing recoup — billed $___  (cap: $900)"*. Booker enters actual.
- **`actual_uncapped` clauses** — money input with no cap hint.
- Every row has a "Withdraw" affordance that sets `status: "withdrawn"` and exempts the row from the validation gate.

Settlement signoff is blocked until every row is resolved (amount entered or withdrawn).

### Settlement statement (read-side)

Each application renders as a line item with:

- The clause's `label`, the application's `actualAmount`, and the clause's `waterfallPosition`.
- "ⓘ" hover showing the clause's `rationale`.
- "Agreed / disputed" toggle that writes back to the application's `status`.

### Deal summary view

On the show detail page, one-line summary per clause so the deal is scannable without opening the editor:

> *Marketing recoup (up to $900, off gross) — "marketing recoup of $900 against gross"*

(The quoted text comes from `rationale` if the booker pasted source language there.)

---

## Open questions

- Should waterfall position have a default, or force an explicit choice? **Forcing** — eliminates silent-default failure mode.
- Multiple clauses at the same waterfall position — model handles it; math sums them.
- Editing a clause after settlement is signed — should probably be blocked or require explicit confirmation, since the application snapshots the label/category but not the waterfall position. Could lead to drift if the position changes post-signoff.

## Tests

Assumes Vitest is set up (see [plan-vs-and-net-deals.md](plan-vs-and-net-deals.md) — that plan introduces the framework). Engine tests extend `lib/dealMath.test.ts`; parser tests live alongside the parser helpers.

### `parseRecoupClauses` (new helper)

- Valid JSON array → parsed clauses returned in order.
- `null` or missing column → empty array.
- Malformed JSON → empty array (matches `parseBonuses` behavior; the validation gate catches missing structure at the UI layer instead).
- Clause missing required field (`label`, `waterfallPosition`, `amountModel`) → omitted from result with a logged warning. Do not throw; the engine should still produce a number for the well-formed clauses.

### Recoup waterfall application (engine)

All tests pass `recoupApplications` into `computeNetAfterExpenses` and assert step ordering, amounts, and final payout.

**Per waterfall position — assert deduction lands at the right step:**
- `off_gross` recoup: $900 off-gross recoup on $20K gross → assert step between "Gross box office" and "− Fees".
- `inside_expense_cap` recoup: bundles with expenses against the cap. Test the three cases:
  - Expenses + recoup under cap → full sum deducts.
  - Expenses + recoup exactly at cap → exact deduction.
  - Expenses + recoup over cap → clipped to cap; step note names what got clipped.
- `outside_cap_pre_split` recoup: deducts after capped expenses, before split → assert step ordering.
- `post_split` recoup: deducts from artist's share after the split → assert artist payout reduced, venue share unaffected.

**Multiple clauses at the same position:**
- Two `off_gross` recoups ($500 + $400) → assert summed deduction = $900 with two distinct step entries.
- Mix of all four positions on one deal → assert end-to-end waterfall with correct step ordering.

**Amount model handling:**
- `fixed` clause → uses `fixedAmount` directly, no application input required.
- `actual_up_to` clause with actual under cap → uses actual.
- `actual_up_to` clause with actual over cap → uses cap; assert overage handling per `overageAbsorbedBy`:
  - `venue` → cap applied, overage absorbed silently in steps.
  - `artist` → cap applied, overage deducted from artist's share with a dedicated step.
  - `split` → cap applied, overage split per `overageSplitPct`.
- `actual_uncapped` clause → uses actual, no cap logic.

**Status handling:**
- `withdrawn` application → skipped entirely, no step entry, no math effect.
- `disputed` application → still applied to the math; status is metadata only.
- `agreed` application → applied normally.

### Back-compat (orphan applications)

Critical seam — settlements created before this change have `recoupsJson` rows whose `id` doesn't match any clause.

- Application with no matching clause → engine treats it as `waterfallPosition = "outside_cap_pre_split"`, `amountModel = "fixed"`. Assert this produces the same number the pre-change engine would have produced (snapshot test against current behavior).
- Application with a matching clause → uses the clause's `waterfallPosition`.
- Mix of orphan and matched applications on the same settlement → each handled per its own rule.

### Validation gate (UI-level, tested at the controller/server-action layer)

- Settlement with all clauses resolved (amounts entered or withdrawn) → signoff succeeds.
- Settlement with an `actual_up_to` clause that has no application → signoff blocked with error naming the missing clause.
- Settlement with no clauses on the deal → signoff succeeds (nothing to validate).
- Settlement where all clauses are `fixed` → signoff succeeds without explicit application entries (fixed clauses auto-resolve).

### The Coastal Spell regression test

A named, dedicated test that reproduces the March 2025 dispute end-to-end. This is the lawnmower test for the whole plan — if it ever fails, the plan failed.

```
Deal:
  - dealType: vs
  - guaranteeAmount: 5000
  - percentage: 0.80
  - percentageBasis: net
  - expenseCap: 2500
  - recoupClauses: [
      { label: "Marketing recoup", amountModel: "fixed", fixedAmount: 900,
        waterfallPosition: "inside_expense_cap" }
    ]

Inputs:
  - gross: 19840
  - fees: 1984
  - expenses: 0 (all expense load is the marketing recoup)

Assertions:
  - cappedExpenses = 900 (recoup bundled with expenses, under cap)
  - netAfterExpenses = 16956
  - percentageSide = 13565
  - winner = "percentage"
  - artistPayout = 12285
  - step list names "Marketing recoup (inside expense cap)" as a distinct entry
```

Then a sibling test with the same deal but `waterfallPosition: "off_gross"`:
- Asserts `artistPayout = 11565`
- Asserts the *difference* between the two payouts is exactly $720 — the literal Coastal Spell dollar amount.

This test makes the cost of the original ambiguity concrete in code. Anyone reading the test understands what the plan is fundamentally for.

## Sequencing

1. Schema: add `deals.recoupClausesJson` column + migration.
2. Types and parser helper in `db/schema.ts` and `lib/dealMath.ts`.
3. Update `dealMath.ts` to apply recoups in waterfall order; expand `steps[]` output.
4. Update `db/seed.ts`: add at least one deal with a clause at each waterfall position (`off_gross`, `inside_expense_cap`, `outside_cap_pre_split`, `post_split`), at least one with `amountModel = "actual_up_to"`, and at least one settlement with a withdrawn clause. Without this, the UI has no realistic data to render.
5. Deal form: recoups section + waterfall picker + live preview.
6. Settlement screen: auto-populated recoups section + validation gate.
7. Settlement statement: render applied recoups with rationale tooltip.
8. Templates + deal summary line.
9. (Later) two-sided agent confirmation flow.
