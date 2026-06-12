export interface NotificationSendInput {
  channel: string;
  recipient: string;
  subject: string;
  body: string;
  /** NotificationOutbox.id — passed to the provider as its idempotency key. */
  idempotencyKey: string;
}

export interface NotificationSendResult {
  providerMessageId: string;
}

/** Do NOT retry — bad recipient/template/channel (provider 4xx-class). */
export class PermanentSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSendError';
  }
}

/** Retry with backoff — network/provider 5xx/timeout/rate-limit. */
export class TransientSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientSendError';
  }
}

export interface NotificationProvider {
  readonly channel: string;
  send(input: NotificationSendInput): Promise<NotificationSendResult>;
}
