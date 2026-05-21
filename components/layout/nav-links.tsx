"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { Calendar, Users, BarChart3, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

const productItems = [
  { href: "/shows", label: "Shows", icon: Calendar },
  { href: "/artists", label: "Artists", icon: Users },
  { href: "/reports", label: "Reports", icon: BarChart3 },
];

const reviewerItems = [
  { href: "/threads", label: "AI session log", icon: MessageSquare },
];

function NavItem({
  href,
  label,
  Icon,
  active,
}: {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-all duration-150",
        active
          ? "bg-white text-ink-900 font-medium shadow-[0_1px_3px_rgba(26,24,20,0.06)] ring-1 ring-ink-200/40"
          : "text-ink-500 hover:bg-white/70 hover:text-ink-900",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 transition-colors",
          active ? "text-brand-700" : "text-ink-400",
        )}
      />
      {label}
    </Link>
  );
}

export function NavLinks() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  return (
    <>
      {productItems.map((item) => (
        <NavItem
          key={item.href}
          href={item.href}
          label={item.label}
          Icon={item.icon}
          active={isActive(item.href)}
        />
      ))}

      <div className="pt-4 mt-2 border-t border-ink-200/50">
        <div className="px-3 pb-1.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-ink-400">
          For reviewer
        </div>
        {reviewerItems.map((item) => (
          <NavItem
            key={item.href}
            href={item.href}
            label={item.label}
            Icon={item.icon}
            active={isActive(item.href)}
          />
        ))}
      </div>
    </>
  );
}
