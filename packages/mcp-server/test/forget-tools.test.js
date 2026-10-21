/**
 * cat_cafe_forget_evidence MCP tool tests.
 *
 * Verifies: input validation surface, API wiring (mock fetch), result
 * formatting, error paths, and the governance contract (write action,
 * full-only runtime profile — readonly modes must not expose it).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMemoryTools } from '../dist/server-toolsets.js';
import { forgetTools, handleForgetEvidence } from '../dist/tools/forget-tools.js';

function mockFetch(statusCode, body) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status: statusCode,
      headers: { 'content-type': 'application/json' },
    });
  return () => {
    globalThis.fetch = original;
  };
}

describe('cat_cafe_forget_evidence — handler', () => {
  it('formats a successful result', async () => {
    const restore = mockFetch(200, {
      removed: 2,
      protected: 1,
      remaining: 0,
      replacementWritten: false,
      replacementAnchor: null,
      details: [
        { anchor: 'a1', kind: 'thread', method: 'index' },
        { anchor: 'a2', kind: 'thread', method: 'both' },
      ],
    });
    try {
      const result = await handleForgetEvidence({ scope: 'facts', targets: ['test query'] });
      assert.ok(!result.isError, `should not error: ${JSON.stringify(result).slice(0, 200)}`);
      const text = result.content[0].text;
      assert.match(text, /Forgotten 2 entries/);
      assert.match(text, /1 recent write/);
      assert.match(text, /Verification clean/);
      assert.match(text, /a1/);
    } finally {
      restore();
    }
  });

  it('surfaces API failures as tool errors', async () => {
    const restore = mockFetch(500, { error: 'forget_execution_failed' });
    try {
      const result = await handleForgetEvidence({ scope: 'facts', targets: ['x'] });
      assert.ok(result.isError);
      assert.match(result.content[0].text, /500/);
    } finally {
      restore();
    }
  });

  it('reports network failures gracefully', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    try {
      const result = await handleForgetEvidence({ scope: 'topic', targets: ['x'] });
      assert.ok(result.isError);
      assert.match(result.content[0].text, /cannot reach the memory API/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('cat_cafe_forget_evidence — governance', () => {
  it('is registered with action=write and full-only profiles', () => {
    const tool = forgetTools[0];
    assert.equal(tool.name, 'cat_cafe_forget_evidence');
    assert.equal(tool.operation.action, 'write');
    assert.deepEqual(tool.policy.runtimeProfiles, ['full']);
  });

  it('is EXCLUDED from readonly memory toolset', () => {
    const readonlyTools = buildMemoryTools({ readonly: true });
    const names = readonlyTools.map((t) => t.name);
    assert.equal(names.includes('cat_cafe_forget_evidence'), false, 'forget must not appear in readonly mode');
    assert.equal(names.includes('cat_cafe_search_evidence'), true, 'search stays in readonly');
  });

  it('IS included in the full memory toolset', () => {
    const fullTools = buildMemoryTools({ readonly: false });
    const names = fullTools.map((t) => t.name);
    assert.equal(names.includes('cat_cafe_forget_evidence'), true);
  });

  it('mentions the 8-tool family in its cross-reference footer', async () => {
    const restore = mockFetch(200, {
      removed: 0,
      protected: 0,
      remaining: 0,
      replacementWritten: false,
      replacementAnchor: null,
      details: [],
    });
    try {
      const result = await handleForgetEvidence({ scope: 'facts', targets: ['x'] });
      const text = result.content[0].text;
      assert.match(text, /8-tool memory family/);
      assert.match(text, /forget_evidence \(this tool\)/);
    } finally {
      restore();
    }
  });
});
