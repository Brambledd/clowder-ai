/**
 * Forget Evidence Tool — targeted unlearning for the memory family.
 *
 * MCP wrapper for POST /api/evidence/forget. First WRITE operation in the
 * memory family (existing 7 tools are all read): physically removes
 * evidence entries from the store (search can no longer find them), runs
 * a residual verification loop, optionally writes an F6 replacement, and
 * cascades graph-edge / consumption-signal cleanup.
 *
 * Default evidenceScope is 'threads' (conversation memory). Forgetting
 * 'docs' (project knowledge: ADRs, feature specs, architecture maps) is
 * opt-in and should be confirmed with the user first — deleting shared
 * team knowledge is destructive.
 *
 * Ported from Bramble memory plugin (@brambledd/bramble-memory 0.2.0,
 * Bemula-validated deletion pipeline).
 */

import { z } from 'zod';
import { defineMcpMigrationFactory } from '../tool-governance-migration.js';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('forget-tools.ts', undefined, {
  resourceFamily: 'evidence-navigation',
  authority: 'local-runtime',
});

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';

export const forgetEvidenceInputSchema = {
  scope: z
    .enum(['facts', 'topic', 'timerange'])
    .describe(
      'facts = forget specific facts (use targets). topic = forget a whole topic/category (use targets with topic keywords). timerange = forget everything in a time window (use since/until).',
    ),
  evidenceScope: z
    .enum(['threads', 'docs', 'all'])
    .optional()
    .describe(
      'Which memory to forget. threads = conversation messages (default, safer). docs = project knowledge — DESTRUCTIVE to shared team context, confirm with the user first. all = both.',
    ),
  targets: z
    .array(z.string().min(1))
    .max(12)
    .optional()
    .describe(
      'Search phrases describing what to forget. For facts: specific fact descriptions. For topics: topic keywords. Required for facts/topic scopes.',
    ),
  since: z.string().optional().describe('ISO date lower bound (YYYY-MM-DD) for timerange scope.'),
  until: z.string().optional().describe('ISO date upper bound (YYYY-MM-DD) for timerange scope.'),
  replacement: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'New value to remember after forgetting the old one (replacement semantics, e.g. "my new favorite color is green"). Optional.',
    ),
};

interface ForgetResponse {
  removed: number;
  protected: number;
  remaining: number;
  replacementWritten: boolean;
  replacementAnchor: string | null;
  details: Array<{ anchor: string; kind: string; method: 'index' | 'file' | 'both' }>;
}

export async function handleForgetEvidence(input: {
  scope: 'facts' | 'topic' | 'timerange';
  evidenceScope?: 'threads' | 'docs' | 'all' | undefined;
  targets?: readonly string[] | undefined;
  since?: string | undefined;
  until?: string | undefined;
  replacement?: string | undefined;
}): Promise<ToolResult> {
  const body: Record<string, unknown> = { scope: input.scope };
  if (input.evidenceScope) body.evidenceScope = input.evidenceScope;
  if (input.targets && input.targets.length > 0) body.targets = [...input.targets];
  if (input.since) body.since = input.since;
  if (input.until) body.until = input.until;
  if (input.replacement) body.replacement = input.replacement;

  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/evidence/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return errorResult(
      `forget failed: cannot reach the memory API (${error instanceof Error ? error.message : 'unknown error'})`,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return errorResult(`forget failed: API returned ${response.status}${text ? ` — ${text.slice(0, 300)}` : ''}`);
  }
  const data = (await response.json()) as ForgetResponse;
  return successResult(formatForgetResult(data));
}

function formatForgetResult(data: ForgetResponse): string {
  const lines: string[] = [];
  lines.push(`Forgotten ${data.removed} entr${data.removed === 1 ? 'y' : 'ies'}.`);
  if (data.protected > 0) {
    lines.push(`${data.protected} recent write${data.protected === 1 ? '' : 's'} protected by the fresh-write guard.`);
  }
  if (data.remaining > 0) {
    lines.push(
      `WARNING: ${data.remaining} matching entr${data.remaining === 1 ? 'y still remains' : 'ies still remain'} — search with the same terms to inspect.`,
    );
  } else {
    lines.push('Verification clean: no matching entries remain.');
  }
  if (data.replacementWritten && data.replacementAnchor) {
    lines.push(`Replacement written: ${data.replacementAnchor}`);
  }
  if (data.details.length > 0) {
    lines.push('');
    lines.push('Removed entries:');
    for (const d of data.details.slice(0, 20)) {
      lines.push(`  ${d.anchor} (${d.kind}, ${d.method})`);
    }
    if (data.details.length > 20) {
      lines.push(`  … +${data.details.length - 20} more`);
    }
  }
  lines.push('');
  lines.push(crossReferenceFooter());
  return lines.join('\n');
}

function crossReferenceFooter(): string {
  return [
    '— Clowder AI 8-tool memory family —',
    '  search_evidence: semantic / fuzzy find',
    '  graph_resolve: precise anchor / relations',
    '  list_recent: zero-prior / scan recent',
    '  list_session_chain / read_session_digest / read_session_events / read_invocation_detail: drill into history',
    '  forget_evidence (this tool): targeted unlearning',
  ].join('\n');
}

export const forgetTools = [
  defineTool({
    name: 'cat_cafe_forget_evidence',
    description: [
      'Forget (physically delete) specific memories from the evidence store. First WRITE tool in the memory family — all others are read-only.',
      'Use when: the user asks to forget/delete/remove information from memory ("忘掉 / 删除 / 别再记得"), or asks to replace an old value with a new one (pass replacement).',
      'Pipeline (benchmark-validated): multi-probe search locates candidates → fresh-write guard protects entries written in the last 10 minutes → physical deletion (search can no longer find them) → residual verification re-probes and removes missed variants → optional replacement write.',
      'evidenceScope: threads (default) = conversation memory — safe to forget. docs = project knowledge (ADRs, feature specs) — DESTRUCTIVE to shared team context; confirm with the user before calling with docs. all = both.',
      'SCOPE GUIDE: single fact → scope=facts + targets=["descriptive phrase"]. Whole topic → scope=topic + targets=["topic keywords"]. Time window → scope=timerange + since/until. Value replacement → scope=facts + targets=[old value] + replacement="new value".',
      'NOT for: browsing or searching memory (use search_evidence / list_recent); graph navigation (use graph_resolve).',
      'After forgetting, a follow-up search with the same terms should return nothing — verify when the stakes are high.',
    ].join('\n'),
    inputSchema: forgetEvidenceInputSchema,
    handler: handleForgetEvidence,
    governance: {
      implementationExport: 'handleForgetEvidence',
      action: 'write',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
] as const;
