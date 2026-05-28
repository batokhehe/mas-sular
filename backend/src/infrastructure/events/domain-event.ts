export interface DomainEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  name: string;
  occurredAt: Date;
  payload: TPayload;
}
