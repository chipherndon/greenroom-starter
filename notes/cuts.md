# Cuts

Things scoped out of the current prototype, with the reason and what would need to happen before reconsidering.

---

## Door deals

**What it is:** `dealType = "door"` is declared in the schema but the engine returns `{ supported: false }` for it, and the planned vs/net work doesn't add support.

**Why cut:** The schema declares the deal type but `ticketSales` doesn't distinguish door receipts from presales. Door deals typically pay the artist a % of *door receipts only* (excluding advance / presales), sometimes minus a per-head expense. Without a door-vs-presale split on `ticketSales`, the engine can't compute the right basis.

**What would need to happen first:**

- Talk to a few door-deal users (currently no transcript evidence for or against the pattern).
- Decide whether to split `ticketSales` into door vs presale (column addition or separate source) or capture door receipts as a settlement-time input.
- Scope per-head expense handling — some door deals deduct a flat per-head before the split.

**Pull from cuts when:** a customer or transcript shows door deals are blocking adoption, or when the broader engine work is stable enough to absorb a schema addition.

---

## Recoup cross-deal reporting

**What it is:** Queries like "show me every off-gross marketing recoup across all deals."

**Why cut:** The recoup plan stores clauses as JSON on the deal. Cross-deal queries require app-level JSON scanning at thousands-of-venues scale.

**Pull from cuts when:** product needs the reporting view, or when the deal-side JSON has enough adoption to justify a materialized view / nightly ETL into an analytics table.

---

## Historical recoup backfill

**What it is:** Mapping existing `settlements.recoupsJson` rows back into the new clause-vs-application shape.

**Why cut:** Out of scope for the prototype. The back-compat rule in the recoup plan (treat orphan applications as `outside_cap_pre_split` / `fixed`) is sufficient for in-flight settlements; historical settlements stay historical.

**Pull from cuts when:** moving from prototype to production, or when a customer needs historical reporting to match the new model.

---

## Two-sided agent confirmation flow

**What it is:** A workflow where the agent acknowledges the structured deal terms (including recoup clauses) before show day, producing a canonical pre-show artifact both sides agreed to.

**Why cut:** Larger workstream than the recoup data model itself. Multiple research transcripts (Mariana, Sarah, Marcus) independently asked for this, so it's high-value — but it needs its own design: agent-side UX, notification flow, lock semantics on the deal after confirmation, what happens when terms change post-confirmation.

**Pull from cuts when:** the recoup data model has shipped and the agent-side experience can be designed against real structured data instead of in the abstract.

---

## Deal email parsing for recoup language

**What it is:** Automatically extracting recoup clauses from pasted deal emails and pre-populating the structured fields.

**Why cut:** Speculative. The structured deal-entry flow needs to exist and be used before automation is worth building.

**Pull from cuts when:** bookers are reliably entering recoups structurally, and email-paste becomes the main friction point.
