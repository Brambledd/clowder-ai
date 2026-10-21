/**
 * Forget route + ForgetService tests.
 *
 * Covers the benchmark-validated pipeline paths:
 *  - facts scope: multi-probe search locates and removes matching entries
 *  - topic scope: store-wide scan
 *  - timerange scope: deterministic date filtering on updatedAt
 *  - fresh-write guard: entries younger than 10 minutes survive
 *  - residual loop: a second search round removes missed variants
 *  - F6 replacement: old deleted, new written
 *  - evidenceScope: threads-only by default; docs require opt-in
 *  - graph-edge + consumption-signal cascade callbacks fire
 *  - validation: missing targets / missing since+until → 400
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { ForgetService, retireSourceFileImpl } from '../dist/domains/memory/forget/ForgetService.js';
import { evidenceForgetRoutes } from '../dist/routes/evidence-forget.js';

function makeItem(anchor, overrides = {}) {
  return {
    anchor,
    kind: 'thread',
    status: 'active',
    title: anchor,
    summary: overrides.summary ?? `summary about ${anchor}`,
    keywords: [],
    updatedAt: overrides.updatedAt ?? new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function makeStore(items) {
  const byAnchor = new Map(items.map((i) => [i.anchor, { ...i }]));
  const searchCalls = [];
  const store = {
    async search(query, _options) {
      searchCalls.push(query);
      const q = query.toLowerCase();
      const hits = [];
      for (const item of byAnchor.values()) {
        const hay = `${item.title} ${item.summary ?? ''} ${(item.keywords ?? []).join(' ')}`.toLowerCase();
        const terms = q.split(/\s+/).filter((t) => t.length > 1);
        if (terms.length > 0 && terms.every((t) => hay.includes(t))) {
          hits.push({ ...item });
        } else if (terms.length > 0 && terms.some((t) => hay.includes(t))) {
          hits.push({ ...item });
        }
      }
      return hits.slice(0, 20);
    },
    async getByAnchor(anchor) {
      return byAnchor.get(anchor) ?? null;
    },
    async deleteByAnchor(anchor) {
      byAnchor.delete(anchor);
    },
    async upsert(items2) {
      for (const item of items2) byAnchor.set(item.anchor, { ...item });
    },
    _byAnchor: byAnchor,
    _searchCalls: searchCalls,
  };
  return store;
}
function makeServices(store) {
  const droppedEdges = [];
  const clearedSignals = [];
  const retiredFiles = [];
  const services = {
    store,
    dropEdgesForAnchors: async (anchors) => {
      droppedEdges.push(anchors);
    },
    clearConsumptionSignals: async (anchors) => {
      clearedSignals.push(anchors);
    },
    retireSourceFile: async (sourcePath) => {
      retiredFiles.push(sourcePath);
    },
    _droppedEdges: droppedEdges,
    _clearedSignals: clearedSignals,
    _retiredFiles: retiredFiles,
  };
  return services;
}

describe('ForgetService — facts scope', () => {
  it('locates by multi-probe search and removes matching entries', async () => {
    const store = makeStore([
      makeItem('t1', { summary: 'favorite color is blue' }),
      makeItem('t2', { summary: 'completely unrelated topic about baking' }),
    ]);
    const svc = new ForgetService(makeServices(store));
    const result = await svc.execute({ scope: 'facts', targets: ['favorite color blue'] });
    assert.ok(result.removed >= 1, `removed ${result.removed}`);
    assert.equal(store._byAnchor.has('t1'), false, 't1 should be deleted');
    assert.equal(store._byAnchor.has('t2'), true, 't2 should survive');
  });

  it('protects fresh writes via the guard', async () => {
    const store = makeStore([
      makeItem('fresh', { summary: 'just learned favorite color green', updatedAt: new Date().toISOString() }),
    ]);
    const svc = new ForgetService(makeServices(store));
    const result = await svc.execute({ scope: 'facts', targets: ['favorite color green'] });
    assert.ok(result.protected >= 1, 'fresh entry should be protected');
    assert.equal(store._byAnchor.has('fresh'), true, 'fresh entry should survive');
  });

  it('residual loop removes entries found on the second pass', async () => {
    let firstPass = true;
    const items = [
      makeItem('r1', { summary: 'old favorite color blue' }),
      makeItem('r2', { summary: 'old favorite color blue variant' }),
    ];
    const base = makeStore(items);
    const search = base.search.bind(base);
    base.search = async (query, options) => {
      const results = await search(query, options);
      // First pass: only r1 is found; after deletion, r2 surfaces as a residual.
      if (firstPass) {
        firstPass = false;
        return results.filter((r) => r.anchor === 'r1');
      }
      return results;
    };
    const svc = new ForgetService(makeServices(base));
    const result = await svc.execute({ scope: 'facts', targets: ['favorite color blue'] });
    assert.ok(result.removed >= 2, `residual loop should catch r2, removed=${result.removed}`);
    assert.equal(result.remaining, 0, 'verification should be clean');
  });
});

describe('ForgetService — timerange scope', () => {
  it('filters deterministically on updatedAt', async () => {
    const store = makeStore([
      makeItem('dec', { summary: 'december event', updatedAt: '2025-12-15T10:00:00Z' }),
      makeItem('jan', { summary: 'january event', updatedAt: '2026-01-10T10:00:00Z' }),
    ]);
    const svc = new ForgetService(makeServices(store));
    const result = await svc.execute({
      scope: 'timerange',
      targets: ['event'],
      since: '2025-12-01',
      until: '2025-12-31',
    });
    assert.equal(store._byAnchor.has('dec'), false, 'December entry removed');
    assert.equal(store._byAnchor.has('jan'), true, 'January entry survives');
  });
});

describe('ForgetService — F6 replacement', () => {
  it('deletes old value and writes the replacement', async () => {
    const store = makeStore([makeItem('old', { summary: 'favorite color blue' })]);
    const svc = new ForgetService(makeServices(store));
    const result = await svc.execute({
      scope: 'facts',
      targets: ['favorite color blue'],
      replacement: 'favorite color is green',
    });
    assert.equal(store._byAnchor.has('old'), false);
    assert.ok(result.replacementWritten);
    const repl = store._byAnchor.get(result.replacementAnchor);
    assert.ok(repl);
    assert.match(repl.summary, /green/);
  });
});

describe('ForgetService — evidenceScope', () => {
  it('threads scope ignores doc-kind entries', async () => {
    const store = makeStore([
      makeItem('msg', { kind: 'thread', summary: 'health blood pressure detail' }),
      makeItem('doc', { kind: 'decision', summary: 'health blood pressure detail', sourcePath: 'docs/x.md' }),
    ]);
    const svc = new ForgetService(makeServices(store));
    await svc.execute({ scope: 'topic', targets: ['health blood pressure'] });
    assert.equal(store._byAnchor.has('msg'), false, 'thread entry removed');
    assert.equal(store._byAnchor.has('doc'), true, 'doc entry survives threads-only scope');
  });

  it('docs scope retires the source file', async () => {
    const store = makeStore([
      makeItem('doc', { kind: 'decision', summary: 'old architecture decision', sourcePath: 'docs/adr.md' }),
    ]);
    const services = makeServices(store);
    const svc = new ForgetService(services);
    await svc.execute({ scope: 'facts', targets: ['architecture decision'], evidenceScope: 'docs' });
    assert.equal(store._byAnchor.has('doc'), false);
    assert.deepEqual(services._retiredFiles, ['docs/adr.md']);
  });
});

describe('ForgetService — cascade cleanup', () => {
  it('fires graph-edge and consumption-signal callbacks for removed anchors', async () => {
    const store = makeStore([makeItem('g1', { summary: 'link target one' })]);
    const services = makeServices(store);
    const svc = new ForgetService(services);
    await svc.execute({ scope: 'facts', targets: ['link target one'] });
    assert.ok(services._droppedEdges.length >= 1);
    const allEdges = services._droppedEdges.flat();
    assert.ok(allEdges.includes('g1'));
    assert.ok(services._clearedSignals.flat().includes('g1'));
  });
});

describe('retireSourceFileImpl — tombstone frontmatter rewrite', () => {
  it('rewrites status to deleted and preserves the rest of the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forget-retire-'));
    try {
      const file = join(dir, 'adr.md');
      await writeFile(
        file,
        '---\ntitle: ADR-001\nstatus: accepted\nkind: decision\n---\n\n# Body\n\ncontent stays.',
        'utf8',
      );
      await retireSourceFileImpl(file);
      const after = await readFile(file, 'utf8');
      assert.match(after, /status:\s*deleted/);
      assert.match(after, /title: ADR-001/);
      assert.match(after, /# Body/);
      assert.doesNotMatch(after, /accepted/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tolerates a leading BOM (PowerShell-created files)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forget-bom-'));
    try {
      const file = join(dir, 'bom.md');
      const content = '---\ntitle: BOM doc\nstatus: active\n---\n\nbody';
      await writeFile(file, `\uFEFF${content}`, 'utf8');
      await retireSourceFileImpl(file);
      const after = await readFile(file, 'utf8');
      assert.match(after, /status:\s*deleted/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds status when frontmatter lacks it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forget-nostatus-'));
    try {
      const file = join(dir, 'plain.md');
      await writeFile(file, '---\ntitle: no status\n---\n\nbody', 'utf8');
      await retireSourceFileImpl(file);
      const after = await readFile(file, 'utf8');
      assert.match(after, /status:\s*deleted/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ForgetService — timerange via listByDateRange (self-sufficient)', () => {
  it('uses the store method when available, no targets needed', async () => {
    const store = makeStore([
      makeItem('dec', { summary: 'december item', updatedAt: '2025-12-15T10:00:00Z' }),
      makeItem('jan', { summary: 'january item', updatedAt: '2026-01-10T10:00:00Z' }),
    ]);
    store.listByDateRange = async (since, until) => {
      const out = [];
      for (const item of store._byAnchor.values()) {
        const iso = item.updatedAt.slice(0, 10);
        if (iso >= since && iso <= until) out.push({ ...item });
      }
      return out;
    };
    const svc = new ForgetService(makeServices(store));
    const result = await svc.execute({ scope: 'timerange', since: '2025-12-01', until: '2025-12-31' });
    assert.equal(result.removed, 1);
    assert.equal(store._byAnchor.has('dec'), false);
    assert.equal(store._byAnchor.has('jan'), true);
  });
});

describe('ForgetService — message-level threads branch', () => {
  function makeMessageServices(passages) {
    const live = new Map(passages.map((p) => [`${p.threadId}/${p.messageId}`, { ...p }]));
    const suppressed = [];
    const base = makeServices(makeStore([]));
    base.searchMessagePassages = async (query, limit = 20) => {
      const out = [];
      for (const p of live.values()) {
        if (p.content.toLowerCase().includes(query.toLowerCase())) out.push({ ...p });
      }
      return out.slice(0, limit);
    };
    base.suppressMessage = async (threadId, messageId) => {
      live.delete(`${threadId}/${messageId}`);
      suppressed.push({ threadId, messageId });
    };
    return { services: base, live, suppressed };
  }

  it('suppresses matching messages (not whole thread docs) and verifies zero remaining', async () => {
    const { services, suppressed } = makeMessageServices([
      {
        threadId: 't1',
        messageId: 'm1',
        content: 'my bank account password is hunter2',
        createdAt: '2025-01-01T00:00:00Z',
      },
      { threadId: 't1', messageId: 'm2', content: 'lets grab lunch tomorrow', createdAt: '2025-01-02T00:00:00Z' },
    ]);
    const svc = new ForgetService(services);
    const result = await svc.execute({ scope: 'facts', targets: ['bank account password'] });
    assert.ok(result.removed >= 1, `removed ${result.removed}`);
    assert.deepEqual(suppressed, [{ threadId: 't1', messageId: 'm1' }], 'exactly the matching message');
    assert.match(result.details[0].anchor, /thread-t1#msg-m1/);
    assert.equal(result.remaining, 0);
  });

  it('fresh-write guard protects messages created within 10 minutes', async () => {
    const { services, suppressed } = makeMessageServices([
      {
        threadId: 't1',
        messageId: 'fresh',
        content: 'just told you my secret code',
        createdAt: new Date().toISOString(),
      },
    ]);
    const svc = new ForgetService(services);
    const result = await svc.execute({ scope: 'facts', targets: ['secret code'] });
    assert.ok(result.protected >= 1, 'fresh message protected');
    assert.equal(suppressed.length, 0, 'nothing suppressed');
    assert.equal(result.removed, 0);
  });

  it('residual loop catches variant-wording messages across probes', async () => {
    const { services } = makeMessageServices([
      { threadId: 't1', messageId: 'm1', content: 'favorite color blue', createdAt: '2025-01-01T00:00:00Z' },
      { threadId: 't1', messageId: 'm2', content: 'favourite colour is blue', createdAt: '2025-01-01T00:00:00Z' },
    ]);
    const svc = new ForgetService(services);
    const result = await svc.execute({ scope: 'facts', targets: ['favorite color blue'] });
    assert.ok(result.removed >= 1);
    assert.equal(result.remaining, 0, 'verification clean after residual loop');
  });

  it('F6 replacement still works on the message branch', async () => {
    const store = makeStore([]);
    const services = makeServices(store);
    services.searchMessagePassages = async () => [{ threadId: 't1', messageId: 'm1', createdAt: null }];
    services.suppressMessage = async () => {};
    const svc = new ForgetService(services);
    const result = await svc.execute({
      scope: 'facts',
      targets: ['x'],
      replacement: 'new value green',
    });
    assert.ok(result.replacementWritten);
    const repl = store._byAnchor.get(result.replacementAnchor);
    assert.ok(repl);
    assert.match(repl.summary, /green/);
  });

  it('docs scope bypasses the message branch (falls through to anchor pipeline)', async () => {
    const store = makeStore([
      makeItem('doc1', { kind: 'decision', summary: 'old decision about vendor', sourcePath: 'd.md' }),
    ]);
    const services = makeServices(store);
    let messageSearchCalled = false;
    services.searchMessagePassages = async () => {
      messageSearchCalled = true;
      return [];
    };
    services.suppressMessage = async () => {};
    const svc = new ForgetService(services);
    await svc.execute({ scope: 'facts', targets: ['vendor decision'], evidenceScope: 'docs' });
    assert.equal(messageSearchCalled, false, 'message path must not run for docs scope');
    assert.equal(store._byAnchor.has('doc1'), false, 'doc removed via anchor pipeline');
  });
});

describe('POST /api/evidence/forget', () => {
  let app;

  beforeEach(() => {
    app = Fastify();
  });

  it('validates: missing targets for facts scope → 400', async () => {
    const svc = new ForgetService(makeServices(makeStore([])));
    await app.register(evidenceForgetRoutes, { forgetService: svc });
    const res = await app.inject({ method: 'POST', url: '/api/evidence/forget', payload: { scope: 'facts' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'validation_failed');
  });

  it('validates: timerange without since/until → 400', async () => {
    const svc = new ForgetService(makeServices(makeStore([])));
    await app.register(evidenceForgetRoutes, { forgetService: svc });
    const res = await app.inject({ method: 'POST', url: '/api/evidence/forget', payload: { scope: 'timerange' } });
    assert.equal(res.statusCode, 400);
  });

  it('executes and returns the summary', async () => {
    const store = makeStore([makeItem('x1', { summary: 'secret bank account detail' })]);
    const svc = new ForgetService(makeServices(store));
    await app.register(evidenceForgetRoutes, { forgetService: svc });
    const res = await app.inject({
      method: 'POST',
      url: '/api/evidence/forget',
      payload: { scope: 'facts', targets: ['secret bank account'] },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.removed >= 1);
    assert.equal(body.remaining, 0);
  });
});
