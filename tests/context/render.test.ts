// Fleet: the render half split out of ContextBuilder draws the same timeline
// from rows a caller already holds (the server feeds it Postgres rows).
import { describe, expect, it } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { renderContext } from '../../src/services/context/render.js';
import type { ContextConfig, Observation, SessionSummary } from '../../src/services/context/types.js';

const config: ContextConfig = {
  totalObservationCount: 50,
  fullObservationCount: 5,
  sessionCount: 10,
  showReadTokens: true,
  showWorkTokens: true,
  showSavingsAmount: true,
  showSavingsPercent: true,
  observationTypes: new Set(['discovery', 'decision']),
  observationConcepts: new Set(['what-changed']),
  fullObservationField: 'narrative',
  showLastSummary: true,
  showLastMessage: false,
};

describe('renderContext', () => {
  ModeManager.getInstance().loadMode('code');

  it('renders the empty state for no rows', () => {
    const out = renderContext(config, [], [], 'proj', false);
    expect(out.text).toContain('# [proj] recent context');
    expect(out.text).toContain('No previous sessions found.');
    expect(out.stats).toBeNull();
  });

  it('renders a timeline with stats for rows', () => {
    const obs: Observation = {
      id: 1, memory_session_id: 's1', type: 'discovery', title: 'Found it', subtitle: null,
      narrative: 'narrative', facts: '["f"]', concepts: '["what-changed"]', files_read: null,
      files_modified: null, discovery_tokens: null, created_at: new Date().toISOString(),
      created_at_epoch: Date.now(), project: 'proj',
    };
    const summary: SessionSummary = {
      id: 1, memory_session_id: 's1', request: 'req', investigated: 'i', learned: 'l',
      completed: 'c', next_steps: 'n', created_at: new Date().toISOString(),
      created_at_epoch: Date.now() + 1, project: 'proj',
    };
    const out = renderContext(config, [obs], [summary], 'proj', false);
    expect(out.text).toContain('# [proj] recent context');
    expect(out.text).toContain('Found it');
    expect(out.stats?.observation_count).toBe(1);
    expect(out.stats?.has_session_summary).toBe(true);
    expect(renderContext(config, [obs], [summary], 'proj', true).text).toContain('\x1b[');
  });
});
