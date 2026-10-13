import { ShipmentStatus as S } from '@prisma/client';
import { decideShipmentTransition } from '../../src/modules/shipment/domain/shipment-transition';

/**
 * The ONE shipment transition rule for courier observations - used by both tracking
 * pollers, the JNE webhook and the shared transition step. Pollers pass no event time;
 * the JNE webhook passes JNE's own (verbatim, sortable) dates.
 */
const decide = (current: S, target: S | undefined, eventTime: string | null = null, lastAppliedEventTime: string | null = null) =>
  decideShipmentTransition({ current, target, eventTime, lastAppliedEventTime });

describe('shared shipment transition rule', () => {
  it.each([
    [S.CREATED, S.WAITING_PICKUP],
    [S.CREATED, S.PICKED_UP],
    [S.WAITING_PICKUP, S.PICKED_UP],
    [S.PICKED_UP, S.IN_TRANSIT],
    [S.IN_TRANSIT, S.OUT_FOR_DELIVERY],
    [S.OUT_FOR_DELIVERY, S.DELIVERED],
    [S.CREATED, S.DELIVERED], // skipping intermediate steps is still forward
  ])('forward progress applies: %s → %s', (current, target) => {
    expect(decide(current, target)).toEqual({ apply: true });
  });

  it.each([
    [S.IN_TRANSIT, S.PICKED_UP],
    [S.OUT_FOR_DELIVERY, S.IN_TRANSIT],
    [S.PICKED_UP, S.CREATED],
    [S.WAITING_PICKUP, S.CREATED],
  ])('a stale/backwards observation never applies: %s → %s', (current, target) => {
    expect(decide(current, target)).toEqual({ apply: false, reason: 'would_regress' });
  });

  it.each([
    [S.DELIVERED, S.IN_TRANSIT],
    [S.DELIVERED, S.PICKED_UP],
    [S.DELIVERED, S.FAILED],
    [S.FAILED, S.PICKED_UP],
    [S.FAILED, S.DELIVERED],
    [S.CANCELLED, S.IN_TRANSIT],
  ])('terminal states never change: %s → %s', (current, target) => {
    expect(decide(current, target)).toEqual({ apply: false, reason: 'terminal' });
  });

  it('FAILED and CANCELLED interrupt any non-terminal state (existing poller behaviour, e.g. Paxel CCS)', () => {
    for (const current of [S.CREATED, S.WAITING_PICKUP, S.PICKED_UP, S.IN_TRANSIT, S.OUT_FOR_DELIVERY]) {
      expect(decide(current, S.FAILED)).toEqual({ apply: true });
      expect(decide(current, S.CANCELLED)).toEqual({ apply: true });
    }
  });

  it('unchanged and unmapped observations never transition', () => {
    expect(decide(S.IN_TRANSIT, S.IN_TRANSIT)).toEqual({ apply: false, reason: 'unchanged' });
    expect(decide(S.IN_TRANSIT, undefined)).toEqual({ apply: false, reason: 'unmapped_status' });
    expect(decide(S.IN_TRANSIT, S.UNKNOWN)).toEqual({ apply: false, reason: 'unmapped_status' });
  });

  describe('with event times (JNE webhook: verbatim YYYY-MM-DD HH:MM:SS, compared only with each other)', () => {
    it('an observation older than the one that last moved the shipment never applies', () => {
      expect(decide(S.IN_TRANSIT, S.FAILED, '2026-09-12 08:00:00', '2026-09-12 12:00:00')).toEqual({ apply: false, reason: 'stale' });
      expect(decide(S.PICKED_UP, S.DELIVERED, '2026-09-12 08:00:00', '2026-09-12 12:00:00')).toEqual({ apply: false, reason: 'stale' });
    });

    it('a newer (or equal-time) observation follows the lifecycle rules', () => {
      expect(decide(S.IN_TRANSIT, S.FAILED, '2026-09-12 13:00:00', '2026-09-12 12:00:00')).toEqual({ apply: true });
      expect(decide(S.PICKED_UP, S.IN_TRANSIT, '2026-09-12 12:00:00', '2026-09-12 12:00:00')).toEqual({ apply: true });
      expect(decide(S.IN_TRANSIT, S.PICKED_UP, '2026-09-13 09:00:00', '2026-09-12 12:00:00')).toEqual({ apply: false, reason: 'would_regress' });
    });

    it('an undated interruption after a dated move cannot be shown to be newer', () => {
      expect(decide(S.IN_TRANSIT, S.FAILED, null, '2026-09-12 12:00:00')).toEqual({ apply: false, reason: 'undated_failure' });
    });
  });
});
