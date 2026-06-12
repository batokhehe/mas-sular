import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { OutboxModule } from '../outbox/outbox.module';
import { CONSUMERS_CONFIG, loadConsumersConfig } from './consumers.config';
import { OrderCreatedNotificationConsumer } from './order-created-notification.consumer';

@Module({
  imports: [OutboxModule, NotificationsModule], // RabbitConnectionManager + NotificationMetrics
  providers: [
    { provide: CONSUMERS_CONFIG, useFactory: () => loadConsumersConfig() },
    OrderCreatedNotificationConsumer,
  ],
})
export class ConsumersModule {}
