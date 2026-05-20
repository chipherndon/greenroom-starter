"use client";

import * as React from "react";
import { Download } from "lucide-react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";
import type { SettlementStep } from "@/lib/dealMath";

export type WorksheetExportData = {
  artistName: string;
  showDate: string;
  dealType: string;
  grossBoxOffice: number;
  netBoxOffice: number;
  totalExpenses: number;
  totalToArtist: number;
  steps: SettlementStep[];
  comparison?: {
    guarantee: number;
    percentage: number;
    winner: "guarantee" | "percentage";
    margin: number;
    basisLabel: "gross" | "net";
  };
};

// jsPDF's built-in Helvetica is WinAnsi-encoded and can't render most
// Unicode glyphs the deal math uses (− × → en-dash, curly quotes, etc.).
// Substitute ASCII equivalents so the PDF renders cleanly.
function sanitizeForPdf(input: string): string {
  return input
    .replace(/−/g, "-") // minus sign
    .replace(/×/g, "x") // multiplication sign
    .replace(/→/g, "->") // right arrow
    .replace(/[–—]/g, "-") // en/em dash
    .replace(/[‘’]/g, "'") // curly single quotes
    .replace(/[“”]/g, '"') // curly double quotes
    .replace(/…/g, "...") // ellipsis
    .replace(/·/g, "·"); // middle dot is fine in WinAnsi, keep it
}

export function ExportWorksheetPdfButton({
  data,
}: {
  data: WorksheetExportData;
}) {
  const handleExport = React.useCallback(() => {
    const doc = new jsPDF({ unit: "pt", format: "letter" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const marginX = 56;

    // Header
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.setTextColor(26, 24, 20);
    doc.text("Settlement worksheet", marginX, 72);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(110, 105, 95);
    doc.text(
      sanitizeForPdf(`${data.artistName} · ${data.showDate}`),
      marginX,
      92,
    );

    // Deal type chip-style label
    doc.setFontSize(9);
    doc.setTextColor(150, 145, 135);
    doc.text(
      sanitizeForPdf(`Deal: ${data.dealType.replace(/_/g, " ")}`),
      marginX,
      108,
    );

    // Box-office summary table
    autoTable(doc, {
      startY: 130,
      margin: { left: marginX, right: marginX },
      head: [["Box office", "Amount"]],
      body: [
        ["Gross box office", formatMoney(data.grossBoxOffice)],
        ["Net box office", formatMoney(data.netBoxOffice)],
        ["Total expenses (passed through)", formatMoney(data.totalExpenses)],
      ],
      theme: "plain",
      styles: {
        font: "helvetica",
        fontSize: 10,
        cellPadding: { top: 6, right: 8, bottom: 6, left: 0 },
        textColor: [40, 36, 30],
      },
      headStyles: {
        fontStyle: "bold",
        textColor: [120, 115, 105],
        fontSize: 8,
        cellPadding: { top: 0, right: 8, bottom: 6, left: 0 },
      },
      columnStyles: {
        0: { cellWidth: "auto" },
        1: {
          halign: "right",
          font: "courier",
          textColor: [26, 24, 20],
        },
      },
      didParseCell: (hookData) => {
        if (hookData.section === "head" && hookData.column.index === 1) {
          hookData.cell.styles.halign = "right";
        }
      },
    });

    // Worksheet steps
    const stepsBody = data.steps.map((step) => {
      const label = sanitizeForPdf(step.label);
      const note = step.note ? sanitizeForPdf(step.note) : null;
      const labelCell = note ? `${label}\n${note}` : label;
      return [labelCell, formatMoney(step.value)];
    });

    const afterBoxOfficeY =
      (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 24;

    autoTable(doc, {
      startY: afterBoxOfficeY,
      margin: { left: marginX, right: marginX },
      head: [["Worksheet", "Amount"]],
      body: stepsBody,
      foot: [["Total to artist", formatMoney(data.totalToArtist)]],
      theme: "plain",
      styles: {
        font: "helvetica",
        fontSize: 10,
        cellPadding: { top: 7, right: 8, bottom: 7, left: 0 },
        textColor: [40, 36, 30],
        lineColor: [232, 228, 220],
        lineWidth: 0,
      },
      headStyles: {
        fontStyle: "bold",
        textColor: [120, 115, 105],
        fontSize: 8,
        cellPadding: { top: 0, right: 8, bottom: 6, left: 0 },
      },
      footStyles: {
        fontStyle: "bold",
        fontSize: 11,
        textColor: [26, 24, 20],
        cellPadding: { top: 10, right: 8, bottom: 6, left: 0 },
        lineWidth: { top: 1, bottom: 0, left: 0, right: 0 },
        lineColor: [200, 195, 185],
      },
      columnStyles: {
        0: { cellWidth: "auto" },
        1: {
          halign: "right",
          font: "courier",
          textColor: [26, 24, 20],
        },
      },
      didParseCell: (hookData) => {
        if (hookData.section === "head" && hookData.column.index === 1) {
          hookData.cell.styles.halign = "right";
          return;
        }
        if (hookData.section !== "body") return;
        const step = data.steps[hookData.row.index];
        if (!step) return;
        if (step.kind === "winner") {
          hookData.cell.styles.fillColor = [245, 240, 225];
          hookData.cell.styles.fontStyle = "bold";
        } else if (step.kind === "net") {
          hookData.cell.styles.fillColor = [232, 240, 248];
          hookData.cell.styles.fontStyle = "bold";
        }
        if (step.kind === "tier" && hookData.column.index === 0) {
          hookData.cell.styles.cellPadding = {
            top: 7,
            right: 8,
            bottom: 7,
            left: 16,
          };
        }
      },
    });

    // Optional vs comparison
    if (data.comparison) {
      const afterStepsY =
        (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
          .finalY + 24;

      const c = data.comparison;
      const guaranteeLabel = c.winner === "guarantee"
        ? "Guarantee side (winner)"
        : "Guarantee side";
      const percentageLabel = c.winner === "percentage"
        ? `${c.basisLabel === "gross" ? "Gross" : "Net"} percentage side (winner)`
        : `${c.basisLabel === "gross" ? "Gross" : "Net"} percentage side`;

      autoTable(doc, {
        startY: afterStepsY,
        margin: { left: marginX, right: marginX },
        head: [["Vs comparison", "Amount"]],
        body: [
          [sanitizeForPdf(guaranteeLabel), formatMoney(c.guarantee)],
          [sanitizeForPdf(percentageLabel), formatMoney(c.percentage)],
          ["Margin", formatMoney(c.margin)],
        ],
        theme: "plain",
        styles: {
          font: "helvetica",
          fontSize: 10,
          cellPadding: { top: 6, right: 8, bottom: 6, left: 0 },
          textColor: [40, 36, 30],
        },
        headStyles: {
          fontStyle: "bold",
          textColor: [120, 115, 105],
          fontSize: 8,
          cellPadding: { top: 0, right: 8, bottom: 6, left: 0 },
        },
        columnStyles: {
          0: { cellWidth: "auto" },
          1: {
            halign: "right",
            font: "courier",
            textColor: [26, 24, 20],
          },
        },
        didParseCell: (hookData) => {
          if (hookData.section === "head" && hookData.column.index === 1) {
            hookData.cell.styles.halign = "right";
            return;
          }
          if (hookData.section !== "body") return;
          const isGuaranteeRow = hookData.row.index === 0;
          const isPercentageRow = hookData.row.index === 1;
          const winnerRow =
            (c.winner === "guarantee" && isGuaranteeRow) ||
            (c.winner === "percentage" && isPercentageRow);
          if (winnerRow) {
            hookData.cell.styles.fontStyle = "bold";
            hookData.cell.styles.fillColor = [245, 240, 225];
          }
        },
      });
    }

    // Footer
    const pageHeight = doc.internal.pageSize.getHeight();
    doc.setFontSize(8);
    doc.setTextColor(160, 155, 145);
    doc.text(
      `Generated by Greenroom · ${new Date().toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })}`,
      marginX,
      pageHeight - 32,
    );
    doc.text(
      `Page ${doc.getNumberOfPages()}`,
      pageWidth - marginX,
      pageHeight - 32,
      { align: "right" },
    );

    const safeArtist = data.artistName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const safeDate = data.showDate.replace(/[^0-9]+/g, "-");
    doc.save(`settlement-${safeArtist}-${safeDate}.pdf`);
  }, [data]);

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleExport}
      aria-label="Export settlement worksheet as PDF"
      className="-mt-1 -mb-1"
    >
      <Download className="h-3.5 w-3.5" />
      Download PDF
    </Button>
  );
}
