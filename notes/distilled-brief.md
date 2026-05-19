# Project Brief

A distilled version of the case study brief for my own reference. Captures what I found important, what I'm treating as actionable, and how I framed the problem. Lots of the source material is useful, but distilling it down to what's both critical and actionable is the first step to approaching any problem, and consequently building any product that aims to solve one.

## Important Points from the Brief (added while reading)
* Greenroom is a startup SaaS providing an all in one solution for small indie venues in the music industry.
* Working with the Crescent, a 650 capcity venue, relevant stakeholder is Mariana Reyes (lead booker).
* College us Marcus Holland and CEO is Pri Lyer.
* **Important:** Settlement is a complex problem with multiple sub-parts, pick a slice (or coupled slices) and built for it.
    * Reqs:
        * Defensible and opinionated explanation (PRD memo, 1-2 pages).
        * Working prototype.
        * Loom video (5-10min).
    * Eval:
        * Scope tightly and defend it.
        * Go deep.
        * Show reasoning.
        * Design for humans.
        * Use AI to amplify judgement.
    * Live Interview:
        * Pitch the slice, answer why.
        * Stree test.
        * Curveball (looking forward to it)
* Real data is messy, UI is flawed **DO NOT TRUST**
    * **TASK**: Investigate the db schema and it's seeded data.
    * Example: UI shows disputed status but the deal is actually settled.
* Stellemment Example:
    * Vs deal $5000 guarentee versus 80% of net adter expenses, whatever is greater. `max(5000, 0.80 × N)` for this deal.
    * Takes receipts and inputs them by hand into the **spreadsheet**, not our settlement tool. 
        * **OPPORTUNITY**: Are these receipts all incurred on the same card/account? Opportunity for financial integration here to lessen manual input.
        * **OPPORTUNITY**: If expenses are distributed across accounts and messy, a scan system with a small visual llm (Gemma E2B embedded in broswer, or a slighly larger model via api) can help.
    * There's a unclear $300 regrading marketing recoup in the deal email. 
        *  **OPPORTUNITY**: I see this as an issue caused by the users unclear deal, maybe we should approach settlement as something that truly starts from the deals inception, not only try to capture the resulting mess after the fact.
* CEO calls our soluton "comprehensive but mediocre", saying "Our settlement experience is the place we are most clearly losing on craft. Our customers love us in spite of it, not because of it." **THIS IS A MAJOR STAKEHOLDER CALLOUT, WE SHOULD WEIGH IT HEAVILY**
* Current product state:
    * Handles:
        * It models deal terms (deal type, guarantee, percentage, expense caps, hospitality caps, structured bonuses) and stores them per-show.
        * It tracks ticket sales from the integrated POS.
        * It captures show expenses by category.
        * It records comps with per-category counting rules.
        * It runs settlement math for **Flat** and **% of Gross** deals end-to-end.
        * It has a settlement lifecycle — draft, submitted, in review, signed, disputed, revised, finalized, paid — visible per settlement.
        * It supports recoup line items as part of the settlement, with agreed/disputed/withdrawn status.
    * Does not handle:
        * **Vs deals** (guarantee vs % of net), % of net, door deals, walkout pots, or tier ratchets. "About 62% of deals at The Crescent fall outside what the tool can settle."
        * ~18% of customers actively use the in-app settlement tool. The other 82%, including most larger venues, default to spreadsheets.
        * The structured fields don't capture the nuance bookers and agents negotiate in prose. Mariana enters deals as long-form notes because the structured fields don't model the actual deals well.
        * Disputes happen. Last March, a $720 concession was made on a Coastal Spell show after a marketing-recoup interpretation went sideways with WME. The full email thread is in the repo at `data/dispute-thread.md`. **INVESTIGATE THIS CASE**
* Starter repo notes:
    * *`/shows`** — Mariana's home view. ~30 upcoming shows. Past shows section is collapsed by default — click to expand 24 months of history.
    * **`/shows/[id]/settle`** — the in-app settlement tool. Try it on a Vs deal. Try it on a Flat deal. See what happens.
    * **`/reports`** — what Pri sees. Lifecycle distribution, dispute rates, deal mix, recoups, comps.
    * **`/context`** — in-product orientation, linked from the sidebar.
    * **`data/ceo-memo.md`** — the strategic frame.
    * **`data/dispute-thread.md`** — the Coastal Spell email chain.
    * **`data/transcripts/`** — interviews with Mariana (booker), Diego (a tour manager), Marcus (GM), Sarah Kim (an agent at WME). Mine these.
    * `notes_freetext` is the source of truth, structured fields are often not valid.
    * Vs deals are variable in how they are handled.
    * Settlement lifecycle is as follows: draft → submitted → in_review → signed (or disputed) → revised → finalized → paid → voided.
    * Recoups are categorized. Settlement records carry a recoups_json field with line items in categories like marketing, hospitality_overage, production_overage. Each can be agreed, disputed, or withdrawn.
* Final brief notes:
    * Data is messy and does not reflect true state of the deals.
    * **QUERY THE SQlite DB** exploration is required here for deeper understanding of where our current data formats are lacking.
    * Pick a slice and defend it.


    





