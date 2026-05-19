# Greenroom Starter — Repository Overview (LLM GENERATED FOR INITIAL EXPLORATORY PURPOSES)

A field guide to the [greenroom-starter](.) codebase: what it is, how it's built, and where the important content lives.

---

## 1. What this project is

**Greenroom** bills itself as "software for independent music venues" — calendar, advancing, marketing, settlements, sponsor reporting, fan database, all in one place. This particular repo is the **starter codebase for the Greenroom Applied AI PM case study**: a deliberately working-but-mediocre product seeded with 24 months of synthetic operational data for **The Crescent**, a 650-cap venue in Nashville.

The candidate (you) is auto-logged in as **Mariana Reyes**, lead booker. Per the [README](README.md): _"Your job isn't to fix everything — it's to pick a slice and design it well."_ The intended target slice is **settlement**, which the CEO memo flags as the company's biggest craft gap.

---

## 2. Tech stack

Pulled from [package.json](package.json):

| Concern | Choice |
|---|---|
| Framework | **Next.js 16.2.6** (App Router) |
| UI runtime | **React 19.2.4** |
| Language | **TypeScript 5** (strict, `@/*` path alias → repo root) |
| Styling | **Tailwind CSS 4** (`@theme` block in `globals.css`, no `tailwind.config`), shadcn-style primitives |
| DB | **libsql** (pure-JS SQLite) at `file:./data/greenroom.db` |
| ORM | **Drizzle ORM 0.45** + drizzle-kit 0.31 |
| Fonts | **Fraunces** (display serif), **Geist Sans/Mono** (body/code) |
| Icons | **lucide-react** |
| Dates | **date-fns 4** |
| Component utilities | `class-variance-authority`, `clsx`, `tailwind-merge` |

Scripts: `npm run dev | build | start | lint | db:push | db:seed | db:reset | db:studio`.

The repo is committed with `data/greenroom.db` checked in, so clone-and-run works without an initial seed.

---

## 3. Top-level layout

```
greenroom-starter/
├── app/                 # Next.js App Router routes
├── components/          # React components (brand, layout, ui, command-palette)
├── data/                # SQLite db + markdown context (CEO memo, dispute thread, transcripts)
├── db/                  # Drizzle schema, seed, client, migrations
├── lib/                 # Server queries, deal math, formatters, settlement-stage helpers
├── public/              # Static SVGs
├── README.md            # Quickstart, file map, case-study framing
├── drizzle.config.ts    # Drizzle Kit config (dialect: sqlite)
├── eslint.config.mjs    # eslint-config-next (core-web-vitals + typescript)
├── next.config.ts       # Empty default
├── postcss.config.mjs   # Tailwind PostCSS plugin
├── tsconfig.json        # Strict TS, `@/*` paths, JSX react-jsx
└── package.json
```

---

## 4. Routes & page surfaces

All routes live under [app/](app/). Root [layout.tsx](app/layout.tsx) wires three fonts (`--font-fraunces`, `--font-geist-sans`, `--font-geist-mono`), mounts the [Sidebar](components/layout/sidebar.tsx), and renders the global [`CommandPaletteData`](components/command-palette/command-data.tsx) (⌘K palette, server-prefetched). [app/page.tsx](app/page.tsx) is a one-liner `redirect("/shows")`.

| Route | File | What it does |
|---|---|---|
| `/` → `/shows` | [page.tsx](app/page.tsx) | Hard redirect |
| `/shows` | [shows/page.tsx](app/shows/page.tsx) + [shows-list.tsx](app/shows/shows-list.tsx) | Mariana's home view. Past-shows-only feed with `StatCard` strip, ⌘K-style search, month grouping, settlement-status accent bars. Server component fetches via `getAllShows`, serializes formatted strings, hands to `ShowsList` client component. |
| `/shows/[id]` | [shows/[id]/page.tsx](app/shows/[id]/page.tsx) | Concert-poster header with artist name in Fraunces, mini-stat strip (gross / tickets / expenses / to artist), and cards for Deal terms, Artist & agent, Box office, Comps, Expenses. Highlights the `bonusesJson` vs `dealNotesFreetext` mismatch in-line. |
| `/shows/[id]/settle` | [shows/[id]/settle/page.tsx](app/shows/[id]/settle/page.tsx) | The settlement worksheet. Calls `calculateSettlement()`. For **flat** + **% of gross** deals → hero `$ToArtist` number + breakdown rows + non-triggered bonuses. For **vs / % of net / door** → "isn't supported" empty state. Includes 5-stage `LifecycleBar` and a recoups panel that flags disputed line items in red. |
| `/artists` | [artists/page.tsx](app/artists/page.tsx) | Roster, bucketed by frequency (Frequent ≥4 / Regular 2–3 / Occasional 1). Card grid with genre-coded dots and frequency pips. Not linkable to detail. |
| `/reports` | [reports/page.tsx](app/reports/page.tsx) | The CEO-facing aggregate metrics: deals-unsupported %, disputed-settlements %, lifecycle bar chart, recoups, comps by category, deal mix. Quotes Pri's Q4 memo at the top. |
| `/context` | [context/page.tsx](app/context/page.tsx) | "Where to start" — in-product orientation for the candidate. 5-step tour, links to the markdown materials, deep-links to the Coastal Spell dispute show. |

Static assets in `app/`: `favicon.ico`, `icon.svg`, [opengraph-image.tsx](app/opengraph-image.tsx), [globals.css](app/globals.css).

---

## 5. Components

### [components/layout/](components/layout/)
- [`Sidebar`](components/layout/sidebar.tsx) — fixed 248px sidebar; brand mark + "v3.4 · The Crescent" version stamp, nav slot, case-study callout, Mariana avatar at the bottom.
- [`NavLinks`](components/layout/nav-links.tsx) — client component that reads `usePathname()` for active-state styling on Shows / Artists / Reports.

### [components/brand/](components/brand/)
- [`Logomark` / `Wordmark` / `LogoFlat`](components/brand/logo.tsx) — four-vertical-bar audio-meter mark in a green gradient rounded square.

### [components/command-palette/](components/command-palette/)
- [`CommandPaletteData`](components/command-palette/command-data.tsx) — RSC that pre-fetches shows + artists and pre-formats display strings (avoids Intl hydration mismatch).
- [`CommandPalette`](components/command-palette/command-palette.tsx) — ⌘K / Ctrl-K modal with keyboard navigation. Navigates to `/shows/:id`; artists are surfaced but not linkable.

### [components/ui/](components/ui/) — shadcn-style primitives
- [`badge.tsx`](components/ui/badge.tsx) — `StatusBadge` (show lifecycle), `DealTypeBadge`, `PlainBadge` (5 color variants).
- [`button.tsx`](components/ui/button.tsx) — CVA-based `Button` (6 variants × 4 sizes).
- [`card.tsx`](components/ui/card.tsx) — `Card` (with optional top-edge gradient accent), `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`, `Field`.
- [`tooltip.tsx`](components/ui/tooltip.tsx) — small tooltip primitive.

---

## 6. Database

### Client — [db/index.ts](db/index.ts)
libsql client pointing at `process.env.DATABASE_URL ?? "file:./data/greenroom.db"`, wrapped in Drizzle and re-exported as `db`. Migrations live in [db/migrations/](db/migrations/) (`0000_initial.sql`, `0000_awesome_juggernaut.sql`, plus `meta/_journal.json` + snapshot).

### Schema — [db/schema.ts](db/schema.ts)
Eleven tables, all SQLite. Heavily commented; the comments are themselves part of the case-study substrate.

| Table | Notes |
|---|---|
| `users` | Operator accounts (`booker` / `gm` / `production` / `box_office`). |
| `venues` | The Crescent + future-proofing. |
| `agencies`, `agents` | WME / CAA / Wasserman / Paradigm / Independent. Agents carry `preferencesNotes` (pet peeves, behavior hints). |
| `artists` | 59 acts. `priorShowCount` denormalized. |
| `shows` | ~540 rows. Status enum: `booked` → `advanced` → `day_of` → `settled` → `closed`. Carries `internalNotes` (Mariana's prose). |
| `deals` | **The seam.** Structured fields (`guaranteeAmount`, `percentage`, `expenseCap`, `hospitalityCap`) coexist with `bonusesJson` and `dealNotesFreetext`. Per the schema comment: the prose is what Mariana actually trusts; ~half the deals duplicate bonuses to JSON, half don't. `bonusesJson` supports `gross_threshold`, `sellout`, `attendance_threshold`, `tier_ratchet`. |
| `ticketSales` | One summary row per show (`qty`, `gross`, `fees`, `capturedAt`). |
| `comps` | One row per category per show. 7 categories; `countsTowardGross` boolean — a real source of dispute. |
| `expenses` | 8 categories (production / sound / lights / hospitality / marketing / backline / security / other). `absorbedByVenue` toggles whether passed through. |
| `settlements` | The state machine. Status: `draft` → `submitted` → `in_review` → `signed` / `disputed` → `revised` → `finalized` → `paid` (+ `voided` terminal). Stage timestamps for each transition, four computed-money columns, `calculationJson`, `recoupsJson`, `signoffText`, `notes`. |

Type exports at the bottom: `User`, `Venue`, `Agency`, `Agent`, `Artist`, `Show`, `Deal`, `TicketSale`, `Comp`, `Expense`, `Settlement`, plus the discriminated `Bonus` union, `Recoup`, and `SettlementStage`.

### Seed — [db/seed.ts](db/seed.ts) _(~1,477 lines)_
Deterministic (seeded RNG, `seed = 42`) generation of 24 months of data anchored on `TODAY`:
- Artist tiers A–D with draw distributions.
- Deal-type mix ~ flat 25% / vs 50% / % of net 15% / door 5% / % of gross 5%.
- Bonus structures on ~30% of vs / % of net deals, some duplicated in prose, some prose-only.
- Sell-through variance, comps by category, expenses.
- Settlement lifecycle stages with realistic stage timestamps.
- Recoups on ~30% of past settlements.
- **One hand-injected narrative show**: Coastal Spell, March 14 2025, the WME/Daniel Hwang dispute referenced verbatim in [data/dispute-thread.md](data/dispute-thread.md). Deep-linked from `/context` as `/shows/show_coastal_spell_dispute`.

---

## 7. The `lib/` directory

### [lib/queries.ts](lib/queries.ts)
Server-only data fetching. Three exports:
- `getAllShows()` — past shows only (`shows.date <= todayDateString()`); joins artist, agent, deal, settlement.
- `getShowById(id)` — joins everything + parallel-fetches ticket sales, expenses, comps; safely parses `recoupsJson`.
- `getAllArtists()` — left-joined with show counts + last-show date.
- `getReports()` — aggregates for the reports page: deal-type counts, in-app-tool usage rate (defined as `flat + percentage_of_gross` over all deals), settlement-status histogram, disputed rate, gross/paid-to-artist totals, recoup totals, comps by category.

The `// past shows only` filter (`lte(shows.date, todayDateString())`) is the time-gate referenced in recent commits — future shows exist in the DB but are hidden in the query layer.

### [lib/dealMath.ts](lib/dealMath.ts)
**The deliberately incomplete settlement engine.** Top-of-file comment is essential reading:
- Handles `flat` and `percentage_of_gross` end-to-end (with structured bonuses).
- Returns `{ supported: false }` for `vs`, `percentage_of_net`, `door` — the UI's empty state.
- Reads only `bonusesJson`; bonuses that live only in `dealNotesFreetext` are invisible.
- `applyBonuses()` evaluates `gross_threshold`, `sellout` (≥95% capacity), `attendance_threshold`; explicitly punts on `tier_ratchet` ("needs vs-deal or % of net support — not yet handled").

### [lib/settlementStage.ts](lib/settlementStage.ts)
Settlement-state-machine helpers: `STAGE_ORDER`, `STAGE_LABELS`, `STAGE_DESCRIPTIONS`, `STAGE_TONES` (neutral / active / complete / warning / danger), `nextStages(stage)`, and `stageHistory(s)` which builds an ordered timeline from the timestamp columns.

### [lib/format.ts](lib/format.ts)
`formatMoney`, `formatMoneyCompact`, `formatShowDate` ("Fri, May 7"), `formatShowDateFull`, `formatShowMonth`, `relativeShowDate` ("in 5 days" / "8 days ago").

### [lib/utils.ts](lib/utils.ts)
The conventional `cn()` (clsx + tailwind-merge).

---

## 8. Design system & visual language

[app/globals.css](app/globals.css) is the source of truth. Tailwind 4 `@theme` block defines:
- **Canvas** — `#faf7f0` / `#fdfbf6` (warm cream, paper-feel)
- **Brand** — emerald scale (`brand-50` → `brand-900`), primary `brand-700` (#047857)
- **Ink** — warm gray scale (`ink-50` → `ink-900`), text default `ink-900` (#1a1814)
- **Amber / Rose / Sky** — accent scales (50/100/200/700/800)
- Body has two fixed `::before`/`::after` overlays: radial brand-tinted gradients + a near-invisible SVG noise texture for paper grain.
- Utility classes: `.tabular` (tabular nums), `.font-display` (Fraunces), `.eyebrow` (11px uppercase brand-700 caption), `.bg-gradient-brand`, `.bg-gradient-paper`.
- `*:focus-visible` ringed in `brand-700`.

The product reaches consistently for: Fraunces display headlines (52–72px, tight tracking, optical sizing); compact tabular monospace for money; small `eyebrow` labels above numbers; status accent bars rather than full backgrounds.

---

## 9. The `data/` directory — narrative substrate

The markdown files here are **not decorative**. They carry signals the database deliberately doesn't capture.

| File | What it is |
|---|---|
| [data/greenroom.db](data/greenroom.db) | The seeded SQLite database, committed to git. |
| [data/ceo-memo.md](data/ceo-memo.md) | Pri Shankar's Q4 all-hands. The strategic frame: "winning on completeness, losing on craft." Explicitly names settlement as the Q1 craft bet (18% in-app use, 82% spreadsheet). |
| [data/dispute-thread.md](data/dispute-thread.md) | Full email thread (Daniel Hwang @ WME ↔ Mariana) on the Coastal Spell March 14 2025 settlement. Centers on a `$900` marketing recoup whose treatment in the deal email is ambiguous — was it "off gross" or part of the `$2,500` expense cap? The dispute resolves at `$720` against The Crescent. The matching show is hand-seeded as `show_coastal_spell_dispute`. |
| [data/transcripts/mariana.md](data/transcripts/mariana.md) | 30-min interview with the booker. Pet peeves, the 2am settlement ritual. |
| [data/transcripts/diego.md](data/transcripts/diego.md) | Tour manager perspective. |
| [data/transcripts/marcus.md](data/transcripts/marcus.md) | GM perspective. |
| [data/transcripts/sarah-kim.md](data/transcripts/sarah-kim.md) | WME agent perspective. |

---

## 10. Configuration & build

- [tsconfig.json](tsconfig.json) — strict, ES2017 target, `module: esnext`, `moduleResolution: bundler`, `jsx: react-jsx`, Next plugin, `@/*` → `./*`.
- [next.config.ts](next.config.ts) — empty default `NextConfig`.
- [eslint.config.mjs](eslint.config.mjs) — composes `eslint-config-next/core-web-vitals` + `/typescript`, re-applies the default Next ignores explicitly.
- [drizzle.config.ts](drizzle.config.ts) — schema at `./db/schema.ts`, out at `./db/migrations`, sqlite dialect, `DATABASE_URL` overridable.
- [postcss.config.mjs](postcss.config.mjs) — `@tailwindcss/postcss` only.
- [.gitignore](.gitignore) — standard Next.js, plus `.env*`, `.vercel`, `*.tsbuildinfo`, `next-env.d.ts`. **Note:** `data/greenroom.db` is intentionally _not_ ignored.

---

## 11. The "seams" the case study points at

Reading the schema comments, `dealMath.ts`, the CEO memo, and the dispute thread together, the planted gaps are:

1. **Structured ↔ prose mismatch in deals.** `bonusesJson` exists; `dealNotesFreetext` is what's trusted. The in-app engine only reads the former.
2. **Deal-type coverage.** ~82% of deal types (vs / % of net / door) fall through to a "not supported" empty state.
3. **Recoups are their own lifecycle.** Disputed recoups can persist after the rest of the settlement is signed; recoup-line ambiguity is the single biggest dispute driver (per the Coastal Spell thread).
4. **Comps that count toward gross** vary per deal — another quiet source of friction.
5. **Settlement state machine** has 9 statuses; the UI surfaces them but does nothing to help the user move between them.
6. **Time gate.** Future shows live in the DB but the query layer hides them — recent commit history (`5105d5e`, `8692708`, `d910368`) shows this was deliberately tightened.

---

## 12. Suggested entry points when reading

If you're new to this repo, read in roughly this order:

1. [README.md](README.md) — quickstart + file map (you've likely already read it).
2. [data/ceo-memo.md](data/ceo-memo.md) — strategic frame.
3. [db/schema.ts](db/schema.ts) — the data model, comments and all.
4. [lib/dealMath.ts](lib/dealMath.ts) — top comment + body. This is the seam.
5. [app/shows/[id]/settle/page.tsx](app/shows/%5Bid%5D/settle/page.tsx) — how the seam surfaces to the user.
6. [data/dispute-thread.md](data/dispute-thread.md) — what the seam costs.
7. [data/transcripts/](data/transcripts/) — what users say about it.
8. [lib/queries.ts](lib/queries.ts) and [app/reports/page.tsx](app/reports/page.tsx) — how the org sees it in aggregate.
