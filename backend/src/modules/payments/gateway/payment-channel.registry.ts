import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  PAYMENT_CHANNELS,
  PaymentChannelCode,
  PaymentChannelDescriptor,
  PublicPaymentChannel,
  toPublicChannel,
} from './domain/payment-channel';
import { PaymentProvider } from './domain/payment-provider.interface';
import { PaymentProviderFactory } from './payment-provider.factory';

/**
 * The channel catalog and the channel → provider binding.
 *
 * A channel is AVAILABLE only when it is statically enabled AND its provider is
 * registered in this build AND that provider declares support for it. That triple
 * gate is why Phase 1 is inert: no gateway provider exists yet, so only manual
 * transfer can ever be returned — exactly today's customer-visible behavior.
 *
 * What a CUSTOMER is offered (listPublic) additionally requires the provider to be
 * READY (P0-3): manual transfer needs an active bank account, otherwise the order
 * could be placed but never paid.
 */
@Injectable()
export class PaymentChannelRegistry {
  private readonly logger = new Logger(PaymentChannelRegistry.name);

  constructor(private readonly providers: PaymentProviderFactory) {}

  /** Every catalog entry, including unavailable ones (diagnostics / admin). */
  list(): PaymentChannelDescriptor[] {
    return [...PAYMENT_CHANNELS];
  }

  /** Catalog entries a customer may actually choose right now. */
  listAvailable(): PaymentChannelDescriptor[] {
    return PAYMENT_CHANNELS.filter((channel) => this.isAvailable(channel));
  }

  /**
   * Customer-facing projection of the channels that are available AND ready right
   * now — provider names stripped. One channel failing its readiness check never
   * hides the others (gateway channels keep showing when manual transfer is not).
   */
  async listPublic(): Promise<PublicPaymentChannel[]> {
    const available = this.listAvailable();
    const ready = await Promise.all(available.map((channel) => this.isReady(channel)));
    return available.filter((_, i) => ready[i]).map(toPublicChannel);
  }

  /**
   * Available (static gate) AND the provider's runtime precondition holds. Fails
   * CLOSED: if the readiness check itself errors, the channel is not offered -
   * a customer must never be shown an option that cannot be completed.
   */
  async isReady(channel: PaymentChannelDescriptor): Promise<boolean> {
    if (!this.isAvailable(channel)) return false;
    const provider = this.providers.get(channel.provider)!;
    if (!provider.isReady) return true;
    try {
      return await provider.isReady(channel.code);
    } catch (error) {
      this.logger.warn(`Readiness check failed for channel ${channel.code}; not offering it: ${(error as Error).message}`);
      return false;
    }
  }

  find(code: string): PaymentChannelDescriptor | undefined {
    return PAYMENT_CHANNELS.find((channel) => channel.code === code);
  }

  isAvailable(channel: PaymentChannelDescriptor): boolean {
    if (!channel.enabled) return false;
    const provider = this.providers.get(channel.provider);
    return Boolean(provider?.supportedChannels().includes(channel.code));
  }

  /**
   * Resolve a channel code to its descriptor + live provider. Throws 404 for an
   * unknown or unavailable channel so a client can never drive an unwired gateway.
   */
  resolve(code: string): { channel: PaymentChannelDescriptor; provider: PaymentProvider } {
    const channel = this.find(code);
    if (!channel || !this.isAvailable(channel)) {
      throw new NotFoundException(`Payment channel '${code}' is not available`);
    }
    // isAvailable() already proved the provider is registered.
    return { channel, provider: this.providers.get(channel.provider)! };
  }

  /** Convenience for callers holding a typed code. */
  resolveCode(code: PaymentChannelCode) {
    return this.resolve(code);
  }
}
