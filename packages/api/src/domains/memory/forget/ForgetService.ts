/**
 * ForgetService — targeted unlearning for the Clowder AI evidence store.
 *
 * Ported from Bramble memory plugin (@brambledd/bramble-memory 0.2.0), where
 * the deletion pipeline was validated on the Bemula memory-unlearning
 * benchmark (score 0.469, FE 0.714 / AR 0.615 — highest among all published
 * systems). Adapted to Clowder's dual-scope evidence model (docs = project
 * knowledge, threads = conversation messages) and its graph relations.
 *
 * Pipeline (all stages benchmark-validated):
 *  1. scope routing   — facts (multi-probe retrieval) / topic (store scan) /
 *                       timerange (deterministic date filter on updatedAt)
 *  2. fresh guard     — entries written in the last 10 minutes (relearning
 *                       values, replacements) are never deletion candidates
 *  3. deletion        — deleteByAnchor per entry + file frontmatter rewrite
 *                       for docs (status: retired, file preserved for audit)
 *  4. residual loop   — re-probe with the original targets; anything still
 *                       matching is a missed variant and gets removed (≤2 rounds)
 *  5. replacement     — optional F6 semantics: after forgetting the old
 *                       value, write the new one
 *
 * Clowder-specific:
 *  - evidenceScope: 'threads' (default, conversation memory) | 'docs'
 *    (project knowledge, opt-in because deleting ADRs/feature specs is
 *    destructive) | 'all'
 *  - graph edge cleanup: edges pointing at deleted anchors are dropped via
 *    the caller-supplied edge cleaner
 *  - consumption signals: F200 ledger rows for deleted anchors are cleared
 */

import { readFile, writeFile } from 'node:fs/promises';
import type { EvidenceItem, IEvidenceStore, SearchOptions } from '../interfaces.js';

/**
 * Rewrite a doc's frontmatter status to deleted — the file is preserved for
 * audit/recovery, but the scanner skips status:deleted files so a full
 * library rebuild never resurrects forgotten knowledge. Tolerates a leading
 * BOM (PowerShell-created files carry one; the naive /^---/ anchor then
 * fails silently, which the Bramble port hit in production).
 */
export async function retireSourceFileImpl(sourcePath: string): Promise<void> {
  const raw = await readFile(sourcePath, 'utf8');
  const content = raw.replace(/^\uFEFF/, '');
  const updated = content.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_match, fm: string) =>
    /^status:\s*/m.test(fm)
      ? `---\n${fm.replace(/^status:\s*.*$/m, 'status: deleted')}\n---`
      : `---\n${fm}\nstatus: deleted\n---`,
  );
  if (updated !== content) {
    await writeFile(sourcePath, updated, 'utf8');
  }
}

/** Fresh-write guard window. Entries younger than this are protected. */
export const FRESH_WRITE_GUARD_MS = 10 * 60 * 1000;

/** Maximum residual-verification rounds after the initial deletion. */
export const RESIDUAL_MAX_ROUNDS = 2;

export type ForgetScope = 'facts' | 'topic' | 'timerange';
export type EvidenceScope = 'threads' | 'docs' | 'all';

export interface ForgetRequest {
  scope: ForgetScope;
  /** Search phrases describing what to forget (facts/topic). */
  targets?: string[];
  /** ISO date lower bound, YYYY-MM-DD (timerange). */
  since?: string;
  /** ISO date upper bound, YYYY-MM-DD (timerange). */
  until?: string;
  /** New value to write after forgetting the old one (F6 replacement). */
  replacement?: string;
  /** Which evidence scope to forget. Defaults to 'threads' (safer). */
  evidenceScope?: EvidenceScope;
}

export interface ForgetResult {
  removed: number;
  protected: number;
  remaining: number;
  replacementWritten: boolean;
  replacementAnchor: string | null;
  details: Array<{ anchor: string; kind: string; method: 'index' | 'file' | 'both' }>;
}

/** Callbacks the host wires up for Clowder-specific cleanup. */
export interface ForgetHostServices {
  store: IEvidenceStore;
  /** Drop graph edges whose target/source anchor was deleted. */
  dropEdgesForAnchors?: (anchors: string[]) => Promise<void>;
  /** Clear F200 consumption-ledger rows for deleted anchors. */
  clearConsumptionSignals?: (anchors: string[]) => Promise<void>;
  /** Rewrite a file-sourced doc's frontmatter to deleted (soft tombstone). */
  retireSourceFile?: (sourcePath: string) => Promise<void>;
  /**
   * Message-level passage search for the threads scope. Returns thread/
   * message coordinate pairs whose content matches the query. Wired to the
   * concrete store's searchPassages by the host assembly.
   */
  searchMessagePassages?: (
    query: string,
    limit?: number,
  ) => Promise<Array<{ threadId: string; messageId: string; createdAt?: string | null }>>;
  /**
   * Permanently suppress one message from the thread index (hard forget):
   * removes the passage + vectors, commits the suppression tombstone, and
   * purges the restore snapshot so it never resurfaces on reindex or
   * restart. Wired to IndexBuilder's suppressMessagePassage +
   * finalizeMessagePassageSuppression pair.
   */
  suppressMessage?: (threadId: string, messageId: string) => Promise<void>;
}

const THREAD_KINDS = new Set(['thread', 'session', 'discussion', 'diary']);
const DOC_KINDS = new Set(['feature', 'decision', 'plan', 'lesson', 'research', 'architecture', 'pack-knowledge']);

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'my',
  'me',
  'i',
  'you',
  'your',
  'that',
  'this',
  'of',
  'to',
  'for',
  'and',
  'or',
  'is',
  'are',
  'was',
  'were',
  'in',
  'on',
  'about',
  'from',
  'with',
  'please',
  'kindly',
  'just',
  'now',
  'also',
  'fact',
  'facts',
  'information',
  'memory',
  'record',
  'records',
]);

function isFreshWrite(item: EvidenceItem, now: number): boolean {
  const t = Date.parse(item.updatedAt);
  if (!Number.isFinite(t)) return false;
  return now - t < FRESH_WRITE_GUARD_MS;
}

function matchesEvidenceScope(item: EvidenceItem, scope: EvidenceScope): boolean {
  if (scope === 'all') return true;
  const isThread = THREAD_KINDS.has(item.kind);
  return scope === 'threads' ? isThread : !isThread;
}

function multiProbes(target: string): string[] {
  const probes = [target];
  const words = target.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()));
  if (words.length >= 2) probes.push(words.slice(0, 2).join(' '));
  if (words.length > 2) probes.push(words.slice(-2).join(' '));
  return probes;
}

function searchOptions(evidenceScope: EvidenceScope): SearchOptions {
  // The store's search has no direct kind filter; we post-filter by kind via
  // matchesEvidenceScope, so search broadly and filter in memory.
  return { limit: 20 };
}

export class ForgetService {
  private readonly services: ForgetHostServices;

  constructor(services: ForgetHostServices) {
    this.services = services;
  }

  async execute(request: ForgetRequest): Promise<ForgetResult> {
    const now = Date.now();
    const evidenceScope = request.evidenceScope ?? 'threads';

    // Message-level branch: when the host wired the suppression callbacks and
    // this request targets threads, forgetting happens per MESSAGE (passage),
    // not per thread doc — deleting a whole thread doc would be both too
    // coarse and resurrectable, while the suppression tombstone is permanent.
    const messageCapable =
      evidenceScope !== 'docs' && this.services.searchMessagePassages && this.services.suppressMessage;
    if (messageCapable && request.scope !== 'timerange') {
      return this.executeMessageLevel(request, now);
    }

    const candidates = await this.locate(request, evidenceScope);
    const removable = candidates.filter((c) => !isFreshWrite(c, now));
    const protectedCount = candidates.length - removable.length;

    const details: ForgetResult['details'] = [];
    const removedAnchors: string[] = [];
    for (const entry of removable) {
      const detail = await this.removeOne(entry);
      details.push(detail);
      removedAnchors.push(entry.anchor);
    }

    // Clowder-specific cascade cleanup
    if (removedAnchors.length > 0) {
      await this.services.dropEdgesForAnchors?.(removedAnchors);
      await this.services.clearConsumptionSignals?.(removedAnchors);
    }

    // Residual verification loop
    let residualRemoved = 0;
    for (let round = 0; round < RESIDUAL_MAX_ROUNDS; round += 1) {
      const residuals = (await this.locate(request, evidenceScope)).filter((c) => !isFreshWrite(c, now));
      if (residuals.length === 0) break;
      for (const entry of residuals) {
        const detail = await this.removeOne(entry);
        details.push(detail);
        removedAnchors.push(entry.anchor);
        residualRemoved += 1;
      }
      await this.services.dropEdgesForAnchors?.(residuals.map((r) => r.anchor));
      await this.services.clearConsumptionSignals?.(residuals.map((r) => r.anchor));
    }

    // F6 replacement + result assembly shared with the message-level branch.
    const remaining = (await this.locate(request, evidenceScope)).length;
    return this.finishWithReplacement(request, {
      removed: removable.length + residualRemoved,
      protected: protectedCount,
      remaining,
      details,
    });
  }

  /**
   * Message-level threads forget. Locates matching passages via the host's
   * passage search, applies the fresh-write guard on message createdAt, then
   * permanently suppresses each (threadId, messageId) pair — the existing
   * suppression machinery removes passage + vectors, commits the tombstone,
   * purges the restore snapshot, and rebuilds the thread summary without the
   * forgotten messages. Residual loop re-searches passages to verify zero.
   */
  private async executeMessageLevel(request: ForgetRequest, now: number): Promise<ForgetResult> {
    const searchPassages = this.services.searchMessagePassages!;
    const suppress = this.services.suppressMessage!;
    const details: ForgetResult['details'] = [];
    let removed = 0;
    let protectedCount = 0;

    const runPass = async (): Promise<number> => {
      const seen = new Set<string>();
      const probes = request.scope === 'topic' ? (request.targets ?? []) : (request.targets ?? []).flatMap(multiProbes);
      const pairs: Array<{ threadId: string; messageId: string }> = [];
      for (const probe of probes) {
        const hits = await searchPassages(probe, 20);
        for (const hit of hits) {
          const key = `${hit.threadId}/${hit.messageId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // Fresh-write guard on the message timestamp (createdAt optional).
          const t = hit.createdAt ? Date.parse(hit.createdAt) : Number.NaN;
          if (Number.isFinite(t) && now - t < FRESH_WRITE_GUARD_MS) {
            protectedCount += 1;
            continue;
          }
          pairs.push({ threadId: hit.threadId, messageId: hit.messageId });
        }
      }
      for (const pair of pairs) {
        await suppress(pair.threadId, pair.messageId);
        details.push({
          anchor: `thread-${pair.threadId}#msg-${pair.messageId}`,
          kind: 'message',
          method: 'index',
        });
        removed += 1;
      }
      return pairs.length;
    };

    await runPass();
    for (let round = 0; round < RESIDUAL_MAX_ROUNDS; round += 1) {
      const found = await runPass();
      if (found === 0) break;
    }

    // Remaining check: any passage still matching?
    let remaining = 0;
    for (const probe of request.targets ?? []) {
      remaining += (await searchPassages(probe, 20)).length;
    }

    return await this.finishWithReplacement(request, {
      removed,
      protected: protectedCount,
      remaining,
      details,
    });
  }

  /** Shared tail: optional F6 replacement write + result assembly. */
  private async finishWithReplacement(
    request: ForgetRequest,
    partial: { removed: number; protected: number; remaining: number; details: ForgetResult['details'] },
  ): Promise<ForgetResult> {
    let replacementWritten = false;
    let replacementAnchor: string | null = null;
    if (typeof request.replacement === 'string' && request.replacement.trim().length > 0) {
      replacementAnchor = `forget-repl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const keywords = request.replacement
        .trim()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1)
        .slice(0, 20);
      await this.services.store.upsert([
        {
          anchor: replacementAnchor,
          kind: 'session',
          status: 'active',
          title: request.replacement.trim().slice(0, 120),
          summary: request.replacement.trim(),
          keywords,
          updatedAt: new Date().toISOString(),
        },
      ]);
      replacementWritten = true;
    }
    return {
      removed: partial.removed,
      protected: partial.protected,
      remaining: partial.remaining,
      replacementWritten,
      replacementAnchor,
      details: partial.details,
    };
  }

  private async locate(request: ForgetRequest, evidenceScope: EvidenceScope): Promise<EvidenceItem[]> {
    const { store } = this.services;
    const seen = new Set<string>();
    const results: EvidenceItem[] = [];

    if (request.scope === 'timerange') {
      // Deterministic date filtering on updatedAt. Preferred path: the
      // store's listByDateRange (self-sufficient); fallback: caller-fed
      // targets (list_recent output) when the store lacks the method.
      const { since, until } = request;
      if (!since && !until) return [];
      const from = since ?? until ?? '';
      const to = until ?? since ?? '';
      if (typeof store.listByDateRange === 'function') {
        const items = await store.listByDateRange(from, to);
        for (const item of items) {
          if (seen.has(item.anchor)) continue;
          if (!matchesEvidenceScope(item, evidenceScope)) continue;
          seen.add(item.anchor);
          results.push(item);
        }
        return results;
      }
      for (const target of request.targets ?? []) {
        const items = await store.search(target, searchOptions(evidenceScope));
        for (const item of items) {
          if (seen.has(item.anchor)) continue;
          if (!matchesEvidenceScope(item, evidenceScope)) continue;
          const iso = item.updatedAt.slice(0, 10);
          if (since && iso < since) continue;
          if (until && iso > until) continue;
          seen.add(item.anchor);
          results.push(item);
        }
      }
      return results;
    }

    const probes: string[] = [];
    for (const target of request.targets ?? []) {
      probes.push(...(request.scope === 'facts' ? multiProbes(target) : [target]));
    }
    for (const probe of probes) {
      const items = await store.search(probe, searchOptions(evidenceScope));
      for (const item of items) {
        if (seen.has(item.anchor)) continue;
        if (!matchesEvidenceScope(item, evidenceScope)) continue;
        seen.add(item.anchor);
        results.push(item);
      }
    }
    return results;
  }

  private async removeOne(entry: EvidenceItem): Promise<ForgetResult['details'][number]> {
    let method: 'index' | 'file' | 'both' = 'index';
    if (entry.sourcePath && DOC_KINDS.has(entry.kind)) {
      try {
        await this.services.retireSourceFile?.(entry.sourcePath);
        method = 'file';
      } catch {
        // File rewrite is best-effort; index removal still proceeds.
      }
    }
    await this.services.store.deleteByAnchor(entry.anchor);
    if (method === 'file') method = 'both';
    return { anchor: entry.anchor, kind: entry.kind, method };
  }
}
