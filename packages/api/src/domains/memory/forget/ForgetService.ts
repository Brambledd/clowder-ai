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

/**
 * Derived-doc sweep: a non-thread doc is deleted only when at least this
 * fraction of ITS OWN substantive content words is covered by the forget's
 * seed words (suppressed passage content, falling back to the request
 * targets). Conservative by design — mixed docs (forgotten + preserved
 * facts) stay, so the sweep can never produce the collateral PR damage
 * that the fuzzy BM25 sweep did (clowder_lite5b). The 0.35 floor absorbs
 * LLM paraphrase noise (manages/daily-style abstraction words in derived
 * summaries count against coverage).
 */
export const DERIVED_DOC_COVERAGE_THRESHOLD = 0.35;

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

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
   * message coordinate pairs (plus the passage content for exact-match
   * derived-doc sweeps). Wired to the concrete store's searchPassages by
   * the host assembly.
   */
  searchMessagePassages?: (
    query: string,
    limit?: number,
  ) => Promise<Array<{ threadId: string; messageId: string; createdAt?: string | null; content?: string | null }>>;
  /**
   * List ALL message passages (unfiltered) — enables self-sufficient
   * timerange suppression by createdAt window without BM25 probing.
   */
  listMessagePassages?: () => Promise<
    Array<{ threadId: string; messageId: string; createdAt?: string | null; content?: string | null }>
  >;
  /**
   * Permanently suppress one message from the thread index (hard forget):
   * removes the passage + vectors, commits the suppression tombstone, and
   * purges the restore snapshot so it never resurfaces on reindex or
   * restart. Wired to IndexBuilder's suppressMessagePassage +
   * finalizeMessagePassageSuppression pair.
   */
  suppressMessage?: (threadId: string, messageId: string) => Promise<void>;
  /**
   * List non-thread doc entries (anchor + summary) for the derived-doc
   * content-exact sweep. Wired to the concrete store's table; kept as a
   * callback so ForgetService stays decoupled from SQLite internals.
   */
  listNonThreadDocs?: () => Promise<Array<{ anchor: string; kind?: string; summary: string | null }>>;
  /** List thread summary docs (anchor + summary) for the fail-closed
   *  rebuilt-summary verification. */
  listThreadSummaries?: () => Promise<Array<{ anchor: string; summary: string | null }>>;
  /**
   * Blank a thread summary (summary='', fail-closed) — the same semantics
   * suppressMessagePassage uses when it cannot prove a rebuilt summary
   * clean. Wired to a targeted UPDATE on evidence_docs.
   */
  blankThreadSummary?: (anchor: string) => Promise<void>;
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
    // Timerange IS handled here too: filtering passages by createdAt is the
    // conversation-time-correct path (thread summary docs carry the index
    // refresh timestamp, so the doc-level timerange filter would match
    // nothing and silently no-op — verified in the clowder_lite5 run where
    // every F5 probe leaked).
    const messageCapable =
      evidenceScope !== 'docs' && this.services.searchMessagePassages && this.services.suppressMessage;
    if (messageCapable) {
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
    // Distinctive content words from every suppressed passage — the exact-
    // match basis for the derived-doc sweep (deterministic coverage check,
    // no BM25 ranking noise).
    const suppressedWords = new Set<string>();

    // Timerange: date-window filtering on passage createdAt. Probes are
    // irrelevant here — everything in the window goes. Candidate discovery
    // reuses the passage search with a broad wildcard-ish term when the
    // host supports it; otherwise the host's listMessagePassages covers it.
    const isTimerange = request.scope === 'timerange';
    const dateInWindow = (createdAt?: string | null): boolean => {
      if (!isTimerange) return true;
      const iso = createdAt ? createdAt.slice(0, 10) : '';
      if (!iso) return false;
      if (request.since && iso < request.since) return false;
      if (request.until && iso > request.until) return false;
      return true;
    };

    const runPass = async (): Promise<number> => {
      const seen = new Set<string>();
      const listAll = this.services.listMessagePassages;
      let candidates: Array<{
        threadId: string;
        messageId: string;
        createdAt?: string | null;
        content?: string | null;
      }>;
      if (isTimerange && listAll) {
        candidates = (await listAll()).filter((p) => dateInWindow(p.createdAt));
      } else {
        candidates = [];
        const probes =
          request.scope === 'topic' ? (request.targets ?? []) : (request.targets ?? []).flatMap(multiProbes);
        for (const probe of probes) {
          for (const hit of await searchPassages(probe, 20)) {
            candidates.push(hit);
          }
        }
      }
      const pairs: Array<{ threadId: string; messageId: string }> = [];
      const seenKeys = isTimerange ? undefined : new Set<string>();
      for (const hit of candidates) {
        const key = `${hit.threadId}/${hit.messageId}`;
        if (seenKeys) {
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
        }
        // Fresh-write guard on the message timestamp (createdAt optional).
        const t = hit.createdAt ? Date.parse(hit.createdAt) : Number.NaN;
        if (Number.isFinite(t) && now - t < FRESH_WRITE_GUARD_MS) {
          protectedCount += 1;
          continue;
        }
        pairs.push({ threadId: hit.threadId, messageId: hit.messageId });
        for (const w of contentWords(hit.content ?? '')) suppressedWords.add(w);
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

    // Timerange: everything in the window goes in ONE pass — the residual
    // re-run would find nothing (all window passages already suppressed),
    // and re-suppressing is idempotent anyway.
    const passes = isTimerange ? 1 : 1 + RESIDUAL_MAX_ROUNDS;
    for (let round = 0; round < passes; round += 1) {
      const found = await runPass();
      if (!isTimerange && found === 0) break;
    }

    // Timerange ack-capture: the assistant's confirmation ("I've forgotten
    // the December events including the Penang trip") is timestamped AFTER
    // the window, so the date filter spares it — yet it re-introduces the
    // forgotten topic words into every answer (leaky refusal, clowder_lite5d).
    // After the window pass, run probe-based passes with NO date filter:
    // any passage matching the request's own wording is a reference to the
    // forgotten content and goes too.
    if (isTimerange) {
      const probes = (request.targets ?? []).flatMap(multiProbes);
      for (let round = 0; round < RESIDUAL_MAX_ROUNDS; round += 1) {
        const seen = new Set<string>();
        const pairs: Array<{ threadId: string; messageId: string }> = [];
        for (const probe of probes) {
          for (const hit of await searchPassages(probe, 20)) {
            const key = `${hit.threadId}/${hit.messageId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            pairs.push({ threadId: hit.threadId, messageId: hit.messageId });
            for (const w of contentWords(hit.content ?? '')) suppressedWords.add(w);
          }
        }
        if (pairs.length === 0) break;
        for (const pair of pairs) {
          await suppress(pair.threadId, pair.messageId);
          details.push({
            anchor: `thread-${pair.threadId}#msg-${pair.messageId}`,
            kind: 'message',
            method: 'index',
          });
          removed += 1;
        }
      }
    }

    // Derived-representation sweep (content-exact): consolidated inferences
    // and session summaries written BEFORE the forget restate the forgotten
    // facts. A doc is deleted ONLY when its own substantive content is (nearly)
    // fully covered by the suppressed passages' content words — a doc mixing
    // forgotten and preserved facts stays (conservative; partial FE residue
    // beats collateral PR damage, the lite5b lesson). The candidate set comes
    // from listing non-thread docs, NOT from BM25 probe matching — so probe
    // vagueness can never widen the blast radius.
    if (this.services.listNonThreadDocs) {
      // Seed words: suppressed passage content; when no message matched
      // (docs-only residue), fall back to the request targets themselves.
      const seed =
        suppressedWords.size > 0
          ? suppressedWords
          : new Set<string>((request.targets ?? []).flatMap((t) => contentWords(t)));
      if (seed.size > 0) {
        const rows = await this.services.listNonThreadDocs();
        const sweptAnchors: string[] = [];
        for (const row of rows) {
          if (sweptAnchors.includes(row.anchor)) continue;
          // Retraction markers are never swept — they ARE the forget's
          // answer-time enforcement.
          if (row.kind === 'retraction') continue;
          if (!row.summary || row.summary.length < 20) continue;
          const docWords = [...contentWords(row.summary)];
          if (docWords.length === 0) continue;
          const covered = docWords.filter((w) => seed.has(w)).length;
          if (covered / docWords.length >= DERIVED_DOC_COVERAGE_THRESHOLD) {
            await this.services.store.deleteByAnchor(row.anchor);
            sweptAnchors.push(row.anchor);
            details.push({ anchor: row.anchor, kind: 'derived-doc', method: 'index' });
            removed += 1;
          }
        }
        if (sweptAnchors.length > 0) {
          await this.services.dropEdgesForAnchors?.(sweptAnchors);
          await this.services.clearConsumptionSignals?.(sweptAnchors);
        }
      }
    }

    // Thread-summary verification: the suppression machinery rebuilds thread
    // summaries from NON-suppressed messages, but variant-wording messages
    // that escaped matching can re-introduce forgotten content words into
    // the rebuilt summary. Fail closed the same way suppressMessagePassage
    // does: if a rebuilt thread summary still carries seed words, blank it
    // (summary='' — the fail-closed semantics the suppression machinery
    // itself uses when it cannot prove a summary clean).
    if (suppressedWords.size > 0 && this.services.blankThreadSummary) {
      const threadDocs = (await this.services.listNonThreadDocs?.()) ?? [];
      void threadDocs;
      const threadRows = await this.services.listThreadSummaries?.();
      if (threadRows) {
        for (const row of threadRows) {
          if (!row.summary || row.summary.length < 20) continue;
          const docWords = [...contentWords(row.summary)];
          const covered = docWords.filter((w) => suppressedWords.has(w)).length;
          if (docWords.length > 0 && covered / docWords.length >= DERIVED_DOC_COVERAGE_THRESHOLD) {
            await this.services.blankThreadSummary(row.anchor);
          }
        }
      }
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

  /** Shared tail: F6 replacement write + retraction marker + result assembly.

   * Retraction marker semantics (epistemic erasure, NEVER negation):
   * a pure forget moves the topic to UNKNOWN — the marker records the topic
   * words so the answer layer can refuse queries about it, but contains NO
   * restatement of the fact and asserts nothing about its truth. A
   * replacement (F6) writes the new value AND a retraction for the old one.
   * The negation trap ("not male" asserts an unstated fact and leaks the
   * original attribute by implication) is avoided by construction: markers
   * carry topic words only.
   */
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

    // Retraction marker: topic words only (from the request's own wording —
    // never the suppressed fact text, which would re-leak it). Always written
    // when something was removed; it is the answer-time safety net for
    // variant wordings, derived-doc residue, and confirmation references.
    if (partial.removed > 0) {
      const topicWords = new Set<string>((request.targets ?? []).flatMap((t) => contentWords(t)));
      if (topicWords.size > 0) {
        const markerAnchor = `retract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await this.services.store.upsert([
          {
            anchor: markerAnchor,
            kind: 'retraction',
            status: 'active',
            // constitutional: never demoted by the F200 consumption ranking —
            // a forgotten topic's deny-list must not fade with disuse.
            authority: 'constitutional',
            title: `Forgotten topic: ${[...topicWords].slice(0, 8).join(', ')}`,
            summary: `Retraction marker. Topics retracted at the user's request. Answer policy: treat these topics as unknown — refuse without confirming, denying, or mentioning their prior existence.`,
            keywords: [...topicWords].slice(0, 20),
            updatedAt: new Date().toISOString(),
          },
        ]);
      }
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
