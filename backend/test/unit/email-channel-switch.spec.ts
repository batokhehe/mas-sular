import { BadRequestException } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { EMAIL_CHANNEL_DISABLED_REASON, isEmailChannelEnabled } from '../../src/infrastructure/notifications/email-channel';
import { NotificationProviderFactory } from '../../src/infrastructure/notifications/notification-provider.factory';
import { PermanentSendError } from '../../src/infrastructure/notifications/notification-provider';
import { CustomerCommunicationService } from '../../src/modules/admin/customer-communication.service';

/**
 * EMAIL notification channel switch (email-channel.ts). The delivery gate, the
 * payment consumer, redrive and resend have their own specs; this one covers the
 * flag itself, the provider factory and the manual (admin) send path.
 */

const saved = { email: process.env.NOTIFICATION_EMAIL_ENABLED, provider: process.env.NOTIFICATION_PROVIDER };
afterEach(() => {
  for (const [key, value] of [['NOTIFICATION_EMAIL_ENABLED', saved.email], ['NOTIFICATION_PROVIDER', saved.provider]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('isEmailChannelEnabled', () => {
  it('fails closed: only the exact string "true" enables EMAIL', () => {
    expect(isEmailChannelEnabled({})).toBe(false);
    for (const value of ['', 'false', 'TRUE', 'True', '1', 'yes', ' true']) {
      expect(isEmailChannelEnabled({ NOTIFICATION_EMAIL_ENABLED: value })).toBe(false);
    }
    expect(isEmailChannelEnabled({ NOTIFICATION_EMAIL_ENABLED: 'true' })).toBe(true);
  });
});

describe('NotificationProviderFactory with EMAIL disabled', () => {
  const email = { channel: NotificationChannel.EMAIL, send: jest.fn() };
  const whatsapp = { channel: NotificationChannel.WHATSAPP, send: jest.fn() };
  const factory = () => new NotificationProviderFactory(email as never, whatsapp as never);

  it('multi: WhatsApp still resolves; EMAIL is a permanent refusal', () => {
    delete process.env.NOTIFICATION_EMAIL_ENABLED;
    delete process.env.NOTIFICATION_PROVIDER;
    const f = factory();
    expect(f.get(NotificationChannel.WHATSAPP)).toBe(whatsapp);
    expect(() => f.get(NotificationChannel.EMAIL)).toThrow(PermanentSendError);
    expect(() => f.get(NotificationChannel.EMAIL)).toThrow(EMAIL_CHANNEL_DISABLED_REASON);
  });

  it('NOTIFICATION_PROVIDER=email cannot route other channels to email while it is off', () => {
    delete process.env.NOTIFICATION_EMAIL_ENABLED;
    process.env.NOTIFICATION_PROVIDER = 'email';
    expect(() => factory().get(NotificationChannel.WHATSAPP)).toThrow(PermanentSendError);
  });

  it('enabled: EMAIL resolves to the email provider as before', () => {
    process.env.NOTIFICATION_EMAIL_ENABLED = 'true';
    delete process.env.NOTIFICATION_PROVIDER;
    expect(factory().get(NotificationChannel.EMAIL)).toBe(email);
  });
});

describe('CustomerCommunicationService manual sends with EMAIL disabled', () => {
  const admin = { id: 'admin-1', name: 'Ops' };
  const input = (channel: NotificationChannel, recipient: string) => ({
    channel,
    recipient,
    template: 'manual.custom' as const,
    message: 'Halo',
  });

  function build() {
    const prisma = {
      notificationOutbox: { create: jest.fn().mockResolvedValue({ id: 'ntf-1', status: 'PENDING', createdAt: new Date() }) },
      user: { findUnique: jest.fn() },
    };
    return { service: new CustomerCommunicationService(prisma as never), prisma };
  }

  it('an EMAIL send is refused up front (400) and creates no outbox row', async () => {
    delete process.env.NOTIFICATION_EMAIL_ENABLED;
    const { service, prisma } = build();
    const attempt = service.send(admin, input(NotificationChannel.EMAIL, 'customer@example.test'));
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.send(admin, input(NotificationChannel.EMAIL, 'customer@example.test'))).rejects.toThrow(/EMAIL channel is disabled/);
    expect(prisma.notificationOutbox.create).not.toHaveBeenCalled();
  });

  it('preview reports EMAIL as not ready while it is off', () => {
    delete process.env.NOTIFICATION_EMAIL_ENABLED;
    const { service } = build();
    expect(service.preview({ channel: NotificationChannel.EMAIL, template: 'manual.custom', message: 'Halo' }).channels.EMAIL).toBe(false);
  });

  it('enabled: preview reports EMAIL as ready again (templates are always registered)', () => {
    process.env.NOTIFICATION_EMAIL_ENABLED = 'true';
    const { service } = build();
    expect(service.preview({ channel: NotificationChannel.EMAIL, template: 'manual.custom', message: 'Halo' }).channels.EMAIL).toBe(true);
  });
});
