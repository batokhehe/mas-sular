import { loadNotificationSenderConfig } from '../../src/infrastructure/notifications/notification.config';
import { TemplateRenderer } from '../../src/infrastructure/notifications/template-renderer';
import { PermanentSendError } from '../../src/infrastructure/notifications/notification-provider';
import { EmailNotificationProvider } from '../../src/infrastructure/notifications/email-notification.provider';

describe('loadNotificationSenderConfig', () => {
  it('defaults enabled to false with sane defaults', () => {
    const cfg = loadNotificationSenderConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxAttempts).toBe(8);
    expect(cfg.breakerThreshold).toBe(5);
  });

  it('parses overrides', () => {
    const cfg = loadNotificationSenderConfig({ NOTIFICATION_SENDER_ENABLED: 'true', NOTIFICATION_SENDER_MAX_ATTEMPTS: '3' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxAttempts).toBe(3);
  });
});

describe('TemplateRenderer', () => {
  const renderer = new TemplateRenderer();

  it('renders order.received', () => {
    const out = renderer.render('order.received', { orderNumber: 'BN-1', customerName: 'Jane', totalPrice: 30000 });
    expect(out.subject).toContain('BN-1');
    expect(out.body).toContain('Jane');
  });

  it('throws PermanentSendError for an unknown template', () => {
    expect(() => renderer.render('nope', {})).toThrow(PermanentSendError);
  });
});

describe('EmailNotificationProvider (stub)', () => {
  it('returns a provider id derived from the idempotency key', async () => {
    const result = await new EmailNotificationProvider().send({
      channel: 'EMAIL',
      recipient: 'a@b.com',
      subject: 'S',
      body: 'B',
      idempotencyKey: 'n1',
    });
    expect(result.providerMessageId).toBe('stub-n1');
  });
});
