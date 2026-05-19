/**
 * Deal calculation logic for the in-app settlement tool.
 *
 * The engine is deliberately pure: callers pass structured deal terms,
 * ticketing, expenses, comps, and optional settlement recoup applications.
 * It returns a readable line-by-line statement that can be rendered directly.
 */

import type {
  Bonus,
  Comp,
  Deal,
  Expense,
  Recoup,
  RecoupClause,
  TicketSale,
  WaterfallPosition,
} from "@/db/schema";

export type SettlementStep = {
  label: string;
  value: number;
  note?: string;
  kind?: "normal" | "winner" | "tier" | "recoup" | "comparison" | "net";
  side?: "guarantee" | "percentage";
  winner?: "guarantee" | "percentage";
};

export type SettlementCalculation =
  | {
      supported: true;
      dealType: Deal["dealType"];
      grossBoxOffice: number;
      netBoxOffice: number;
      totalExpenses: number;
      totalToArtist: number;
      steps: SettlementStep[];
      finalFormula: string;
      comparison?: {
        guarantee: number;
        percentage: number;
        winner: "guarantee" | "percentage";
        margin: number;
        basisLabel: "gross" | "net";
      };
      bonusesApplied: { label: string; amount: number; reason: string }[];
      bonusesNotTriggered: { label: string; amount: number; reason: string }[];
    }
  | {
      supported: false;
      kind: "deal_type_unsupported" | "deal_misconfigured";
      reason: string;
      dealType: Deal["dealType"];
    };

export interface CalcInput {
  deal: Deal;
  ticketSales: TicketSale[];
  expenses: Expense[];
  comps?: Comp[];
  recoupApplications?: Recoup[];
  // Capacity is needed to evaluate sellout bonuses. Optional — if omitted,
  // sellout bonuses are reported as "can't determine".
  venueCapacity?: number;
  ticketsSold?: number;
}

type RecoupApplication = {
  id: string;
  label: string;
  category: RecoupClause["category"];
  waterfallPosition: WaterfallPosition;
  amount: number;
  note?: string;
  overageAmount?: number;
  overageArtistAmount?: number;
};

type RecoupResolution =
  | { ok: true; applications: RecoupApplication[]; postSplitOverages: RecoupApplication[] }
  | { ok: false; reason: string };

type NetResult = {
  grossBoxOffice: number;
  grossAfterOffGross: number;
  fees: number;
  netBoxOffice: number;
  rawExpenses: number;
  insideCapRecoups: number;
  cappedExpenses: number;
  outsideCapRecoups: number;
  netAfterExpenses: number;
  steps: SettlementStep[];
};

const RECOUP_POSITION_LABELS: Record<WaterfallPosition, string> = {
  off_gross: "off gross",
  inside_expense_cap: "inside expense cap",
  outside_cap_pre_split: "outside cap, before split",
  post_split: "post-split",
};

export function parseBonuses(deal: Deal): Bonus[] {
  if (!deal.bonusesJson) return [];
  try {
    const parsed = JSON.parse(deal.bonusesJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseRecoupClauses(deal: Deal): RecoupClause[] {
  if (!deal.recoupClausesJson) return [];
  try {
    const parsed = JSON.parse(deal.recoupClausesJson);
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((raw, index) => {
      if (!isRecord(raw)) {
        console.warn(`Skipping recoup clause ${index + 1}: expected an object.`);
        return [];
      }

      const label = typeof raw.label === "string" ? raw.label.trim() : "";
      const waterfallPosition = parseWaterfallPosition(raw.waterfallPosition);
      const amountModel = raw.amountModel;
      if (!label || !waterfallPosition) {
        console.warn(
          `Skipping recoup clause ${index + 1}: missing label or waterfall position.`,
        );
        return [];
      }
      if (
        amountModel !== "fixed" &&
        amountModel !== "actual_up_to" &&
        amountModel !== "actual_uncapped"
      ) {
        console.warn(`Skipping recoup clause ${index + 1}: missing amount model.`);
        return [];
      }

      return [
        {
          id: typeof raw.id === "string" ? raw.id : `invalid_${index}`,
          label,
          category: parseRecoupCategory(raw.category),
          waterfallPosition,
          amountModel,
          fixedAmount: numberOrNull(raw.fixedAmount),
          capAmount: numberOrNull(raw.capAmount),
          overageAbsorbedBy: parseOverageOwner(raw.overageAbsorbedBy),
          overageSplitPct: numberOrNull(raw.overageSplitPct),
          rationale: typeof raw.rationale === "string" ? raw.rationale : null,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function calculateSettlement(input: CalcInput): SettlementCalculation {
  const {
    deal,
    ticketSales,
    expenses,
    comps = [],
    recoupApplications = [],
    venueCapacity,
    ticketsSold,
  } = input;

  const tickets =
    ticketsSold ?? ticketSales.reduce((sum, t) => sum + (t.qty ?? 0), 0);
  const bonuses = parseBonuses(deal);
  const nonTierBonusResult = applyBonuses(
    bonuses.filter((b) => b.type !== "tier_ratchet"),
    {
      gross: computeGross(ticketSales, comps).grossBoxOffice,
      tickets,
      capacity: venueCapacity,
    },
  );
  const tierRatchet = bonuses.find(
    (b): b is Extract<Bonus, { type: "tier_ratchet" }> =>
      b.type === "tier_ratchet",
  );
  const attendance =
    venueCapacity != null && venueCapacity > 0
      ? { sold: tickets, capacity: venueCapacity }
      : undefined;

  const recoups = resolveRecoups(deal, recoupApplications);
  if (!recoups.ok) {
    return misconfigured(deal, recoups.reason);
  }

  // ---------- flat guarantee ----------
  if (deal.dealType === "flat") {
    if (deal.guaranteeAmount == null) {
      return misconfigured(deal, "Flat deal is missing a guarantee amount.");
    }

    const base = computeNetAfterExpenses(deal, ticketSales, expenses, comps, recoups.applications);
    const totalToArtist =
      deal.guaranteeAmount +
      nonTierBonusResult.totalApplied -
      sumByPosition(recoups.applications, "post_split") -
      sumPostSplitOverages(recoups.postSplitOverages);

    return {
      supported: true,
      dealType: deal.dealType,
      grossBoxOffice: base.grossBoxOffice,
      netBoxOffice: base.netBoxOffice,
      // Flat deals do not deduct expenses from artist payout, but reporting
      // still carries passed-through expenses so the worksheet matches show P&L.
      totalExpenses: base.cappedExpenses,
      totalToArtist,
      steps: [
        {
          label: "Flat guarantee",
          value: deal.guaranteeAmount,
          note: "No expense deductions. The guarantee is the floor.",
        },
        ...nonTierBonusResult.applied.map((b) => ({
          label: b.label,
          value: b.amount,
          note: b.reason,
        })),
        ...postSplitSteps(recoups),
      ],
      finalFormula: nonTierBonusResult.applied.length
        ? `flat ${deal.guaranteeAmount} + bonuses ${nonTierBonusResult.totalApplied} = ${totalToArtist.toFixed(2)}`
        : `flat guarantee = ${totalToArtist.toFixed(2)}`,
      bonusesApplied: nonTierBonusResult.applied,
      bonusesNotTriggered: [
        ...nonTierBonusResult.notTriggered,
        ...tierRatchetNotApplicable(tierRatchet, "Flat deals do not use a percentage basis."),
      ],
    };
  }

  // ---------- percentage of gross ----------
  if (deal.dealType === "percentage_of_gross") {
    if (deal.percentage == null) {
      return misconfigured(deal, "Percentage-of-gross deal is missing a percentage.");
    }

    const base = computeNetAfterExpenses(deal, ticketSales, expenses, comps, recoups.applications);
    const percentageResult = computePercentageSide(
      deal,
      base.grossAfterOffGross,
      "gross",
      tierRatchet,
      attendance,
    );
    if (!percentageResult.ok) return misconfigured(deal, percentageResult.reason);

    const postSplitRecoups = sumByPosition(recoups.applications, "post_split");
    const postSplitOverages = sumPostSplitOverages(recoups.postSplitOverages);
    const totalToArtist =
      percentageResult.payout +
      nonTierBonusResult.totalApplied -
      postSplitRecoups -
      postSplitOverages;

    return {
      supported: true,
      dealType: deal.dealType,
      grossBoxOffice: base.grossBoxOffice,
      netBoxOffice: base.netBoxOffice,
      totalExpenses: base.cappedExpenses,
      totalToArtist,
      steps: [
        ...base.steps,
        ...percentageResult.steps,
        ...nonTierBonusResult.applied.map((b) => ({
          label: b.label,
          value: b.amount,
          note: b.reason,
        })),
        ...postSplitSteps(recoups),
      ],
      finalFormula: `gross × ${formatPct(deal.percentage)} = ${percentageResult.payout.toFixed(2)}`,
      bonusesApplied: nonTierBonusResult.applied,
      bonusesNotTriggered: nonTierBonusResult.notTriggered,
    };
  }

  // ---------- percentage of net ----------
  if (deal.dealType === "percentage_of_net") {
    if (deal.percentage == null && !tierRatchet) {
      return misconfigured(deal, "Percentage-of-net deal is missing a percentage.");
    }

    const base = computeNetAfterExpenses(deal, ticketSales, expenses, comps, recoups.applications);
    const percentageResult = computePercentageSide(
      deal,
      base.netAfterExpenses,
      "net",
      tierRatchet,
      attendance,
    );
    if (!percentageResult.ok) return misconfigured(deal, percentageResult.reason);

    const postSplitRecoups = sumByPosition(recoups.applications, "post_split");
    const postSplitOverages = sumPostSplitOverages(recoups.postSplitOverages);
    const totalToArtist =
      percentageResult.payout +
      nonTierBonusResult.totalApplied -
      postSplitRecoups -
      postSplitOverages;

    return {
      supported: true,
      dealType: deal.dealType,
      grossBoxOffice: base.grossBoxOffice,
      netBoxOffice: base.netBoxOffice,
      totalExpenses: base.cappedExpenses,
      totalToArtist,
      steps: [
        ...base.steps,
        ...percentageResult.steps,
        ...nonTierBonusResult.applied.map((b) => ({
          label: b.label,
          value: b.amount,
          note: b.reason,
        })),
        ...postSplitSteps(recoups),
      ],
      finalFormula: `net × ${formatPct(deal.percentage ?? 0)} = ${percentageResult.payout.toFixed(2)}`,
      bonusesApplied: nonTierBonusResult.applied,
      bonusesNotTriggered: nonTierBonusResult.notTriggered,
    };
  }

  // ---------- vs ----------
  if (deal.dealType === "vs") {
    if (deal.guaranteeAmount == null) {
      return misconfigured(deal, "Vs deal is missing a guarantee amount.");
    }
    if (deal.percentage == null && !tierRatchet) {
      return misconfigured(deal, "Vs deal is missing a percentage.");
    }

    const base = computeNetAfterExpenses(deal, ticketSales, expenses, comps, recoups.applications);
    const basisLabel = deal.percentageBasis === "gross" ? "gross" : "net";
    const basis = basisLabel === "gross" ? base.grossAfterOffGross : base.netAfterExpenses;
    const percentageResult = computePercentageSide(deal, basis, basisLabel, tierRatchet, attendance);
    if (!percentageResult.ok) return misconfigured(deal, percentageResult.reason);

    const guarantee = deal.guaranteeAmount;
    const percentage = percentageResult.payout;
    const winner: "guarantee" | "percentage" =
      percentage >= guarantee ? "percentage" : "guarantee";
    const basePayout = winner === "percentage" ? percentage : guarantee;
    const margin = Math.abs(percentage - guarantee);
    const postSplitRecoups = sumByPosition(recoups.applications, "post_split");
    const postSplitOverages = sumPostSplitOverages(recoups.postSplitOverages);
    const totalToArtist =
      basePayout +
      nonTierBonusResult.totalApplied -
      postSplitRecoups -
      postSplitOverages;

    return {
      supported: true,
      dealType: deal.dealType,
      grossBoxOffice: base.grossBoxOffice,
      netBoxOffice: base.netBoxOffice,
      totalExpenses: base.cappedExpenses,
      totalToArtist,
      steps: [
        ...(basisLabel === "gross"
          ? grossOnlySteps(base)
          : base.steps),
        {
          label: "Guarantee side",
          value: guarantee,
          kind: "comparison",
          side: "guarantee",
        },
        ...percentageResult.steps.map((step) => ({
          ...step,
          kind: step.kind ?? "comparison",
          side: "percentage" as const,
        })),
        {
          label: winner === "percentage" ? "Percentage side wins" : "Guarantee side wins",
          value: basePayout,
          note:
            margin === 0
              ? "Tie goes to the percentage side."
              : `${winner === "percentage" ? "Percentage" : "Guarantee"} side wins by ${formatMoneyInline(margin)}.`,
          kind: "winner",
          winner,
        },
        ...nonTierBonusResult.applied.map((b) => ({
          label: b.label,
          value: b.amount,
          note: b.reason,
        })),
        ...postSplitSteps(recoups),
      ],
      finalFormula: `max(${formatMoneyInline(guarantee)} guarantee, ${formatPct(deal.percentage ?? 0)} × ${formatMoneyInline(basis)} ${basisLabel}) = ${formatMoneyInline(basePayout)}`,
      comparison: {
        guarantee,
        percentage,
        winner,
        margin,
        basisLabel,
      },
      bonusesApplied: nonTierBonusResult.applied,
      bonusesNotTriggered: nonTierBonusResult.notTriggered,
    };
  }

  return {
    supported: false,
    kind: "deal_type_unsupported",
    dealType: deal.dealType,
    reason:
      "Door deals aren't supported in the in-app tool yet. Door receipts and presales are not split in ticketing data.",
  };
}

export function computeNetAfterExpenses(
  deal: Deal,
  ticketSales: TicketSale[],
  expenses: Expense[],
  comps: Comp[] = [],
  recoupApplications: RecoupApplication[] = [],
): NetResult {
  const { ticketedGross, countedCompValue, grossBoxOffice } = computeGross(ticketSales, comps);
  const fees = ticketSales.reduce((sum, t) => sum + t.fees, 0);
  const offGrossRecoups = recoupApplications.filter(
    (r) => r.waterfallPosition === "off_gross",
  );
  const grossAfterOffGross =
    grossBoxOffice - offGrossRecoups.reduce((sum, r) => sum + r.amount, 0);
  const netBoxOffice = grossAfterOffGross - fees;
  const rawExpenses = expenses
    .filter((e) => !e.absorbedByVenue)
    .reduce((sum, e) => sum + e.amount, 0);
  const insideCapRecoups = sumByPosition(recoupApplications, "inside_expense_cap");
  const expenseSubjectToCap = rawExpenses + insideCapRecoups;
  const cappedExpenses =
    deal.expenseCap == null
      ? expenseSubjectToCap
      : Math.min(expenseSubjectToCap, deal.expenseCap);
  const outsideCapRecoups = sumByPosition(
    recoupApplications,
    "outside_cap_pre_split",
  );
  const netAfterExpenses = netBoxOffice - cappedExpenses - outsideCapRecoups;

  const steps: SettlementStep[] = [{ label: "Gross box office", value: ticketedGross }];
  if (countedCompValue > 0) {
    steps.push({
      label: "+ Comp value counted toward gross",
      value: countedCompValue,
      note: "Comp face value counts toward gross per deal terms.",
    });
    steps.push({ label: "Adjusted gross", value: grossBoxOffice });
  }
  steps.push(
    ...offGrossRecoups.map((r) => recoupStep(r, -r.amount)),
    { label: "Gross after off-gross recoups", value: grossAfterOffGross },
    { label: "− Fees", value: -fees },
    { label: "Net box office", value: netBoxOffice, kind: "net" },
  );

  if (rawExpenses > 0 || insideCapRecoups > 0) {
    steps.push(
      ...recoupApplications
        .filter((r) => r.waterfallPosition === "inside_expense_cap")
        .map((r) =>
          recoupStep(
            {
              ...r,
              note: r.note
                ? `${r.note} Included in the expense-cap bucket.`
                : "Included in the expense-cap bucket.",
            },
            -r.amount,
          ),
        ),
    );
    steps.push({
      label:
        deal.expenseCap == null
          ? "− Expenses"
          : `− Expenses (capped at ${formatMoneyInline(deal.expenseCap)})`,
      value: -cappedExpenses,
      note: expenseCapNote(rawExpenses, insideCapRecoups, expenseSubjectToCap, cappedExpenses),
    });
  }
  steps.push(
    ...recoupApplications
      .filter((r) => r.waterfallPosition === "outside_cap_pre_split")
      .map((r) => recoupStep(r, -r.amount)),
    { label: "Net after expenses", value: netAfterExpenses, kind: "net" },
  );

  return {
    grossBoxOffice,
    grossAfterOffGross,
    fees,
    netBoxOffice,
    rawExpenses,
    insideCapRecoups,
    cappedExpenses,
    outsideCapRecoups,
    netAfterExpenses,
    steps,
  };
}

// TODO: replace this heuristic with an explicit `basis: "net_dollars" | "capacity_fraction"`
// discriminator on the tier_ratchet bonus schema. The seed writes two distinct shapes under
// the same type — capacity fractions (`to: 0.8`, labeled "Ratchet: X% to Y% over 80% sold")
// and dollar breakpoints (`to: 4000`, labeled "Tiered net split: 60% / 70% over $4,000") —
// and a single deal can carry both (see show_0403). The heuristic works because the data
// has a comfortable gap (fractions ≤ 1, dollars ≥ 4000) but is fragile to edge cases.
function inferRatchetBasis(
  tiers: { from: number; to: number | null; percentage: number }[],
): "capacity_fraction" | "net_dollars" {
  for (const tier of tiers) {
    if (tier.from > 0 && tier.from < 1) return "capacity_fraction";
    if (tier.to != null && tier.to > 0 && tier.to < 1) return "capacity_fraction";
  }
  return "net_dollars";
}

export function applyTierRatchet(
  tiers: { from: number; to: number | null; percentage: number }[],
  basis: number,
  attendance?: { sold: number; capacity: number },
): { ok: true; payout: number; steps: SettlementStep[] } | { ok: false; reason: string } {
  const validation = validateRatchetTiers(tiers);
  if (!validation.ok) return validation;

  const ratchetBasis = inferRatchetBasis(tiers);

  if (ratchetBasis === "capacity_fraction") {
    if (!attendance || attendance.capacity <= 0) {
      return {
        ok: false,
        reason:
          "Capacity-fraction ratchet needs venue capacity and ticket count to evaluate the threshold.",
      };
    }
    const fraction = attendance.sold / attendance.capacity;
    const tier = tiers.find(
      (t) => fraction >= t.from && (t.to == null || fraction < t.to),
    );
    if (!tier) {
      return { ok: false, reason: "Attendance fraction did not match any ratchet tier." };
    }
    const payout = basis * tier.percentage;
    return {
      ok: true,
      payout,
      steps: [
        {
          label: `${formatPct(tier.from)}-${tier.to == null ? "up" : formatPct(tier.to)} sold @ ${formatPct(tier.percentage)}`,
          value: payout,
          note: `${(fraction * 100).toFixed(1)}% sold (${attendance.sold} / ${attendance.capacity}).`,
        },
      ],
    };
  }

  let payout = 0;
  const steps: SettlementStep[] = [];
  for (const tier of tiers) {
    const bandTop = tier.to ?? basis;
    const bandAmount = Math.max(0, Math.min(basis, bandTop) - tier.from);
    if (bandAmount <= 0) continue;
    const bandPayout = bandAmount * tier.percentage;
    payout += bandPayout;
    steps.push({
      label: `Tier ${formatMoneyInline(tier.from)}-${tier.to == null ? "up" : formatMoneyInline(tier.to)} @ ${formatPct(tier.percentage)}`,
      value: bandPayout,
      note: `${formatMoneyInline(bandAmount)} in this band.`,
      kind: "tier",
    });
  }

  return { ok: true, payout, steps };
}

function computePercentageSide(
  deal: Deal,
  basis: number,
  basisLabel: "gross" | "net",
  tierRatchet?: Extract<Bonus, { type: "tier_ratchet" }>,
  attendance?: { sold: number; capacity: number },
):
  | { ok: true; payout: number; steps: SettlementStep[] }
  | { ok: false; reason: string } {
  if (tierRatchet) {
    const result = applyTierRatchet(tierRatchet.tiers, basis, attendance);
    if (!result.ok) return result;
    if (result.steps.length <= 1) {
      return { ok: true, payout: result.payout, steps: result.steps };
    }
    return {
      ok: true,
      payout: result.payout,
      steps: [
        {
          label: "Tier ratchet applied",
          value: result.payout,
          note: `${tierRatchet.label} on ${basisLabel}.`,
          kind: "tier",
        },
        ...result.steps,
      ],
    };
  }

  if (deal.percentage == null) {
    return { ok: false, reason: "Percentage side is missing a percentage." };
  }

  const payout = basis * deal.percentage;
  return {
    ok: true,
    payout,
    steps: [
      {
        label: `× ${formatPct(deal.percentage)} to artist`,
        value: payout,
        note: `Percentage of ${basisLabel}.`,
      },
    ],
  };
}

function validateRatchetTiers(
  tiers: { from: number; to: number | null; percentage: number }[],
): { ok: true } | { ok: false; reason: string } {
  if (tiers.length === 0) {
    return { ok: false, reason: "Ratchet bonus has no tiers." };
  }
  if (tiers[0].from !== 0) {
    return {
      ok: false,
      reason: `Ratchet tier 1 starts at ${formatMoneyInline(tiers[0].from)} but must start at $0. Edit the deal to fix the tiers.`,
    };
  }

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const tierNo = i + 1;
    if (i > 0 && tier.from < tiers[i - 1].from) {
      return {
        ok: false,
        reason: `Ratchet tier ${tierNo} is not sorted by starting amount. Edit the deal to fix the tiers.`,
      };
    }
    if (tier.to != null && tier.to <= tier.from) {
      return {
        ok: false,
        reason: `Ratchet tier ${tierNo} ends at ${formatMoneyInline(tier.to)} but starts at ${formatMoneyInline(tier.from)}. Edit the deal to fix the tiers.`,
      };
    }
    if (tier.to == null && i !== tiers.length - 1) {
      return {
        ok: false,
        reason: `Ratchet tier ${tierNo} is open-ended before the final tier. Edit the deal to fix the tiers.`,
      };
    }
    if (i > 0) {
      const previousTo = tiers[i - 1].to;
      if (previousTo == null) {
        return {
          ok: false,
          reason: `Ratchet tier ${i} is open-ended before tier ${tierNo}. Edit the deal to fix the tiers.`,
        };
      }
      if (tier.from > previousTo) {
        return {
          ok: false,
          reason: `Ratchet tier ${tierNo} starts at ${formatMoneyInline(tier.from)} but tier ${i} ends at ${formatMoneyInline(previousTo)} - there's a ${formatMoneyInline(tier.from - previousTo)} gap. Edit the deal to fix the tiers.`,
        };
      }
      if (tier.from < previousTo) {
        return {
          ok: false,
          reason: `Ratchet tier ${tierNo} starts at ${formatMoneyInline(tier.from)} but tier ${i} ends at ${formatMoneyInline(previousTo)} - the tiers overlap. Edit the deal to fix the tiers.`,
        };
      }
    }
  }

  return { ok: true };
}

function resolveRecoups(deal: Deal, applications: Recoup[]): RecoupResolution {
  const clauses = parseRecoupClauses(deal);
  const resolved: RecoupApplication[] = [];
  const postSplitOverages: RecoupApplication[] = [];
  const matchedAppIds = new Set<string>();

  for (const clause of clauses) {
    const app = applications.find((candidate) => candidate.id === clause.id);
    if (app) matchedAppIds.add(app.id);
    if (app?.status === "withdrawn") continue;

    const amount = resolveClauseAmount(clause, app);
    if (!amount.ok) return amount;

    if (amount.amount > 0) {
      resolved.push({
        id: clause.id,
        label: clause.label,
        category: clause.category,
        waterfallPosition: clause.waterfallPosition,
        amount: amount.amount,
        note: clause.rationale ?? undefined,
        overageAmount: amount.overageAmount,
      });
    }

    if (amount.overageArtistAmount > 0) {
      postSplitOverages.push({
        id: `${clause.id}_overage`,
        label: `${clause.label} overage`,
        category: clause.category,
        waterfallPosition: "post_split",
        amount: amount.overageArtistAmount,
        note: amount.overageNote,
      });
    }
  }

  for (const app of applications) {
    if (matchedAppIds.has(app.id) || app.status === "withdrawn") continue;
    resolved.push({
      id: app.id,
      label: app.label,
      category: parseRecoupCategory(app.category),
      waterfallPosition: "outside_cap_pre_split",
      amount: app.amount,
      note: "Legacy recoup without a deal-time clause. Treated as outside the expense cap.",
    });
  }

  return { ok: true, applications: resolved, postSplitOverages };
}

function resolveClauseAmount(
  clause: RecoupClause,
  app?: Recoup,
):
  | {
      ok: true;
      amount: number;
      overageAmount: number;
      overageArtistAmount: number;
      overageNote?: string;
    }
  | { ok: false; reason: string } {
  if (clause.amountModel === "fixed") {
    if (clause.fixedAmount == null) {
      return { ok: false, reason: `Recoup clause "${clause.label}" is fixed but missing an amount.` };
    }
    return { ok: true, amount: clause.fixedAmount, overageAmount: 0, overageArtistAmount: 0 };
  }

  if (!app) {
    return {
      ok: false,
      reason: `Recoup clause "${clause.label}" needs an actual billed amount or a withdrawn status before settlement can be signed.`,
    };
  }

  if (clause.amountModel === "actual_uncapped") {
    return { ok: true, amount: app.amount, overageAmount: 0, overageArtistAmount: 0 };
  }

  if (clause.capAmount == null) {
    return { ok: false, reason: `Recoup clause "${clause.label}" is capped but missing a cap amount.` };
  }

  const amount = Math.min(app.amount, clause.capAmount);
  const overageAmount = Math.max(0, app.amount - clause.capAmount);
  if (overageAmount <= 0) {
    return { ok: true, amount, overageAmount: 0, overageArtistAmount: 0 };
  }

  if (clause.overageAbsorbedBy === "artist") {
    return {
      ok: true,
      amount,
      overageAmount,
      overageArtistAmount: overageAmount,
      overageNote: `Actuals exceeded the cap by ${formatMoneyInline(overageAmount)}; artist absorbs the overage.`,
    };
  }

  if (clause.overageAbsorbedBy === "split") {
    const splitPct = clause.overageSplitPct ?? 0;
    return {
      ok: true,
      amount,
      overageAmount,
      overageArtistAmount: overageAmount * splitPct,
      overageNote: `Actuals exceeded the cap by ${formatMoneyInline(overageAmount)}; artist absorbs ${formatPct(splitPct)} of the overage.`,
    };
  }

  return {
    ok: true,
    amount,
    overageAmount,
    overageArtistAmount: 0,
    overageNote: `Actuals exceeded the cap by ${formatMoneyInline(overageAmount)}; venue absorbs the overage.`,
  };
}

/** Evaluate a list of bonuses against the show's actual numbers. */
function applyBonuses(
  bonuses: Bonus[],
  ctx: { gross: number; tickets: number; capacity?: number },
) {
  const applied: { label: string; amount: number; reason: string }[] = [];
  const notTriggered: { label: string; amount: number; reason: string }[] = [];

  for (const b of bonuses) {
    if (b.type === "gross_threshold") {
      if (ctx.gross >= b.threshold) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `Gross ${ctx.gross.toLocaleString()} >= ${b.threshold.toLocaleString()}`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason: `Gross ${ctx.gross.toLocaleString()} < ${b.threshold.toLocaleString()}`,
        });
      }
    } else if (b.type === "sellout") {
      if (ctx.capacity != null && ctx.tickets >= ctx.capacity * 0.95) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} of ${ctx.capacity} sold`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason:
            ctx.capacity != null
              ? `${ctx.tickets} of ${ctx.capacity} sold (sellout = >=95%)`
              : "Capacity unknown - can't evaluate",
        });
      }
    } else if (b.type === "attendance_threshold") {
      if (ctx.tickets >= b.threshold) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} >= ${b.threshold}`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} < ${b.threshold}`,
        });
      }
    }
  }

  return {
    applied,
    notTriggered,
    totalApplied: applied.reduce((s, b) => s + b.amount, 0),
  };
}

function computeGross(ticketSales: TicketSale[], comps: Comp[]) {
  const ticketedGross = ticketSales.reduce((sum, t) => sum + t.gross, 0);
  const countedCompValue = comps
    .filter((c) => c.countsTowardGross)
    .reduce((sum, c) => sum + c.count * c.faceValue, 0);
  return {
    ticketedGross,
    countedCompValue,
    grossBoxOffice: ticketedGross + countedCompValue,
  };
}

function postSplitSteps(recoups: Extract<RecoupResolution, { ok: true }>): SettlementStep[] {
  return [
    ...recoups.applications
      .filter((r) => r.waterfallPosition === "post_split")
      .map((r) => recoupStep(r, -r.amount)),
    ...recoups.postSplitOverages.map((r) => recoupStep(r, -r.amount)),
  ];
}

function recoupStep(r: RecoupApplication, value: number): SettlementStep {
  return {
    label: `${r.label} (${RECOUP_POSITION_LABELS[r.waterfallPosition]})`,
    value,
    note: r.note,
    kind: "recoup",
  };
}

function grossOnlySteps(base: NetResult): SettlementStep[] {
  const steps: SettlementStep[] = [{ label: "Gross box office", value: base.grossBoxOffice }];
  if (base.grossAfterOffGross !== base.grossBoxOffice) {
    steps.push({
      label: "Gross after off-gross recoups",
      value: base.grossAfterOffGross,
    });
  }
  return steps;
}

function expenseCapNote(
  rawExpenses: number,
  insideCapRecoups: number,
  subjectToCap: number,
  capped: number,
) {
  const sources =
    insideCapRecoups > 0
      ? `${formatMoneyInline(rawExpenses)} expenses + ${formatMoneyInline(insideCapRecoups)} recoups inside cap`
      : `${formatMoneyInline(rawExpenses)} expenses`;
  const clipped = subjectToCap - capped;
  if (clipped > 0) {
    return `${sources} → ${formatMoneyInline(clipped)} over cap, not passed through.`;
  }
  return sources;
}

function sumByPosition(applications: RecoupApplication[], position: WaterfallPosition) {
  return applications
    .filter((r) => r.waterfallPosition === position)
    .reduce((sum, r) => sum + r.amount, 0);
}

function sumPostSplitOverages(applications: RecoupApplication[]) {
  return applications.reduce((sum, r) => sum + r.amount, 0);
}

function tierRatchetNotApplicable(
  tierRatchet: Extract<Bonus, { type: "tier_ratchet" }> | undefined,
  reason: string,
) {
  return tierRatchet ? [{ label: tierRatchet.label, amount: 0, reason }] : [];
}

function misconfigured(deal: Deal, reason: string): SettlementCalculation {
  return {
    supported: false,
    kind: "deal_misconfigured",
    reason,
    dealType: deal.dealType,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseRecoupCategory(value: unknown): RecoupClause["category"] {
  switch (value) {
    case "marketing":
    case "prior_advance":
    case "production_overage":
    case "hospitality_overage":
    case "backline":
    case "damages":
    case "other":
      return value;
    default:
      console.warn(
        `Unknown recoup category "${String(value)}"; treating it as "other".`,
      );
      return "other";
  }
}

function parseWaterfallPosition(value: unknown): WaterfallPosition | null {
  switch (value) {
    case "off_gross":
    case "inside_expense_cap":
    case "outside_cap_pre_split":
    case "post_split":
      return value;
    default:
      return null;
  }
}

function parseOverageOwner(value: unknown): RecoupClause["overageAbsorbedBy"] {
  switch (value) {
    case "venue":
    case "artist":
    case "split":
    case "n_a":
      return value;
    default:
      return "n_a";
  }
}

function formatPct(pct: number) {
  return `${(pct * 100).toFixed(pct * 100 >= 10 ? 0 : 1)}%`;
}

function formatMoneyInline(amount: number) {
  return `$${Math.round(amount).toLocaleString()}`;
}
