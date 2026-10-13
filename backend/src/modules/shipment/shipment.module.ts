import { Module } from '@nestjs/common';
import { SHIPPING_CONFIG, assertJneEnvironment, loadShippingConfig } from '../shipping/shipping.config';
import { JneShipmentProvider } from './infrastructure/providers/jne-shipment.provider';
import { JneDestinationResolver } from '../shipping/infrastructure/jne-destination.resolver';
import { JneOriginBootValidator } from './jne-origin-boot.validator';
import { PaxelShipmentProvider } from './infrastructure/providers/paxel-shipment.provider';
import { PaxelPickupScheduler } from './paxel-pickup-scheduler';
import { ShipmentAdminController } from './presentation/shipment-admin.controller';
import { JneWebhookController } from './presentation/jne-webhook.controller';
import { JNE_WEBHOOK_CONFIG, loadJneWebhookConfig } from './jne-webhook.config';
import { JneWebhookService } from './jne-webhook.service';
import { PaxelWebhookController } from './presentation/paxel-webhook.controller';
import { PAXEL_WEBHOOK_CONFIG, loadPaxelWebhookConfig } from './paxel-webhook.config';
import { PaxelWebhookService } from './paxel-webhook.service';
import { SHIPMENT_PROVIDERS, ShipmentProviderFactory } from './shipment-provider.factory';
import { SHIPMENT_TRACKING_CONFIG, loadShipmentTrackingConfig } from './shipment-tracking.config';
import { ShipmentTrackingWorker } from './shipment-tracking.worker';
import { SHIPMENT_RECONCILIATION_CONFIG, loadShipmentReconciliationConfig } from './shipment-reconciliation.config';
import { ShipmentReconciliationMetrics } from './shipment-reconciliation.metrics';
import { ShipmentReconciliationWorker } from './shipment-reconciliation.worker';
import { ShipmentService } from './shipment.service';
import { ShipmentStatusMapper } from './shipment-status.mapper';
import { ShipmentSyncService } from './shipment-sync.service';

@Module({
  controllers: [ShipmentAdminController, JneWebhookController, PaxelWebhookController],
  providers: [
    // Provider credentials (same env as quotation; env.validation asserts at boot).
    //
    // This module builds SHIPPING_CONFIG itself rather than importing ShippingModule,
    // so assertShippingConfigured() never ran here - and THIS is the module that owns
    // JNE tracking and cancel, the two paths that actually spend jne.baseUrl. The
    // environment guard is applied explicitly so that bypass cannot exist
    // (PAXELBOX-61K). Paxel's credential checks stay with ShippingModule.
    {
      provide: SHIPPING_CONFIG,
      useFactory: () => {
        const config = loadShippingConfig();
        assertJneEnvironment(config.jne);
        return config;
      },
    },
    PaxelShipmentProvider,
    // The verified district -> JNE destination mapping (quote side's resolver; it
    // needs only the global PrismaService). JNE booking resolves DESTINATION_CODE
    // with it and never falls back to a postal code.
    JneDestinationResolver,
    JneShipmentProvider,
    // Checks JNE_ORIGIN_CODE against JNE's own ORIGIN master at bootstrap -
    // the check that would have caught BDO10056 (PAXELBOX-61P).
    JneOriginBootValidator,
    // === Fulfillment courier registry ===
    // Add a courier by implementing ShipmentProvider and appending it here.
    {
      provide: SHIPMENT_PROVIDERS,
      useFactory: (paxel: PaxelShipmentProvider, jne: JneShipmentProvider) => [paxel, jne],
      inject: [PaxelShipmentProvider, JneShipmentProvider],
    },
    ShipmentProviderFactory,
    // Decides the automatic Paxel pickup appointment (PAXELBOX-61AG.3.32). A
    // separate provider from PaxelShipmentProvider on purpose: the resolver
    // determines the appointment, the provider only sends it.
    PaxelPickupScheduler,
    ShipmentService,
    ShipmentStatusMapper,
    ShipmentSyncService,
    { provide: SHIPMENT_TRACKING_CONFIG, useFactory: () => loadShipmentTrackingConfig() },
    ShipmentTrackingWorker,
    // C2: recover paid orders whose shipment was never booked (crash-after-verify).
    ShipmentReconciliationMetrics,
    { provide: SHIPMENT_RECONCILIATION_CONFIG, useFactory: () => loadShipmentReconciliationConfig() },
    ShipmentReconciliationWorker,
    // JNE Webhook Status V2 (inbound pushes). Off unless JNE_WEBHOOK_ENABLED=true.
    { provide: JNE_WEBHOOK_CONFIG, useFactory: () => loadJneWebhookConfig() },
    JneWebhookService,
    // Paxel webhook (inbound pushes). Off unless PAXEL_WEBHOOK_ENABLED=true;
    // independent of PAXEL_ENABLED.
    { provide: PAXEL_WEBHOOK_CONFIG, useFactory: () => loadPaxelWebhookConfig() },
    PaxelWebhookService,
  ],
  exports: [ShipmentService, ShipmentSyncService, ShipmentStatusMapper],
})
export class ShipmentModule {}
