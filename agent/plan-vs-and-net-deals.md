# Plan: Vs and Net Deal Support

Prototype implementation spec for closing the gap between the deal types the schema already declares and the deal types `lib/dealMath.ts` can actually evaluate.

## Goal

The `deals` table declares five deal types: `flat`, `percentage_of_gross`, `percentage_of_net`, `vs`, `door`. The engine handles the first two. Close the gap for `percentage_of_net`, `vs`, and `tier_ratchet` bonuses — using fields the schema already provides. `door` is deferred (see [notes/cuts.md](../notes/cuts.md)).

Mariana: *"probably 70% of my deals at this venue are vs deals... your tool can't do those."* This is the work that gets her off the spreadsheet.

## Non-goals (for this pass)

- New deal-table fields. Everything here uses existing columns.
- Recoup waterfall (covered in `plan-recoup-disambiguation.md`).
- Door deal support (deferred — see [notes/cuts.md](../notes/cuts.md)).

---

## Backend changes

### Engine: `percentage_of_net`

Read `deal.percentage` and apply it to net-after-capped-expenses.

```
gross         = sum(ticket_sales.gross)
fees          = sum(ticket_sales.fees)
net           = gross - fees
expenses_raw  = sum(expenses where not absorbed_by_venue)
capped_exp    = min(expenses_raw, deal.expense_cap ?? expenses_raw)
net_after_exp = net - capped_exp
artist_payout = net_after_exp * deal.percentage
```

Emit `steps[]`:
- Gross box office
- − Fees → Net
- − Expenses (with cap note if the cap clipped)
- × percentage → artist payout

Validation: `percentage` must be set; `expense_cap` is optional (no cap = uncapped expenses, which is allowed).

### Engine: `vs`

The vs deal is `max(guarantee, percentage × basis)`, where `basis` is either net-after-capped-expenses or gross, depending on `deal.percentageBasis`.

```
gross         = sum(ticket_sales.gross)
fees          = sum(ticket_sales.fees)
net           = gross - fees
expenses_raw  = sum(expenses where not absorbed_by_venue)
capped_exp    = min(expenses_raw, deal.expense_cap ?? expenses_raw)
net_after_exp = net - capped_exp

basis = deal.percentageBasis === "gross" ? gross : net_after_exp

percentage_side = basis * deal.percentage
guarantee_side  = deal.guaranteeAmount

artist_payout = max(percentage_side, guarantee_side)
winner        = percentage_side >= guarantee_side ? "percentage" : "guarantee"
```

Emit `steps[]` with both sides visible — this is the most important part for Mariana. The tour manager needs to see *which side won and by how much*, not just the final number.

Step ordering for **vs-against-net** (`percentageBasis = "net"` or unset):
1. Gross box office
2. − Fees → Net
3. − Expenses (with cap note)
4. Net after expenses
5. **Guarantee side** — show the flat guarantee amount
6. **Percentage side** — show `net_after_exp × pct = X`
7. **Winner** — name which side won and the margin (e.g., *"Percentage side wins by $1,752"*)
8. Artist payout

Step ordering for **vs-against-gross** (`percentageBasis = "gross"`):
1. Gross box office
2. **Guarantee side** — show the flat guarantee amount
3. **Percentage side** — show `gross × pct = X`
4. **Winner** — name which side won and the margin
5. Artist payout

(Expense steps are omitted from vs-against-gross because expenses don't factor into the percentage side. Net is still computed and reported in the calculation result for display elsewhere, but it doesn't drive the math.)

`finalFormula` reads:
- vs-against-net: *"max($5,000 guarantee, 80% × $15,356 net) = $12,285"*
- vs-against-gross: *"max($5,000 guarantee, 15% × $19,840 gross) = $5,000"*

Validation: both `guaranteeAmount` and `percentage` must be set. `percentageBasis` defaults to `"net"` if unset on a vs deal.

### Engine: `tier_ratchet` bonus evaluation

The schema already defines the `tier_ratchet` bonus shape ([db/schema.ts:316-319](db/schema.ts#L316-L319)):

```ts
{ type: "tier_ratchet", label: string,
  tiers: [{ from: number; to: number | null; percentage: number }] }
```

The engine currently flags ratchets as not-evaluable because vs/net aren't supported. Once those land, ratchets become a piecewise function applied to the same basis the deal's primary percentage would use.

Three cases — all use the same tier-walk helper against different bases:

- **Ratchet on a `percentage_of_net` deal** — basis is `net_after_exp`. Replaces the flat `percentage × net_after_exp` step.
- **Ratchet on a `vs` deal** — basis is whichever the deal's `percentageBasis` says (`net_after_exp` or `gross`). Tier walk produces the percentage side; guarantee side unchanged; winner comparison proceeds as normal.
- **Ratchet on a `percentage_of_gross` deal** — basis is `gross`. Replaces the flat `percentage × gross` step. Unusual in practice but the schema allows it and the math is identical in shape.

The tier walk itself:

```
payout = 0
for tier in tiers:
  band_top    = tier.to ?? basis
  band_amount = max(0, min(basis, band_top) - tier.from)
  payout     += band_amount * tier.percentage
```

Emit one `steps[]` entry per tier band that contributed, so the tour manager can see *"$0–$10K @ 80% = $8,000; $10K–$15,356 @ 85% = $4,553"*.

**Validation — hard-fail malformed tiers.** Ratchets must satisfy:
- First tier's `from` is 0.
- Tiers are contiguous: each tier's `from` equals the previous tier's `to`. No gaps, no overlaps.
- Last tier's `to` may be `null` (open-ended); intermediate tiers must have numeric `to`.
- Tiers are sorted by `from` ascending.

When any invariant fails, return `{ supported: false }` with a **specific** reason that names the offending tier and what's wrong (e.g., *"Ratchet tier 2 starts at $15,000 but tier 1 ends at $10,000 — there's a $5,000 gap. Edit the deal to fix the tiers."*). No silent fallback to the flat percentage — that's the `bonusesJson` trap and produces quietly-wrong settlements.

### Engine: `comps.countsTowardGross`

The `comps` table already has a `countsTowardGross` flag ([db/schema.ts:174-176](db/schema.ts#L174-L176)) that the engine ignores. Fold it into the gross calculation up front:

```
ticketed_gross = sum(ticket_sales.gross)
counted_comps  = sum(comps where countsTowardGross) — count × faceValue
grossBoxOffice = ticketed_gross + counted_comps
```

Apply this once at the top of `calculateSettlement` so every downstream deal type sees the same gross. Emit a step entry when `counted_comps > 0` so the addition is visible (*"+ $400 in comp value (counts toward gross per deal terms)"*).

This requires the engine to receive `comps` in its `CalcInput`. Add `comps?: Comp[]` to the input interface; treat empty/undefined as zero counted comps.

### Engine: shared helpers

Two helpers worth extracting since vs and percentage_of_net share most of their setup:

```ts
function computeNetAfterExpenses(deal, ticketSales, expenses, comps, recoupApplications = []) {
  // returns { gross, fees, net, cappedExpenses, netAfterExpenses, steps[] }
}

function applyTierRatchet(tiers, basis) {
  // returns { payout, steps[] }
}
```

Both emit their own `steps[]` entries so the calling deal-type branch can splice them into the response without rebuilding them.

**Coordination with the recoup plan.** `computeNetAfterExpenses` accepts a `recoupApplications` parameter (default `[]`) so [plan-recoup-disambiguation.md](plan-recoup-disambiguation.md) can extend it without refactoring. The helper's step output respects waterfall positions even when no recoups are present — off-gross recoups deduct before fees, inside-cap recoups bundle with expenses against the cap, outside-cap-pre-split recoups deduct after capped expenses. With an empty `recoupApplications`, the step list collapses to the simpler vs/net ordering described above. Build vs/net first so the helper exists; recoups slot in by populating the parameter.

### Engine: no schema changes

Every field needed is already on the schema. No migration. No new columns. Pure logic.

### Engine: error type contract

The existing engine returns `{ supported: false, reason: string }` for everything it can't compute. The new validation work introduces two semantically different failures:

- **Deal-type unsupported** — "this tool can't handle this kind of deal." Existing behavior; user should know to settle elsewhere.
- **Deal misconfigured** — "this deal has a fixable problem." E.g., malformed ratchet tiers, missing `guaranteeAmount` on a vs deal. User should fix the deal and retry.

Distinguish in the return type so the UI can render them differently:

```ts
| {
    supported: false;
    kind: "deal_type_unsupported" | "deal_misconfigured";
    reason: string;
    dealType: Deal["dealType"];
  }
```

UI uses `kind` to pick the right empty state — "settle in your spreadsheet" vs "edit the deal."

---

## Frontend changes

### Settlement view — render the new `steps[]`

The existing settlement view already renders `SettlementCalculation.steps`. The vs-deal additions need two things from the UI:

- **Winner callout** — when the step set includes a "Winner" entry, render it with visual emphasis (badge, color, or "X side wins" treatment). This is the moment the agent reads first.
- **Side-by-side comparison** — for vs deals, render the guarantee and percentage sides as a small two-column block so the comparison is scannable, with the winner highlighted. Not required for correctness, but it's the Mariana-trusts-the-math affordance.

For `percentage_of_net`, the existing one-column step list is fine — no comparison to render.

For tier ratchets, each band shows as its own step row, indented under a "Tier ratchet applied" header.

### Deal form — no immediate changes required

The fields already exist (`dealType`, `guaranteeAmount`, `percentage`, `percentageBasis`, `expenseCap`). The form likely needs minor work to make sure all four are editable and validated correctly for the new deal types, but no new fields.

One small addition worth considering: on a vs deal, show a live preview (similar to the recoup plan's waterfall preview) of `max(guarantee, percentage × hypothetical_net)` at a default gross. Helps the booker sanity-check the deal terms at creation. Optional for v1.

---

## Tests

### Vitest setup

No test framework is currently set up. First test work adds:

- `vitest` as a dev dependency. No React-DOM plugin needed for engine tests; add `@vitejs/plugin-react` and `jsdom` only when UI tests come online (later).
- `vitest.config.ts` at the repo root with `test.environment = "node"` (engine tests don't need a DOM).
- Tests colocated as `*.test.ts` next to the file under test (e.g., `lib/dealMath.test.ts`). No `__tests__/` directory.
- `package.json` script: `"test": "vitest run"` and `"test:watch": "vitest"`.

All engine tests live in `lib/dealMath.test.ts` and exercise `calculateSettlement` against fixture inputs. The engine is pure (no DB, no IO), so tests are deterministic and fast.

### Test fixtures

Each fixture is a plain object: `{ deal, ticketSales, expenses, comps?, venueCapacity?, ticketsSold? }`. Share fixtures across the two plans — the recoup plan extends the same shape.

### Coverage

**`percentage_of_net`**
- Happy path: gross $20K, fees 10%, expenses $1K, cap $2.5K, 80% → asserts artist payout, totalExpenses, netBoxOffice.
- Expense cap clips: expenses $5K, cap $2.5K → assert capped at $2.5K and step note reflects clipping.
- No cap: `expense_cap = null` → assert all expenses pass through.
- Absorbed-by-venue expenses excluded from totals.
- Missing `percentage` → `{ supported: false }` with specific reason.

**`vs` (against net)**
- Percentage side wins: high gross, low guarantee → assert winner = "percentage" and margin in steps.
- Guarantee side wins: low gross, high guarantee → assert winner = "guarantee".
- Tie (percentage == guarantee) → asserts deterministic tiebreak (lean toward percentage to favor the artist when even).
- Expense cap interaction: same gross with cap vs no cap → assert payout differs as expected.
- Missing `guaranteeAmount` or `percentage` → unsupported.

**`vs` (against gross)**
- `percentageBasis = "gross"`: assert percentage side uses gross, not net-after-expenses; assert step list omits expense-step entries.
- Compare same inputs with basis=`net` vs basis=`gross` — assert different payouts and different step lists.

**`tier_ratchet`**
- On `percentage_of_net`: tiers `[{0, 10000, 0.80}, {10000, null, 0.85}]`, net $15,356 → assert two band steps and correct sum.
- On `vs` (net basis): same tiers, percentage side computed via ratchet, guarantee comparison still applied.
- On `vs` (gross basis): ratchet walks gross.
- On `percentage_of_gross`: ratchet walks gross.
- **Malformed tier validation — each is its own test, each asserts `{ supported: false }` with a specific reason naming the offending tier:**
  - First tier `from != 0`.
  - Gap between tiers (tier 2 `from` > tier 1 `to`).
  - Overlap between tiers (tier 2 `from` < tier 1 `to`).
  - Intermediate tier has `to: null`.
  - Tiers not sorted by `from`.

**`comps.countsTowardGross`**
- Comps with flag = true → assert `grossBoxOffice` includes `count × faceValue` and a step entry appears.
- Comps with flag = false → assert `grossBoxOffice` unchanged.
- Mix of both → only flagged comps add.
- No comps passed (undefined `comps` in input) → no error, gross unchanged.

**`computeNetAfterExpenses` helper (direct)**
- Called with empty `recoupApplications` → step list matches the vs/net-only ordering.
- Called with mock recoup applications at each waterfall position → assert step ordering: off-gross before fees, inside-cap bundles with expenses (subject to cap), outside-cap-pre-split deducts after capped expenses. This test exists in the vs/net plan to prove the seam works before the recoup plan ships.

**Back-compat**
- Existing supported deal types (`flat`, `percentage_of_gross`) — keep all current behavior. Snapshot the calculations from the existing engine before refactoring; assert post-refactor matches.

## Sequencing

1. Set up Vitest (config, script, first passing test).
2. Refactor `calculateSettlement` to share gross/net/cap setup across deal types (`computeNetAfterExpenses` helper).
3. Wire `comps.countsTowardGross` into gross calculation. Update `CalcInput`.
4. Implement `percentage_of_net` (uses the new helper).
5. Implement `vs` (uses the helper + winner-comparison logic + `steps[]` for both sides; handles both `percentageBasis` values).
6. Implement `tier_ratchet` evaluation (`applyTierRatchet` helper) and wire into `percentage_of_net`, `vs`, and `percentage_of_gross`.
7. Update `db/seed.ts`: add at least one vs deal (against net), one vs deal (against gross), one `percentage_of_net` deal, and one deal with a tier ratchet. Without this, the UI work has no realistic data to render against.
8. Settlement view: render winner callout and side-by-side comparison for vs deals; render tier-ratchet bands.
