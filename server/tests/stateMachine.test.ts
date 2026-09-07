import { describe, it, expect } from 'vitest';
import { canTransitionOrder, assertOrderTransition, canTransitionDelivery } from '../src/engine/stateMachine.js';

describe('state machine', () => {
  it('allows the happy-path order lifecycle', () => {
    expect(canTransitionOrder('created', 'ready')).toBe(true);
    expect(canTransitionOrder('ready', 'validated')).toBe(true);
    expect(canTransitionOrder('validated', 'dispatching')).toBe(true);
    expect(canTransitionOrder('dispatching', 'assigned')).toBe(true);
    expect(canTransitionOrder('assigned', 'picked_up')).toBe(true);
    expect(canTransitionOrder('picked_up', 'delivered')).toBe(true);
  });

  it('rejects skipping states and resurrecting terminal states', () => {
    expect(canTransitionOrder('created', 'assigned')).toBe(false);
    expect(canTransitionOrder('delivered', 'dispatching')).toBe(false);
    expect(canTransitionOrder('cancelled', 'ready')).toBe(false);
    expect(() => assertOrderTransition('delivered', 'assigned')).toThrow(/transition/);
  });

  it('permits reassignment loops (assigned -> dispatching -> assigned)', () => {
    expect(canTransitionOrder('assigned', 'dispatching')).toBe(true);
    expect(canTransitionDelivery('failed', 'assigned')).toBe(true);
    expect(canTransitionDelivery('delivered', 'assigned')).toBe(false);
  });
});
