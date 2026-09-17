import { Module } from '@nestjs/common';
import { GatewayStatusApplier } from './gateway-status-applier.service';
import { MIDTRANS_RECONCILIATION_CONFIG, loadMidtransReconciliationConfig } from './midtrans-reconciliation.config';
import { MidtransReconciliationWorker } from './midtrans-reconciliation.worker';
import { PaymentSettlementModule } from '../settlement/payment-settlement.module';
import { PaymentAccountsModule } from '../../payment-accounts/payment-accounts.module';
import { ManualTransferProvider } from './infrastructure/providers/manual-transfer.provider';
import { MidtransPaymentProvider } from './infrastructure/providers/midtrans-payment.provider';
import { MIDTRANS_CONFIG, MidtransConfig, assertMidtransConfigured, loadMidtransConfig } from './midtrans.config';
import { PAYMENT_CHANNEL_AVAILABILITY_CONFIG, PaymentChannelRegistry } from './payment-channel.registry';
import { loadPaymentChannelAvailability } from './domain/payment-channel-settings';
import { PaymentGatewayPersistenceService } from './payment-gateway-persistence.service';
import { PaymentAttemptPricingService } from './payment-attempt-pricing.service';
import { PaymentInitiationService } from './payment-initiation.service';
import { PAYMENT_PROVIDERS, PaymentProviderFactory } from './payment-provider.factory';
import { PaymentChannelsController } from './presentation/payment-channels.controller';
import { PaymentWebhookController } from './presentation/payment-webhook.controller';
import { PaymentWebhookService } from './payment-webhook.service';
import { loadPaymentServiceFeeConfig, PAYMENT_SERVICE_FEE_CONFIG } from './payment-service-fee.config';

/**
 * Payment gateway module (Phases 1-3): provider abstraction, channel catalog,
 * gateway ledger, and the Midtrans integration.
 *
 * Still purely additive — nothing existing imports it, no endpoint calls
 * initiate(), and Midtrans registers only behind MIDTRANS_ENABLED. Webhooks and
 * checkout wiring are later phases. PrismaService comes from @Global DatabaseModule.
 */
@Module({
  imports: [PaymentAccountsModule, PaymentSettlementModule], // manual bank account + the shared settlement path
  controllers: [PaymentChannelsController, PaymentWebhookController],
  providers: [
    {
      // Load once and fail fast when the gateway is enabled without credentials
      // (same contract as SHIPPING_CONFIG's assertShippingConfigured).
      provide: MIDTRANS_CONFIG,
      useFactory: () => {
        const config = loadMidtransConfig();
        assertMidtransConfigured(config);
        return config;
      },
    },
    ManualTransferProvider,
    MidtransPaymentProvider,
    // === Payment provider registry ===
    // Add a gateway (Midtrans, Xendit, DOKU, Tripay, …) by implementing
    // PaymentProvider and appending it to this list. Nothing downstream changes.
    {
      provide: PAYMENT_PROVIDERS,
      // Midtrans joins the registry ONLY when MIDTRANS_ENABLED=true. With the
      // flag off it is absent from the factory, so every gateway channel stays
      // unavailable and the catalog resolves to manual transfer alone.
      useFactory: (manual: ManualTransferProvider, midtrans: MidtransPaymentProvider, config: MidtransConfig) =>
        config.enabled ? [manual, midtrans] : [manual],
      inject: [ManualTransferProvider, MidtransPaymentProvider, MIDTRANS_CONFIG],
    },
    PaymentProviderFactory,
    PaymentChannelRegistry,
    PaymentGatewayPersistenceService,
    // Prices gateway attempts (Payment/Order amount + fee). Initiation only — never the webhook.
    PaymentAttemptPricingService,
    PaymentInitiationService,
    PaymentWebhookService,
    // === Phase 5E ===
    // The ONE place a verified provider status becomes a business transition.
    GatewayStatusApplier,
    { provide: MIDTRANS_RECONCILIATION_CONFIG, useFactory: () => loadMidtransReconciliationConfig() },
    MidtransReconciliationWorker,
    // Who bears the payment service fee. Independent of MIDTRANS_CONFIG on purpose.
    { provide: PAYMENT_SERVICE_FEE_CONFIG, useFactory: () => loadPaymentServiceFeeConfig() },
    // Which channels a customer may choose for a NEW payment (PAYMENT_<channel>_ENABLED).
    { provide: PAYMENT_CHANNEL_AVAILABILITY_CONFIG, useFactory: () => loadPaymentChannelAvailability() },
  ],
  exports: [
    PaymentInitiationService,
    PaymentChannelRegistry,
    PaymentProviderFactory,
    PaymentGatewayPersistenceService,
    PAYMENT_SERVICE_FEE_CONFIG,
  ],
})
export class PaymentGatewayModule {}
