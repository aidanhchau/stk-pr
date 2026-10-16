/**
 * Pure view model of the stack-merge sheet: what each PR's status honestly is, the plain-English summary of what will
 * happen, and the plan steps with the reason each one is there. The sheet only draws what this returns.
 */
import type { Blocker, MergeMethod, PlanStep, PullRequest } from "./types";

export type PrStateKind = "approved" | "ready" | "needs-review" | "changes" | "failing" | "pending" | "conflict" | "draft" | "other" | "merged";

export interface PrStatus {
  kind: PrStateKind;
  /** `needs review`, `failing checks`, ... (no bypass note). */
  label: string;
  /** Force would bypass it (so it is shown as `will bypass`); false for clean PRs and for conflicts and drafts. */
  bypass: boolean;
  /** Unfixable by force: a conflict or a draft. */
  hard: boolean;
}

/** Worst blocker first: what a reader most needs to know about the PR. */
const RANK: Record<Blocker["kind"], number> = {
  conflict: 0,
  draft: 1,
  checks: 2,
  "required-check": 3,
  checking: 4,
  review: 5,
  threads: 6,
  blocked: 7,
  behind: 8,
  "base-not-trunk": 9,
};

/** The one status a PR row shows. `base-not-trunk` is ignored: in a stack every member lands on the trunk. */
export function prStatus(pr: Pick<PullRequest, "reviewDecision">, blockers: Blocker[], force: boolean): PrStatus {
  const bs = blockers.filter((b) => b.kind !== "base-not-trunk").sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  const top = bs[0];
  if (!top) return pr.reviewDecision === "APPROVED" ? { kind: "approved", label: "approved", bypass: false, hard: false } : { kind: "ready", label: "ready", bypass: false, hard: false };
  const hard = bs.some((b) => b.kind === "conflict" || b.kind === "draft");
  const bypass = force && !hard;
  const more = bs.length > 1 ? ` +${bs.length - 1}` : "";
  const make = (kind: PrStateKind, label: string): PrStatus => ({ kind, label: `${label}${more}`, bypass, hard });
  switch (top.kind) {
    case "conflict":
      return make("conflict", "conflicts");
    case "draft":
      return make("draft", "draft");
    case "checks":
      return top.failing.length > 0 ? make("failing", "failing checks") : make("pending", "checks running");
    case "required-check":
    case "checking":
      return make("pending", top.kind === "checking" ? "checking for conflicts" : "required check missing");
    case "review":
      return top.decision === "CHANGES_REQUESTED" ? make("changes", "changes requested") : make("needs-review", "needs review");
    case "threads":
      return make("other", `${top.count} open thread${top.count === 1 ? "" : "s"}`);
    case "blocked":
      return make("other", "blocked by rules");
    default:
      return make("other", "behind its base");
  }
}

/** What a bypass skips, as a noun: `review`, `failing checks`. */
export function bypassWords(bs: Blocker[]): string {
  const parts: string[] = [];
  for (const b of bs) {
    switch (b.kind) {
      case "checks":
        parts.push(b.failing.length > 0 ? "failing checks" : "pending checks");
        break;
      case "review":
        parts.push(b.decision === "CHANGES_REQUESTED" ? "requested changes" : "review");
        break;
      case "threads":
        parts.push("open threads");
        break;
      case "behind":
        parts.push("being behind");
        break;
      case "checking":
        parts.push("the conflict check");
        break;
      case "required-check":
        parts.push("a required check");
        break;
      case "blocked":
        parts.push("repository rules");
        break;
      default:
        break;
    }
  }
  return [...new Set(parts)].join(" and ");
}

export const list = (nums: number[]): string => {
  const t = nums.map((n) => `#${n}`);
  return t.length <= 2 ? t.join(" and ") : `${t.slice(0, -1).join(", ")} and ${t.at(-1)}`;
};

const METHOD: Record<MergeMethod, { each: string; one: string }> = {
  squash: { each: "squashing each", one: "squashing it" },
  merge: { each: "with a merge commit each", one: "with a merge commit" },
  rebase: { each: "rebasing each", one: "rebasing it" },
};

export interface StackSummaryInput {
  trunk: string;
  method: MergeMethod;
  plan: PlanStep[];
  /** Why the plan stops short of the target, when it does. */
  stop: { pr: number; reason: string } | null;
  /** Open PRs above the merge target; they stay open. */
  above: number[];
}

/** One plain sentence: what lands where, in what order, and what is bypassed. */
export function stackSummary(i: StackSummaryInput): string {
  const merges = i.plan.filter((s): s is Extract<PlanStep, { kind: "merge" }> => s.kind === "merge");
  const stays: string[] = [];
  if (i.stop) stays.push(`#${i.stop.pr} stays open (${i.stop.reason.replace(/^#\d+ (is blocked: )?/, "")})`);
  if (i.above.length > 0) stays.push(`${list(i.above)} ${i.above.length > 1 ? "stay" : "stays"} open`);
  if (merges.length === 0) return `Nothing can merge yet${i.stop ? `: ${i.stop.reason}` : ""}.`;
  const groups = merges.map((m) => m.includes ?? [m.pr]);
  const landed = groups.flat();
  const inGroup = (g: number[]) => (g.length > 1 ? `${list(g)} together` : `#${g[0]}`);
  const order = groups.map(inGroup);
  const head = `Merges ${order[0]} into ${i.trunk}${order.length > 1 ? `, then ${order.slice(1).join(", then ")}` : ""}`;
  const how = landed.length > 1 ? METHOD[i.method].each : METHOD[i.method].one;
  // what each bypassed PR skips; one clause when they all skip the same thing
  const skipped = merges.flatMap((m) => (m.admin ? (m.includes ?? [m.pr]).map((pr) => ({ pr, words: bypassWords(m.bypass) })) : []));
  let bypass = "";
  if (skipped.length > 0) {
    const kinds = [...new Set(skipped.map((s) => s.words))];
    if (kinds.length === 1) {
      const on = skipped.length === landed.length ? (landed.length === 2 ? "both" : landed.length > 2 ? `all ${landed.length}` : list(landed)) : list(skipped.map((s) => s.pr));
      bypass = `; bypasses ${kinds[0] || "its blockers"} on ${on}`;
    } else bypass = `; bypasses ${skipped.map((s) => `${s.words || "blockers"} on #${s.pr}`).join(", ")}`;
  }
  return `${head}, ${how}${bypass}.${stays.length ? ` ${stays.join("; ")}.` : ""}`;
}

export interface PlanItem {
  /** Indices into the plan covered by this line. */
  steps: number[];
  text: string;
  /** Why the step is there, shown under it. */
  why?: string;
}

/**
 * The plan lines. After a bypass merge GitHub neither rebases nor retargets a native stack's next PR (and refuses to let
 * its base be edited while it is stacked), so that merge is followed by a rebase and re-link, listed where it runs:
 * `withExpectedRebases` adds it to a plan that does not carry it yet. After any other merge GitHub restacks by itself.
 */
export function planItems(plan: PlanStep[], trunk: string, method: MergeMethod): PlanItem[] {
  const items: PlanItem[] = [];
  let lastLanded: number | null = null;
  for (let i = 0; i < plan.length; i++) {
    const s = plan[i]!;
    switch (s.kind) {
      case "retarget":
        items.push({ steps: [i], text: `Retarget #${s.pr} from ${s.from} to ${s.to}`, why: `its base branch goes away when #${lastLanded ?? "the PR below"} lands` });
        break;
      case "restack": {
        const next = plan[i + 1];
        const base = { text: `Rebase #${s.pr} onto ${s.onto.replace(/^origin\//, "")}`, why: "drops the commits of the PR below that are already on the trunk" };
        if (next?.kind === "push" && next.branch === s.branch) {
          items.push({ steps: [i, i + 1], ...base, text: `${base.text}, push with lease` });
          i++;
        } else items.push({ steps: [i], ...base });
        break;
      }
      case "push":
        items.push({ steps: [i], text: `Push ${s.branch} with lease` });
        break;
      case "wait-checks":
        items.push({ steps: [i], text: `Wait for #${s.pr} checks to pass`, why: "its checks re-run on the rebased head" });
        break;
      case "rebase-stack":
        items.push({
          steps: [i],
          text: `Rebase #${s.pr} onto ${trunk}${lastLanded === null ? "" : " and everything above it"} and point it at ${trunk} (re-links the stack)`,
          why: `${lastLanded === null ? "GitHub left it on a merged branch" : `after #${lastLanded} lands; a bypass merge leaves it on the merged branch`}; runs in a temporary checkout`,
        });
        break;
      case "merge": {
        const inc = s.includes ?? [s.pr];
        const bypass = s.admin ? bypassWords(s.bypass) : "";
        items.push({
          steps: [i],
          text: `Merge ${inc.length > 1 ? list(inc) : `#${s.pr}`} into ${trunk} (${s.method || method})`,
          ...(bypass ? { why: `bypasses ${bypass}` } : {}),
        });
        lastLanded = s.pr;
        break;
      }
    }
  }
  return items;
}

/** A native plan lists its merges; every merge that follows a bypass merge is preceded by the rebase and re-link it needs. */
export function withExpectedRebases(plan: PlanStep[], native: boolean): PlanStep[] {
  if (!native) return plan;
  const out: PlanStep[] = [];
  let afterBypass = false;
  for (const s of plan) {
    if (s.kind === "merge") {
      if (afterBypass && out.at(-1)?.kind !== "rebase-stack") out.push({ kind: "rebase-stack", pr: (s.includes ?? [s.pr])[0]! });
      afterBypass = s.admin;
    }
    out.push(s);
  }
  return out;
}
