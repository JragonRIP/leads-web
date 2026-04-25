"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  WIMI_BATCH1_IMPORT_KEY,
  WIMI_BATCH1_SEEDS,
} from "../data/wiMiBatch1";

const STORAGE_KEY = "leadTracker_v1";

const WEBSITE_OPTIONS = [
  "No Website",
  "Facebook Only",
  "Bad Website",
  "Has Good Website",
] as const;

const LEAD_STATUS_OPTIONS = [
  "Not Called",
  "Called",
  "Interested",
  "Demo Built",
  "Booked",
  "Dead",
] as const;

const PRIORITY_OPTIONS = ["High", "Medium", "Low"] as const;
const TIER_OPTIONS = ["Starter", "Pro", "Store"] as const;

export type WebsiteStatus = (typeof WEBSITE_OPTIONS)[number];
export type LeadStatus = (typeof LEAD_STATUS_OPTIONS)[number];
export type Priority = (typeof PRIORITY_OPTIONS)[number];
export type Tier = (typeof TIER_OPTIONS)[number];

export type Lead = {
  id: string;
  businessName: string;
  phone: string;
  websiteStatus: WebsiteStatus;
  leadStatus: LeadStatus;
  priority: Priority;
  recommendedTier: Tier;
  notes: string;
};

type Persisted = {
  leads: Lead[];
  meta: { dayKey: string; callsToday: number };
};

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function loadPersisted(): Persisted {
  if (typeof window === "undefined") {
    return { leads: [], meta: { dayKey: todayKey(), callsToday: 0 } };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { leads: [], meta: { dayKey: todayKey(), callsToday: 0 } };
    const parsed = JSON.parse(raw) as Persisted;
    const dayKey = todayKey();
    if (!parsed.meta || parsed.meta.dayKey !== dayKey) {
      return {
        leads: Array.isArray(parsed.leads) ? parsed.leads : [],
        meta: { dayKey, callsToday: 0 },
      };
    }
    return {
      leads: Array.isArray(parsed.leads) ? parsed.leads : [],
      meta: parsed.meta,
    };
  } catch {
    return { leads: [], meta: { dayKey: todayKey(), callsToday: 0 } };
  }
}

function savePersisted(data: Persisted) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** One-time: prepends WI / UP MI batch; skips rows whose phone already exists (digits). */
function mergeWiMiBatch1IfNeeded(existing: Lead[]): Lead[] {
  if (typeof window === "undefined") return existing;
  try {
    if (localStorage.getItem(WIMI_BATCH1_IMPORT_KEY)) return existing;

    const seen = new Set(existing.map((l) => phoneDigits(l.phone)).filter(Boolean));
    const additions: Lead[] = [];

    for (const row of WIMI_BATCH1_SEEDS) {
      const d = phoneDigits(row.phone);
      if (!d || seen.has(d)) continue;
      seen.add(d);
      additions.push({
        id: newId(),
        businessName: row.businessName,
        phone: row.phone,
        websiteStatus: "No Website",
        leadStatus: "Not Called",
        priority: row.priority,
        recommendedTier: row.tier,
        notes: `${row.trade} · ${row.location}`,
      });
    }

    localStorage.setItem(WIMI_BATCH1_IMPORT_KEY, "1");
    if (additions.length === 0) return existing;
    return [...additions, ...existing];
  } catch {
    return existing;
  }
}

function emptyLead(): Lead {
  return {
    id: newId(),
    businessName: "",
    phone: "",
    websiteStatus: "No Website",
    leadStatus: "Not Called",
    priority: "Medium",
    recommendedTier: "Starter",
    notes: "",
  };
}

const PRIORITY_ORDER: Record<Priority, number> = {
  High: 0,
  Medium: 1,
  Low: 2,
};

const TIER_ORDER: Record<Tier, number> = {
  Starter: 0,
  Pro: 1,
  Store: 2,
};

function leadStatusClass(status: LeadStatus): string {
  switch (status) {
    case "Booked":
      return "bg-emerald-950/80 text-emerald-300 ring-1 ring-emerald-700/50";
    case "Dead":
      return "bg-red-950/80 text-red-300 ring-1 ring-red-800/50";
    case "Interested":
      return "bg-amber-950/80 text-amber-200 ring-1 ring-amber-600/40";
    case "Not Called":
      return "bg-zinc-800/90 text-zinc-400 ring-1 ring-zinc-600/40";
    default:
      return "bg-[var(--gold-muted)] text-[var(--gold)] ring-1 ring-[var(--gold-dim)]/40";
  }
}

function escapeCsvCell(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export default function LeadTracker() {
  const [mounted, setMounted] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [meta, setMeta] = useState<{ dayKey: string; callsToday: number }>({
    dayKey: "",
    callsToday: 0,
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<"priority" | "tier" | "name">("priority");
  const [statusFilter, setStatusFilter] = useState<Set<LeadStatus>>(
    () => new Set(LEAD_STATUS_OPTIONS)
  );

  useEffect(() => {
    startTransition(() => {
      const p = loadPersisted();
      const merged = mergeWiMiBatch1IfNeeded(p.leads);
      if (merged !== p.leads) {
        savePersisted({ leads: merged, meta: p.meta });
      }
      setLeads(merged);
      setMeta(p.meta);
      setMounted(true);
    });
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const dayKey = todayKey();
    if (meta.dayKey !== dayKey) {
      startTransition(() => {
        setMeta({ dayKey, callsToday: 0 });
      });
      return;
    }
    savePersisted({ leads, meta });
  }, [mounted, leads, meta]);

  const setLeadField = useCallback(
    (id: string, field: keyof Lead, value: string) => {
      setLeads((prev) => {
        const idx = prev.findIndex((l) => l.id === id);
        if (idx === -1) return prev;
        const current = prev[idx];
        const prevStatus = current.leadStatus;
        const next: Lead = { ...current, [field]: value } as Lead;

        if (field === "leadStatus" && value === "Called" && prevStatus !== "Called") {
          const dayKey = todayKey();
          setMeta((m) => {
            const base = m.dayKey !== dayKey ? { dayKey, callsToday: 0 } : m;
            return { ...base, callsToday: base.callsToday + 1 };
          });
        }

        const copy = [...prev];
        copy[idx] = next;
        return copy;
      });
    },
    []
  );

  const dashboard = useMemo(() => {
    const total = leads.length;
    const interested = leads.filter((l) => l.leadStatus === "Interested").length;
    const booked = leads.filter((l) => l.leadStatus === "Booked").length;
    const dayKey = todayKey();
    const callsToday =
      meta.dayKey === dayKey ? meta.callsToday : 0;
    return { total, interested, booked, callsToday };
  }, [leads, meta]);

  const filteredSorted = useMemo(() => {
    const filtered = leads.filter((l) => statusFilter.has(l.leadStatus));
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sortMode === "priority") {
        const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (p !== 0) return p;
        const t = TIER_ORDER[a.recommendedTier] - TIER_ORDER[b.recommendedTier];
        if (t !== 0) return t;
        return a.businessName.localeCompare(b.businessName);
      }
      if (sortMode === "tier") {
        const t = TIER_ORDER[a.recommendedTier] - TIER_ORDER[b.recommendedTier];
        if (t !== 0) return t;
        const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (p !== 0) return p;
        return a.businessName.localeCompare(b.businessName);
      }
      return a.businessName.localeCompare(b.businessName);
    });
    return sorted;
  }, [leads, statusFilter, sortMode]);

  const addLead = () => {
    const n = emptyLead();
    setLeads((prev) => [n, ...prev]);
    setExpandedId(n.id);
  };

  const exportCsv = () => {
    const headers = [
      "Business Name",
      "Phone",
      "Website Status",
      "Lead Status",
      "Priority",
      "Recommended Tier",
      "Notes",
    ];
    const rows = leads.map((l) =>
      [
        l.businessName,
        l.phone,
        l.websiteStatus,
        l.leadStatus,
        l.priority,
        l.recommendedTier,
        l.notes,
      ].map(escapeCsvCell)
    );
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-backup-${todayKey()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleStatusFilter = (s: LeadStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) {
        if (next.size === 1) return prev;
        next.delete(s);
      } else {
        next.add(s);
      }
      return next;
    });
  };

  if (!mounted) {
    return (
      <div className="min-h-dvh bg-[var(--bg)] flex items-center justify-center text-[var(--text-muted)] text-sm">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--text)] pb-[env(safe-area-inset-bottom,0px)]">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)] sm:text-3xl">
              Lead Tracker
            </h1>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Premium pipeline — saves automatically
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={addLead}
              className="rounded-lg bg-[var(--gold)] px-4 py-2.5 text-sm font-medium text-black transition hover:bg-[#dfc056] active:scale-[0.98]"
            >
              Add business
            </button>
            <button
              type="button"
              onClick={exportCsv}
              className="rounded-lg border border-[var(--gold-dim)]/60 bg-transparent px-4 py-2.5 text-sm font-medium text-[var(--gold)] transition hover:bg-[var(--gold-muted)]"
            >
              Export CSV
            </button>
          </div>
        </header>

        <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Total leads", value: dashboard.total },
            { label: "Calls today", value: dashboard.callsToday },
            { label: "Interested", value: dashboard.interested },
            { label: "Booked", value: dashboard.booked },
          ].map((card) => (
            <div
              key={card.label}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 shadow-sm"
            >
              <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                {card.label}
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-[var(--gold)]">
                {card.value}
              </p>
            </div>
          ))}
        </section>

        <section className="mb-6 space-y-4 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <label className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
              <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Sort
              </span>
              <select
                className="lead-select max-w-full sm:max-w-xs"
                value={sortMode}
                onChange={(e) =>
                  setSortMode(e.target.value as "priority" | "tier" | "name")
                }
              >
                <option value="priority">Priority (high first)</option>
                <option value="tier">Recommended tier</option>
                <option value="name">Business name A–Z</option>
              </select>
            </label>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              Lead status filter
            </p>
            <div className="flex flex-wrap gap-2">
              {LEAD_STATUS_OPTIONS.map((s) => {
                const on = statusFilter.has(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleStatusFilter(s)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                      on
                        ? `${leadStatusClass(s)}`
                        : "bg-[#0a0a0a] text-zinc-600 ring-1 ring-zinc-800 line-through opacity-60"
                    }`}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <div className="space-y-2">
          {filteredSorted.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-card)] px-4 py-12 text-center text-sm text-[var(--text-muted)]">
              No leads match your filters. Adjust status chips or add a business.
            </p>
          ) : (
            filteredSorted.map((lead) => (
              <LeadRow
                key={lead.id}
                lead={lead}
                expanded={expandedId === lead.id}
                onToggle={() =>
                  setExpandedId((id) => (id === lead.id ? null : lead.id))
                }
                onChange={(field, value) => setLeadField(lead.id, field, value)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function LeadRow({
  lead,
  expanded,
  onToggle,
  onChange,
}: {
  lead: Lead;
  expanded: boolean;
  onToggle: () => void;
  onChange: (field: keyof Lead, value: string) => void;
}) {
  const telHref =
    lead.phone.trim() === ""
      ? undefined
      : `tel:${lead.phone.replace(/[^\d+]/g, "")}`;

  return (
    <article
      className={`overflow-hidden rounded-xl border transition-colors ${
        expanded
          ? "border-[var(--gold-dim)] bg-[var(--bg-elevated)] ring-1 ring-[var(--gold)]/20"
          : "border-[var(--border)] bg-[var(--bg-card)] hover:border-zinc-700"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3 text-left sm:items-center sm:px-4 sm:py-3.5"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-[var(--text)]">
            {lead.businessName.trim() || "Untitled business"}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            {telHref ? (
              <a
                href={telHref}
                onClick={(e) => e.stopPropagation()}
                className="text-[var(--gold)] underline decoration-[var(--gold-dim)] underline-offset-2 hover:text-[#dfc056]"
              >
                {lead.phone}
              </a>
            ) : (
              <span className="text-[var(--text-muted)]">No phone</span>
            )}
            <span className="text-[var(--text-muted)]">
              {lead.priority} · {lead.recommendedTier}
            </span>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${leadStatusClass(lead.leadStatus)}`}
        >
          {lead.leadStatus}
        </span>
        <span
          className={`shrink-0 text-[var(--gold)] transition ${expanded ? "rotate-180" : ""}`}
          aria-hidden
        >
          <Chevron />
        </span>
      </button>

      {expanded && (
        <div
          className="border-t border-[var(--border)] px-4 py-4 sm:px-5"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Business name">
              <input
                className="lead-input"
                value={lead.businessName}
                onChange={(e) => onChange("businessName", e.target.value)}
                placeholder="Business name"
                autoComplete="organization"
              />
            </Field>
            <Field label="Phone">
              <input
                className="lead-input"
                value={lead.phone}
                onChange={(e) => onChange("phone", e.target.value)}
                placeholder="Phone number"
                inputMode="tel"
                autoComplete="tel"
              />
            </Field>
            <Field label="Website status">
              <select
                className="lead-select"
                value={lead.websiteStatus}
                onChange={(e) =>
                  onChange("websiteStatus", e.target.value as WebsiteStatus)
                }
              >
                {WEBSITE_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Lead status">
              <select
                className="lead-select"
                value={lead.leadStatus}
                onChange={(e) =>
                  onChange("leadStatus", e.target.value as LeadStatus)
                }
              >
                {LEAD_STATUS_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <select
                className="lead-select"
                value={lead.priority}
                onChange={(e) =>
                  onChange("priority", e.target.value as Priority)
                }
              >
                {PRIORITY_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Recommended tier">
              <select
                className="lead-select"
                value={lead.recommendedTier}
                onChange={(e) =>
                  onChange("recommendedTier", e.target.value as Tier)
                }
              >
                {TIER_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Notes" className="sm:col-span-2">
              <textarea
                className="lead-input min-h-[120px] resize-y"
                value={lead.notes}
                onChange={(e) => onChange("notes", e.target.value)}
                placeholder="Notes…"
                rows={4}
              />
            </Field>
          </div>
        </div>
      )}
    </article>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </label>
      {children}
    </div>
  );
}

function Chevron() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
