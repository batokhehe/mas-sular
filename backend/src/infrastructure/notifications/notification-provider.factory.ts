import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { EMAIL_CHANNEL_DISABLED_REASON, isEmailChannelEnabled } from './email-channel';
import { EmailNotificationProvider } from './email-notification.provider';
import { NotificationProvider, PermanentSendError } from './notification-provider';
import { QontakWhatsAppProvider } from './qontak-whatsapp.provider';

type ProviderMode = 'multi' | 'email' | 'qontak';

/**
 * Channel → provider registry. EmailProvider is retained as a peer (never replaced).
 * NOTIFICATION_PROVIDER:
 *   multi  → route strictly by NotificationChannel (default, extensible)
 *   email  → force EmailProvider for all channels (legacy/rollback)
 *   qontak → force WhatsApp for all channels (migration/testing)
 * Adding Push/SMS later = implement NotificationProvider + register here; no worker change.
 */
@Injectable()
export class NotificationProviderFactory {
  private readonly providers = new Map<string, NotificationProvider>();
  private readonly mode: ProviderMode;
  private readonly emailEnabled: boolean;

  constructor(email: EmailNotificationProvider, whatsapp: QontakWhatsAppProvider) {
    this.providers.set(email.channel, email);
    this.providers.set(whatsapp.channel, whatsapp);
    const raw = process.env.NOTIFICATION_PROVIDER;
    this.mode = raw === 'email' || raw === 'qontak' ? raw : 'multi';
    this.emailEnabled = isEmailChannelEnabled();
  }

  get(channel: NotificationChannel): NotificationProvider {
    if (this.mode === 'email') return this.require(NotificationChannel.EMAIL);
    if (this.mode === 'qontak') return this.require(NotificationChannel.WHATSAPP);
    return this.require(channel);
  }

  private require(channel: NotificationChannel): NotificationProvider {
    // The delivery gate already refuses EMAIL rows; this also covers
    // NOTIFICATION_PROVIDER=email, which would route OTHER channels to email.
    if (channel === NotificationChannel.EMAIL && !this.emailEnabled) {
      throw new PermanentSendError(EMAIL_CHANNEL_DISABLED_REASON);
    }
    const provider = this.providers.get(channel);
    if (!provider) throw new PermanentSendError(`No provider registered for channel ${channel}`);
    return provider;
  }
}
