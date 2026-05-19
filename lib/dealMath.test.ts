import { describe, expect, it } from "vitest";
import { calculateSettlement, parseRecoupClauses } from "./dealMath";
import type { Bonus, Comp, Deal, Expense, Recoup, RecoupClause, TicketSale } from "@/db/schema";

const now = new Date("2026-01-01T00:00:00Z");

function deal(overrides: Partial<Deal>): Deal {
  return {
    id: "deal_test",
    showId: "show_test",
    dealType: "flat",
    guaranteeAmount: null,
    percentage: null,
    percentageBasis: null,
    expenseCap: null,
    hospitalityCap: null,
    bonusesJson: null,
    recoupClausesJson: null,
    dealNotesFreetext: null,
    createdAt: now,
    ...overrides,
  };
}

function ticket(overrides: Partial<TicketSale> = {}): TicketSale {
  return {
    id: "ts_test",
    showId: "show_test",
    qty: 500,
    gross: 20000,
    fees: 2000,
    capturedAt: now,
    ...overrides,
  };
}

function expense(amount: number, overrides: Partial<Expense> = {}): Expense {
  return {
    id: `exp_${amount}`,
    showId: "show_test",
    category: "production",
    amount,
    description: null,
    approved: true,
    absorbedByVenue: false,
    enteredByUserId: null,
    enteredAt: now,
    ...overrides,
  };
}

function comp(overrides: Partial<Comp>): Comp {
  return {
    id: "comp_test",
    showId: "show_test",
    category: "label",
    count: 10,
    faceValue: 40,
    countsTowardGross: false,
    notes: null,
    ...overrides,
  };
}

function clause(overrides: Partial<RecoupClause>): RecoupClause {
  return {
    id: "recoup_test",
    label: "Marketing recoup",
    category: "marketing",
    waterfallPosition: "outside_cap_pre_split",
    amountModel: "fixed",
    fixedAmount: 900,
    capAmount: null,
    overageAbsorbedBy: "n_a",
    overageSplitPct: null,
    rationale: null,
    ...overrides,
  };
}

function recoup(overrides: Partial<Recoup>): Recoup {
  return {
    id: "recoup_test",
    category: "marketing",
    label: "Marketing recoup",
    amount: 900,
    status: "agreed",
    ...overrides,
  };
}

describe("calculateSettlement", () => {
  it("settles percentage-of-net deals after capped expenses", () => {
    const calc = calculateSettlement({
      deal: deal({
        dealType: "percentage_of_net",
        percentage: 0.8,
        percentageBasis: "net",
        expenseCap: 2500,
      }),
      ticketSales: [ticket()],
      expenses: [expense(5000)],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    expect(calc.grossBoxOffice).toBeCloseTo(20000, 2);
    expect(calc.netBoxOffice).toBeCloseTo(18000, 2);
    expect(calc.totalExpenses).toBeCloseTo(2500, 2);
    expect(calc.totalToArtist).toBeCloseTo(12400, 2);
    expect(calc.steps.some((s) => s.note?.includes("$2,500 over cap"))).toBe(true);
  });

  it("settles vs-against-net deals and exposes the winning side", () => {
    const calc = calculateSettlement({
      deal: deal({
        dealType: "vs",
        guaranteeAmount: 5000,
        percentage: 0.8,
        percentageBasis: "net",
        expenseCap: 2500,
      }),
      ticketSales: [ticket()],
      expenses: [expense(1000)],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    expect(calc.totalToArtist).toBeCloseTo(13600, 2);
    expect(calc.comparison?.guarantee).toBeCloseTo(5000, 2);
    expect(calc.comparison?.percentage).toBeCloseTo(13600, 2);
    expect(calc.comparison?.margin).toBeCloseTo(8600, 2);
    expect(calc.comparison?.winner).toBe("percentage");
    expect(calc.comparison?.basisLabel).toBe("net");
    expect(calc.steps.some((s) => s.kind === "winner" && s.winner === "percentage")).toBe(true);
  });

  it("settles vs-against-gross using gross instead of net-after-expenses", () => {
    const calc = calculateSettlement({
      deal: deal({
        dealType: "vs",
        guaranteeAmount: 5000,
        percentage: 0.15,
        percentageBasis: "gross",
        expenseCap: null,
      }),
      ticketSales: [ticket({ gross: 19840, fees: 1984 })],
      expenses: [expense(2500)],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    expect(calc.comparison?.percentage).toBeCloseTo(2976, 2);
    expect(calc.totalToArtist).toBeCloseTo(5000, 2);
    expect(calc.steps.some((s) => s.label.includes("Expenses"))).toBe(false);
  });

  it("adds comps that count toward gross once at the top", () => {
    const calc = calculateSettlement({
      deal: deal({
        dealType: "percentage_of_gross",
        percentage: 0.8,
        percentageBasis: "gross",
      }),
      ticketSales: [ticket()],
      expenses: [],
      comps: [
        comp({ id: "comp_counted", countsTowardGross: true, count: 10, faceValue: 40 }),
        comp({ id: "comp_ignored", countsTowardGross: false, count: 10, faceValue: 40 }),
      ],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    expect(calc.grossBoxOffice).toBeCloseTo(20400, 2);
    expect(calc.totalToArtist).toBeCloseTo(16320, 2);
    expect(calc.steps.some((s) => s.label.includes("Comp value"))).toBe(true);
  });

  it("applies tier ratchets as the percentage side", () => {
    const bonuses: Bonus[] = [
      {
        type: "tier_ratchet",
        label: "Tiered net split",
        tiers: [
          { from: 0, to: 10000, percentage: 0.8 },
          { from: 10000, to: null, percentage: 0.85 },
        ],
      },
    ];
    const calc = calculateSettlement({
      deal: deal({
        dealType: "percentage_of_net",
        percentage: 0.8,
        percentageBasis: "net",
        expenseCap: 2500,
        bonusesJson: JSON.stringify(bonuses),
      }),
      ticketSales: [ticket({ gross: 19840, fees: 1984 })],
      expenses: [expense(2500)],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    expect(calc.totalToArtist).toBeCloseTo(12552.6);
    expect(calc.steps.filter((s) => s.kind === "tier").length).toBe(3);
  });

  it("treats a tie between guarantee and percentage as a percentage win", () => {
    const calc = calculateSettlement({
      deal: deal({
        dealType: "vs",
        guaranteeAmount: 14400,
        percentage: 0.8,
        percentageBasis: "net",
        expenseCap: 2500,
      }),
      ticketSales: [ticket()],
      expenses: [expense(0)],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    expect(calc.comparison?.guarantee).toBeCloseTo(14400, 2);
    expect(calc.comparison?.percentage).toBeCloseTo(14400, 2);
    expect(calc.comparison?.margin).toBeCloseTo(0, 2);
    expect(calc.comparison?.winner).toBe("percentage");
    expect(calc.steps.some((s) => s.note?.includes("Tie goes to the percentage side"))).toBe(true);
  });

  it("hard-fails a malformed ratchet on a vs deal", () => {
    const bonuses: Bonus[] = [
      {
        type: "tier_ratchet",
        label: "Broken tiers on vs",
        tiers: [
          { from: 0, to: 10000, percentage: 0.8 },
          { from: 12000, to: null, percentage: 0.85 },
        ],
      },
    ];
    const calc = calculateSettlement({
      deal: deal({
        dealType: "vs",
        guaranteeAmount: 5000,
        percentage: 0.8,
        percentageBasis: "net",
        expenseCap: 2500,
        bonusesJson: JSON.stringify(bonuses),
      }),
      ticketSales: [ticket()],
      expenses: [expense(1000)],
    });

    expect(calc.supported).toBe(false);
    if (calc.supported) return;
    expect(calc.kind).toBe("deal_misconfigured");
    expect(calc.reason).toContain("tier 2");
    expect(calc.reason).toContain("gap");
  });

  it("sums multiple clauses at the same waterfall position", () => {
    const clauses = [
      clause({ id: "recoup_a", label: "Radio ads", fixedAmount: 500, waterfallPosition: "off_gross" }),
      clause({ id: "recoup_b", label: "IG boost", fixedAmount: 400, waterfallPosition: "off_gross" }),
    ];
    const calc = calculateSettlement({
      deal: deal({
        dealType: "percentage_of_gross",
        percentage: 0.8,
        percentageBasis: "gross",
        recoupClausesJson: JSON.stringify(clauses),
      }),
      ticketSales: [ticket()],
      expenses: [],
      recoupApplications: [
        recoup({ id: "recoup_a", label: "Radio ads", amount: 500 }),
        recoup({ id: "recoup_b", label: "IG boost", amount: 400 }),
      ],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    expect(calc.grossBoxOffice).toBeCloseTo(20000, 2);
    expect(calc.totalToArtist).toBeCloseTo((20000 - 900) * 0.8, 2);
    const offGrossSteps = calc.steps.filter(
      (s) => s.kind === "recoup" && s.label.includes("off gross"),
    );
    expect(offGrossSteps.length).toBe(2);
  });

  it("applies an actual_up_to clause under the cap using the actual amount", () => {
    const clauses = [
      clause({
        id: "recoup_marketing",
        amountModel: "actual_up_to",
        fixedAmount: null,
        capAmount: 900,
        overageAbsorbedBy: "venue",
        waterfallPosition: "outside_cap_pre_split",
      }),
    ];
    const calc = calculateSettlement({
      deal: deal({
        dealType: "percentage_of_net",
        percentage: 0.8,
        percentageBasis: "net",
        recoupClausesJson: JSON.stringify(clauses),
      }),
      ticketSales: [ticket()],
      expenses: [],
      recoupApplications: [recoup({ id: "recoup_marketing", amount: 600 })],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    // net = 18000, − 600 marketing = 17400, × 80% = 13920
    expect(calc.totalToArtist).toBeCloseTo(13920, 2);
  });

  it("absorbs actual_up_to overage at the venue when overage owner is 'venue'", () => {
    const clauses = [
      clause({
        id: "recoup_marketing",
        amountModel: "actual_up_to",
        fixedAmount: null,
        capAmount: 900,
        overageAbsorbedBy: "venue",
        waterfallPosition: "outside_cap_pre_split",
      }),
    ];
    const calc = calculateSettlement({
      deal: deal({
        dealType: "percentage_of_net",
        percentage: 0.8,
        percentageBasis: "net",
        recoupClausesJson: JSON.stringify(clauses),
      }),
      ticketSales: [ticket()],
      expenses: [],
      recoupApplications: [recoup({ id: "recoup_marketing", amount: 1500 })],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    // Cap clips at 900; venue eats $600 overage silently.
    // net = 18000, − 900 = 17100, × 80% = 13680
    expect(calc.totalToArtist).toBeCloseTo(13680, 2);
  });

  it("passes actual_up_to overage to the artist when overage owner is 'artist'", () => {
    const clauses = [
      clause({
        id: "recoup_marketing",
        amountModel: "actual_up_to",
        fixedAmount: null,
        capAmount: 900,
        overageAbsorbedBy: "artist",
        waterfallPosition: "outside_cap_pre_split",
      }),
    ];
    const calc = calculateSettlement({
      deal: deal({
        dealType: "percentage_of_net",
        percentage: 0.8,
        percentageBasis: "net",
        recoupClausesJson: JSON.stringify(clauses),
      }),
      ticketSales: [ticket()],
      expenses: [],
      recoupApplications: [recoup({ id: "recoup_marketing", amount: 1500 })],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    // Cap clips at 900; artist eats $600 overage post-split.
    // net = 18000, − 900 cap = 17100, × 80% = 13680, − 600 overage = 13080
    expect(calc.totalToArtist).toBeCloseTo(13080, 2);
    expect(calc.steps.some((s) => s.label.includes("overage"))).toBe(true);
  });

  it("splits actual_up_to overage per overageSplitPct when owner is 'split'", () => {
    const clauses = [
      clause({
        id: "recoup_marketing",
        amountModel: "actual_up_to",
        fixedAmount: null,
        capAmount: 900,
        overageAbsorbedBy: "split",
        overageSplitPct: 0.5,
        waterfallPosition: "outside_cap_pre_split",
      }),
    ];
    const calc = calculateSettlement({
      deal: deal({
        dealType: "percentage_of_net",
        percentage: 0.8,
        percentageBasis: "net",
        recoupClausesJson: JSON.stringify(clauses),
      }),
      ticketSales: [ticket()],
      expenses: [],
      recoupApplications: [recoup({ id: "recoup_marketing", amount: 1500 })],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    // Cap at 900; $600 overage; artist's share 50% = $300 post-split.
    // (18000 − 900) × 80% − 300 = 13680 − 300 = 13380
    expect(calc.totalToArtist).toBeCloseTo(13380, 2);
  });

  it("uses the actual amount uncapped for actual_uncapped clauses", () => {
    const clauses = [
      clause({
        id: "recoup_uncapped",
        label: "Open-ended production recoup",
        amountModel: "actual_uncapped",
        fixedAmount: null,
        capAmount: null,
        waterfallPosition: "outside_cap_pre_split",
      }),
    ];
    const calc = calculateSettlement({
      deal: deal({
        dealType: "percentage_of_net",
        percentage: 0.8,
        percentageBasis: "net",
        recoupClausesJson: JSON.stringify(clauses),
      }),
      ticketSales: [ticket()],
      expenses: [],
      recoupApplications: [recoup({ id: "recoup_uncapped", amount: 1750 })],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    // net = 18000, − 1750 = 16250, × 80% = 13000
    expect(calc.totalToArtist).toBeCloseTo(13000, 2);
  });

  it("skips withdrawn applications entirely", () => {
    const clauses = [
      clause({
        id: "recoup_withdrawn",
        amountModel: "actual_up_to",
        fixedAmount: null,
        capAmount: 900,
        waterfallPosition: "outside_cap_pre_split",
      }),
    ];
    const calc = calculateSettlement({
      deal: deal({
        dealType: "percentage_of_net",
        percentage: 0.8,
        percentageBasis: "net",
        recoupClausesJson: JSON.stringify(clauses),
      }),
      ticketSales: [ticket()],
      expenses: [],
      recoupApplications: [recoup({ id: "recoup_withdrawn", amount: 0, status: "withdrawn" })],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    // Withdrawn → no math impact. 18000 × 80% = 14400.
    expect(calc.totalToArtist).toBeCloseTo(14400, 2);
    expect(calc.steps.some((s) => s.kind === "recoup")).toBe(false);
  });

  it("blocks signoff when an actual_up_to clause has no application", () => {
    const clauses = [
      clause({
        id: "recoup_pending",
        amountModel: "actual_up_to",
        fixedAmount: null,
        capAmount: 900,
        waterfallPosition: "outside_cap_pre_split",
      }),
    ];
    const calc = calculateSettlement({
      deal: deal({
        dealType: "percentage_of_net",
        percentage: 0.8,
        percentageBasis: "net",
        recoupClausesJson: JSON.stringify(clauses),
      }),
      ticketSales: [ticket()],
      expenses: [],
      recoupApplications: [],
    });

    expect(calc.supported).toBe(false);
    if (calc.supported) return;
    expect(calc.kind).toBe("deal_misconfigured");
    expect(calc.reason).toContain("Marketing recoup");
    expect(calc.reason).toContain("actual billed amount or a withdrawn status");
  });

  it("preserves back-compat for flat deals without recoups", () => {
    const calc = calculateSettlement({
      deal: deal({
        dealType: "flat",
        guaranteeAmount: 5000,
      }),
      ticketSales: [ticket()],
      expenses: [expense(800)],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    expect(calc.totalToArtist).toBeCloseTo(5000, 2);
    expect(calc.steps[0].label).toBe("Flat guarantee");
  });

  it("preserves back-compat for percentage-of-gross deals without recoups", () => {
    const calc = calculateSettlement({
      deal: deal({
        dealType: "percentage_of_gross",
        percentage: 0.8,
        percentageBasis: "gross",
      }),
      ticketSales: [ticket()],
      expenses: [],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    expect(calc.totalToArtist).toBeCloseTo(16000, 2);
  });

  it("composes vs + recoups at every position + ratchet + counted comps end to end", () => {
    const bonuses: Bonus[] = [
      {
        type: "tier_ratchet",
        label: "Tiered split",
        tiers: [
          { from: 0, to: 10000, percentage: 0.8 },
          { from: 10000, to: null, percentage: 0.85 },
        ],
      },
    ];
    const clauses = [
      clause({ id: "recoup_off", label: "Radio buy", fixedAmount: 500, waterfallPosition: "off_gross" }),
      clause({ id: "recoup_inside", label: "Inside-cap promo", fixedAmount: 300, waterfallPosition: "inside_expense_cap" }),
      clause({ id: "recoup_outside", label: "Print ads", fixedAmount: 400, waterfallPosition: "outside_cap_pre_split" }),
      clause({ id: "recoup_post", label: "Prior advance", fixedAmount: 250, waterfallPosition: "post_split" }),
    ];
    const calc = calculateSettlement({
      deal: deal({
        dealType: "vs",
        guaranteeAmount: 5000,
        percentage: 0.8,
        percentageBasis: "net",
        expenseCap: 2500,
        bonusesJson: JSON.stringify(bonuses),
        recoupClausesJson: JSON.stringify(clauses),
      }),
      ticketSales: [ticket({ gross: 20000, fees: 2000 })],
      expenses: [expense(1500)],
      comps: [comp({ id: "comp_counted", countsTowardGross: true, count: 5, faceValue: 40 })],
      recoupApplications: clauses.map((c) =>
        recoup({ id: c.id, label: c.label, amount: c.fixedAmount ?? 0 }),
      ),
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    // gross = 20000 ticketed + 200 comps = 20200
    // off_gross 500 → 19700
    // − 2000 fees = 17700 net
    // expenses 1500 + inside-cap 300 = 1800, under 2500 cap → cappedExpenses = 1800
    // 17700 − 1800 = 15900
    // outside-cap 400 → 15500
    // ratchet: 10000 @ 80% = 8000; 5500 @ 85% = 4675; total 12675
    // winner = percentage (12675 > 5000 guarantee)
    // post-split 250 → 12425
    expect(calc.grossBoxOffice).toBeCloseTo(20200, 2);
    expect(calc.totalToArtist).toBeCloseTo(12425, 2);
    expect(calc.comparison?.winner).toBe("percentage");
    expect(calc.steps.filter((s) => s.kind === "recoup").length).toBe(4);
    expect(calc.steps.filter((s) => s.kind === "tier").length).toBeGreaterThan(0);
    expect(calc.steps.some((s) => s.label.includes("Comp value"))).toBe(true);
  });

  it("hard-fails malformed ratchet tiers with a specific reason", () => {
    const bonuses: Bonus[] = [
      {
        type: "tier_ratchet",
        label: "Broken tiers",
        tiers: [
          { from: 0, to: 10000, percentage: 0.8 },
          { from: 15000, to: null, percentage: 0.85 },
        ],
      },
    ];
    const calc = calculateSettlement({
      deal: deal({
        dealType: "percentage_of_net",
        percentage: 0.8,
        percentageBasis: "net",
        expenseCap: 2500,
        bonusesJson: JSON.stringify(bonuses),
      }),
      ticketSales: [ticket()],
      expenses: [expense(1000)],
    });

    expect(calc.supported).toBe(false);
    if (calc.supported) return;
    expect(calc.kind).toBe("deal_misconfigured");
    expect(calc.reason).toContain("tier 2");
    expect(calc.reason).toContain("gap");
  });

  it("treats legacy orphan recoup applications as outside-cap pre-split", () => {
    const calc = calculateSettlement({
      deal: deal({
        dealType: "vs",
        guaranteeAmount: 5000,
        percentage: 0.8,
        percentageBasis: "net",
        expenseCap: 2500,
      }),
      ticketSales: [ticket({ gross: 19840, fees: 1984 })],
      expenses: [expense(1600)],
      recoupApplications: [recoup({ id: "legacy_recoup", amount: 900 })],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    expect(calc.totalToArtist).toBeCloseTo(12284.8);
    expect(calc.steps.some((s) => s.note?.includes("Legacy recoup"))).toBe(true);
  });

  it("models the Coastal Spell inside-cap read at $12,285", () => {
    const clauses = [
      clause({
        id: "recoup_coastal",
        fixedAmount: 900,
        waterfallPosition: "inside_expense_cap",
        rationale: "Marketing recoup included in expense cap.",
      }),
    ];
    const calc = calculateSettlement({
      deal: deal({
        dealType: "vs",
        guaranteeAmount: 5000,
        percentage: 0.8,
        percentageBasis: "net",
        expenseCap: 2500,
        recoupClausesJson: JSON.stringify(clauses),
      }),
      ticketSales: [ticket({ gross: 19840, fees: 1984 })],
      expenses: [expense(1600)],
      recoupApplications: [recoup({ id: "recoup_coastal", amount: 900 })],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    expect(Math.round(calc.totalToArtist)).toBe(12285);
    expect(calc.steps.some((s) => s.label.includes("inside expense cap"))).toBe(true);
  });

  it("models the Coastal Spell off-gross read at $11,565", () => {
    const clauses = [
      clause({
        id: "recoup_coastal",
        fixedAmount: 900,
        waterfallPosition: "off_gross",
        rationale: "Marketing recoup against gross.",
      }),
    ];
    const calc = calculateSettlement({
      deal: deal({
        dealType: "vs",
        guaranteeAmount: 5000,
        percentage: 0.8,
        percentageBasis: "net",
        expenseCap: 2500,
        recoupClausesJson: JSON.stringify(clauses),
      }),
      ticketSales: [ticket({ gross: 19840, fees: 1984 })],
      expenses: [expense(2500)],
      recoupApplications: [recoup({ id: "recoup_coastal", amount: 900 })],
    });

    expect(calc.supported).toBe(true);
    if (!calc.supported) return;
    expect(Math.round(calc.totalToArtist)).toBe(11565);
  });
});

describe("parseRecoupClauses", () => {
  it("returns an empty array when the column is null", () => {
    const result = parseRecoupClauses(deal({ recoupClausesJson: null }));
    expect(result).toEqual([]);
  });

  it("returns an empty array on malformed top-level JSON", () => {
    const result = parseRecoupClauses(deal({ recoupClausesJson: "{not valid json" }));
    expect(result).toEqual([]);
  });

  it("returns an empty array when JSON is not an array", () => {
    const result = parseRecoupClauses(deal({ recoupClausesJson: JSON.stringify({ id: "x" }) }));
    expect(result).toEqual([]);
  });

  it("skips a clause missing label without losing well-formed siblings", () => {
    const json = JSON.stringify([
      { id: "bad", waterfallPosition: "off_gross", amountModel: "fixed", fixedAmount: 100 },
      {
        id: "good",
        label: "Real clause",
        waterfallPosition: "off_gross",
        amountModel: "fixed",
        fixedAmount: 200,
      },
    ]);
    const result = parseRecoupClauses(deal({ recoupClausesJson: json }));
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("good");
  });

  it("skips a clause missing waterfallPosition without losing siblings", () => {
    const json = JSON.stringify([
      { id: "bad", label: "No position", amountModel: "fixed", fixedAmount: 100 },
      {
        id: "good",
        label: "Real clause",
        waterfallPosition: "post_split",
        amountModel: "fixed",
        fixedAmount: 200,
      },
    ]);
    const result = parseRecoupClauses(deal({ recoupClausesJson: json }));
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("good");
  });

  it("skips a clause missing amountModel without losing siblings", () => {
    const json = JSON.stringify([
      { id: "bad", label: "No model", waterfallPosition: "off_gross", fixedAmount: 100 },
      {
        id: "good",
        label: "Real clause",
        waterfallPosition: "off_gross",
        amountModel: "fixed",
        fixedAmount: 200,
      },
    ]);
    const result = parseRecoupClauses(deal({ recoupClausesJson: json }));
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("good");
  });

  it("skips non-object entries", () => {
    const json = JSON.stringify([
      "not an object",
      {
        id: "good",
        label: "Real clause",
        waterfallPosition: "off_gross",
        amountModel: "fixed",
        fixedAmount: 200,
      },
    ]);
    const result = parseRecoupClauses(deal({ recoupClausesJson: json }));
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("good");
  });
});
