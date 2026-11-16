import { describe, it, expect } from 'vitest';
import { flowBarStack } from './tagged-flow-stack';

describe('flowBarStack', () => {
  it('leaves every bar in its own rounded column when not stacked', () => {
    for (const role of ['base', 'tagged'] as const) {
      const props = flowBarStack(false, 'income', role);
      expect(props).toEqual({ radius: [4, 4, 0, 0] });
      expect(props).not.toHaveProperty('stackId');
    }
  });

  it('shares the stack id and rounds only the top of the stack when stacked', () => {
    expect(flowBarStack(true, 'income', 'base')).toEqual({ stackId: 'income', radius: [0, 0, 0, 0] });
    expect(flowBarStack(true, 'income', 'tagged')).toEqual({ stackId: 'income', radius: [4, 4, 0, 0] });
  });
});
