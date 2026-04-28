"use client";

import {
  forwardRef,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
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
  "Went to Voicemail",
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
  /** Creation time for ordering (newer leads sort earlier within the same priority/tier). */
  addedAt: number;
  /** True once this business has been counted as "called". */
  callPointAwarded: boolean;
  /** Mark standout/special businesses. */
  starred: boolean;
};

const META_VERSION = 2;

type TrackerMeta = {
  dayKey: string;
  callsToday: number;
  /** Call attempts on days before `dayKey` (rolled from each prior day’s `callsToday`). */
  callsLifetime: number;
  metaVersion: number;
};

function rollMetaToNewDay(m: TrackerMeta, newDayKey: string): TrackerMeta {
  if (m.dayKey === newDayKey) return { ...m, metaVersion: META_VERSION };
  return {
    dayKey: newDayKey,
    callsToday: 0,
    callsLifetime: (m.callsLifetime ?? 0) + (m.callsToday ?? 0),
    metaVersion: META_VERSION,
  };
}

type Persisted = {
  leads: Lead[];
  meta: TrackerMeta;
};

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function normalizeLeadArray(raw: unknown): Lead[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const l = item as Lead;
    return {
      ...l,
      addedAt: typeof l.addedAt === "number" ? l.addedAt : 0,
      callPointAwarded:
        typeof l.callPointAwarded === "boolean"
          ? l.callPointAwarded
          : l.leadStatus !== "Not Called",
      starred: typeof l.starred === "boolean" ? l.starred : false,
    };
  });
}

function normalizeMeta(stored: Partial<TrackerMeta> | undefined, dayKey: string): TrackerMeta {
  let callsLifetime =
    typeof stored?.callsLifetime === "number" ? stored.callsLifetime : 0;
  let callsToday =
    typeof stored?.callsToday === "number" ? stored.callsToday : 0;
  const storedDay = stored?.dayKey;
  const sameDay = Boolean(storedDay) && storedDay === dayKey;

  // New calendar day since last save: merge yesterday’s tally into lifetime.
  if (!sameDay && storedDay) {
    callsLifetime += callsToday;
    callsToday = 0;
  }

  let metaVersion =
    typeof stored?.metaVersion === "number" ? stored.metaVersion : 1;

  // Older builds incremented callsLifetime on every dial *and* kept callsToday — double count
  // if we sum them. Split so lifetime = prior days only for the same calendar day.
  if (
    metaVersion < META_VERSION &&
    Boolean(storedDay) &&
    storedDay === dayKey &&
    callsToday > 0 &&
    callsLifetime >= callsToday
  ) {
    callsLifetime -= callsToday;
  }

  return {
    dayKey,
    callsToday,
    callsLifetime,
    metaVersion: META_VERSION,
  };
}

function loadPersisted(): Persisted {
  const dayKey = todayKey();
  if (typeof window === "undefined") {
    return { leads: [], meta: { dayKey, callsToday: 0, callsLifetime: 0, metaVersion: META_VERSION } };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw)
      return { leads: [], meta: { dayKey, callsToday: 0, callsLifetime: 0, metaVersion: META_VERSION } };
    const parsed = JSON.parse(raw) as Persisted;
    return {
      leads: normalizeLeadArray(parsed.leads),
      meta: normalizeMeta(parsed.meta, dayKey),
    };
  } catch {
    return { leads: [], meta: { dayKey, callsToday: 0, callsLifetime: 0, metaVersion: META_VERSION } };
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

function leadMatchesSearch(lead: Lead, raw: string): boolean {
  const q = raw.trim().toLowerCase();
  if (!q) return true;
  if (lead.businessName.toLowerCase().includes(q)) return true;
  const searchDigits = phoneDigits(raw);
  if (searchDigits.length > 0 && phoneDigits(lead.phone).includes(searchDigits)) {
    return true;
  }
  return false;
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
        addedAt: 0,
        callPointAwarded: false,
        starred: false,
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
    addedAt: Date.now(),
    callPointAwarded: false,
    starred: false,
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

/** Newer leads first when priority/tier match; then name. */
function compareLeadTieBreak(a: Lead, b: Lead): number {
  const byTime = b.addedAt - a.addedAt;
  if (byTime !== 0) return byTime;
  return a.businessName.localeCompare(b.businessName);
}

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
    case "Went to Voicemail":
      return "bg-sky-950/80 text-sky-200 ring-1 ring-sky-700/45";
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
  const [meta, setMeta] = useState<TrackerMeta>({
    dayKey: "",
    callsToday: 0,
    callsLifetime: 0,
    metaVersion: META_VERSION,
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Until you expand another lead or collapse, newest “Add business” row stays first in the list. */
  const [pinToTopId, setPinToTopId] = useState<string | null>(null);
  const expandedCardRef = useRef<HTMLElement | null>(null);
  const [sortMode, setSortMode] = useState<"priority" | "tier" | "name" | "starred">(
    "priority"
  );
  const [leadStatusFilter, setLeadStatusFilter] = useState<"all" | LeadStatus>("all");
  const [websiteStatusFilter, setWebsiteStatusFilter] = useState<"all" | WebsiteStatus>(
    "all"
  );
  const [searchQuery, setSearchQuery] = useState("");

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
        setMeta((m) => rollMetaToNewDay(m, dayKey));
      });
      return;
    }
    savePersisted({ leads, meta });
  }, [mounted, leads, meta]);

  useEffect(() => {
    if (pinToTopId === null) return;
    if (expandedId !== pinToTopId) setPinToTopId(null);
  }, [expandedId, pinToTopId]);

  const setLeadField = useCallback(
    (id: string, field: keyof Lead, value: string) => {
      setLeads((prev) => {
        const idx = prev.findIndex((l) => l.id === id);
        if (idx === -1) return prev;
        const current = prev[idx];
        const next: Lead = { ...current, [field]: value } as Lead;

        const shouldAwardCallPoint =
          field === "leadStatus" &&
          value !== "Not Called" &&
          !current.callPointAwarded;
        if (shouldAwardCallPoint) {
          next.callPointAwarded = true;
          const dk = todayKey();
          setMeta((m) => {
            const base = m.dayKey === dk ? m : rollMetaToNewDay(m, dk);
            return {
              ...base,
              callsToday: (base.callsToday ?? 0) + 1,
              metaVersion: META_VERSION,
            };
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
    const notCalledYet = leads.filter((l) => l.leadStatus === "Not Called").length;
    const interested = leads.filter((l) => l.leadStatus === "Interested").length;
    const booked = leads.filter((l) => l.leadStatus === "Booked").length;
    const dayKey = todayKey();
    const callsToday =
      meta.dayKey === dayKey ? meta.callsToday : 0;
    const callsLifetimePrior = meta.callsLifetime ?? 0;
    const totalCallsAllTime = callsLifetimePrior + callsToday;
    const turnoverPct =
      totalCallsAllTime > 0
        ? Math.round((booked / totalCallsAllTime) * 1000) / 10
        : null;
    return {
      total,
      notCalledYet,
      interested,
      booked,
      callsToday,
      callsLifetimePrior,
      totalCallsAllTime,
      turnoverPct,
    };
  }, [leads, meta]);

  const filteredSorted = useMemo(() => {
    const filtered = leads.filter(
      (l) =>
        leadMatchesSearch(l, searchQuery) &&
        (leadStatusFilter === "all" || l.leadStatus === leadStatusFilter) &&
        (websiteStatusFilter === "all" || l.websiteStatus === websiteStatusFilter)
    );
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sortMode === "priority") {
        const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (p !== 0) return p;
        const t = TIER_ORDER[a.recommendedTier] - TIER_ORDER[b.recommendedTier];
        if (t !== 0) return t;
        return compareLeadTieBreak(a, b);
      }
      if (sortMode === "tier") {
        const t = TIER_ORDER[a.recommendedTier] - TIER_ORDER[b.recommendedTier];
        if (t !== 0) return t;
        const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (p !== 0) return p;
        return compareLeadTieBreak(a, b);
      }
      if (sortMode === "starred") {
        if (a.starred !== b.starred) return a.starred ? -1 : 1;
        return compareLeadTieBreak(a, b);
      }
      const byName = a.businessName.localeCompare(b.businessName);
      if (byName !== 0) return byName;
      return b.addedAt - a.addedAt;
    });
    if (pinToTopId) {
      const ix = sorted.findIndex((l) => l.id === pinToTopId);
      if (ix > 0) {
        const [row] = sorted.splice(ix, 1);
        sorted.unshift(row);
      }
    }
    return sorted;
  }, [leads, searchQuery, leadStatusFilter, websiteStatusFilter, sortMode, pinToTopId]);

  const addLead = () => {
    const n = emptyLead();
    setLeads((prev) => [n, ...prev]);
    setExpandedId(n.id);
    setPinToTopId(n.id);
  };

  const deleteLead = useCallback((id: string) => {
    setLeads((prev) => prev.filter((l) => l.id !== id));
    setExpandedId((eid) => (eid === id ? null : eid));
    setPinToTopId((pin) => (pin === id ? null : pin));
  }, []);

  const toggleLeadStar = useCallback((id: string) => {
    setLeads((prev) =>
      prev.map((l) => (l.id === id ? { ...l, starred: !l.starred } : l))
    );
  }, []);

  const listOrderKey = useMemo(
    () => filteredSorted.map((l) => l.id).join("\0"),
    [filteredSorted]
  );

  useLayoutEffect(() => {
    if (!expandedId) return;
    expandedCardRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [expandedId, listOrderKey]);

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

        <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3">
          {[
            { label: "Total leads", value: dashboard.total },
            { label: "Not called yet", value: dashboard.notCalledYet },
            { label: "Calls today", value: dashboard.callsToday },
            {
              label: "Total calls (all time)",
              value: dashboard.totalCallsAllTime,
              sub:
                dashboard.turnoverPct !== null
                  ? `${dashboard.turnoverPct}% turnover`
                  : "—",
              subHint: "Booked ÷ total calls",
            },
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
              {"sub" in card && card.sub !== undefined ? (
                <p
                  className="mt-1 text-sm tabular-nums text-[var(--text-muted)]"
                  title={"subHint" in card ? card.subHint : undefined}
                >
                  {card.sub}
                </p>
              ) : null}
            </div>
          ))}
        </section>

        <section className="mb-6 space-y-4 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-5">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              Search
            </span>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Business name or phone…"
              autoComplete="off"
              className="lead-input w-full max-w-xl"
              spellCheck={false}
            />
          </label>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-6 sm:gap-y-3">
            <label className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
              <span className="shrink-0 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Sort
              </span>
              <select
                className="lead-select max-w-full sm:max-w-[220px]"
                value={sortMode}
                onChange={(e) =>
                  setSortMode(e.target.value as "priority" | "tier" | "name" | "starred")
                }
              >
                <option value="priority">Priority (high first)</option>
                <option value="tier">Recommended tier</option>
                <option value="name">Business name A–Z</option>
                <option value="starred">Starred first</option>
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
              <span className="shrink-0 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Lead status
              </span>
              <select
                className="lead-select max-w-full sm:max-w-[220px]"
                value={leadStatusFilter}
                onChange={(e) => {
                  const v = e.target.value;
                  setLeadStatusFilter(v === "all" ? "all" : (v as LeadStatus));
                }}
              >
                <option value="all">All statuses</option>
                {LEAD_STATUS_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
              <span className="shrink-0 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Website
              </span>
              <select
                className="lead-select max-w-full sm:max-w-[220px]"
                value={websiteStatusFilter}
                onChange={(e) => {
                  const v = e.target.value;
                  setWebsiteStatusFilter(v === "all" ? "all" : (v as WebsiteStatus));
                }}
              >
                <option value="all">All website types</option>
                {WEBSITE_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <div className="space-y-2">
          {filteredSorted.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-card)] px-4 py-12 text-center text-sm text-[var(--text-muted)]">
              No leads match your filters or search. Adjust the search, dropdowns, or add a business.
            </p>
          ) : (
            filteredSorted.map((lead) => (
              <LeadRow
                key={lead.id}
                ref={expandedId === lead.id ? expandedCardRef : undefined}
                lead={lead}
                expanded={expandedId === lead.id}
                onToggle={() =>
                  setExpandedId((id) => (id === lead.id ? null : lead.id))
                }
                onChange={(field, value) => setLeadField(lead.id, field, value)}
                onToggleStar={() => toggleLeadStar(lead.id)}
                onDelete={() => deleteLead(lead.id)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const LeadRow = forwardRef(function LeadRow(
  {
    lead,
    expanded,
    onToggle,
    onChange,
    onToggleStar,
    onDelete,
  }: {
    lead: Lead;
    expanded: boolean;
    onToggle: () => void;
    onChange: (field: keyof Lead, value: string) => void;
    onToggleStar: () => void;
    onDelete: () => void;
  },
  ref: React.Ref<HTMLElement>
) {
  const telHref =
    lead.phone.trim() === ""
      ? undefined
      : `tel:${lead.phone.replace(/[^\d+]/g, "")}`;

  return (
    <article
      ref={ref}
      className={`overflow-hidden rounded-xl border transition-colors ${
        expanded
          ? "border-[var(--gold-dim)] bg-[var(--bg-elevated)] ring-1 ring-[var(--gold)]/20"
          : lead.starred
            ? "border-[var(--gold-dim)] bg-[var(--bg-card)] ring-1 ring-[var(--gold)]/20 hover:border-[#dfc056]"
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
        <button
          type="button"
          aria-label={lead.starred ? "Unstar business" : "Star business"}
          title={lead.starred ? "Unstar business" : "Star business"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar();
          }}
          className={`shrink-0 rounded-full p-1.5 transition ${
            lead.starred
              ? "text-[var(--gold)] hover:bg-[var(--gold-muted)]"
              : "text-[var(--text-muted)] hover:text-[var(--gold)] hover:bg-zinc-800/70"
          }`}
        >
          <Star filled={lead.starred} />
        </button>
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
          <div className="mt-6 flex justify-end border-t border-[var(--border)] pt-4">
            <button
              type="button"
              onClick={() => {
                const label =
                  lead.businessName.trim() || "Untitled business";
                if (
                  window.confirm(
                    `Delete "${label}"? This removes the lead from your tracker and cannot be undone.`
                  )
                ) {
                  onDelete();
                }
              }}
              className="rounded-lg border border-red-800/70 bg-red-950/40 px-4 py-2 text-sm font-medium text-red-200 transition hover:bg-red-950/70 active:scale-[0.98]"
            >
              Delete business
            </button>
          </div>
        </div>
      )}
    </article>
  );
});

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

function Star({ filled }: { filled: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3.75l2.37 4.8 5.3.77-3.84 3.74.91 5.28L12 15.86l-4.74 2.48.91-5.28L4.33 9.32l5.3-.77L12 3.75z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
