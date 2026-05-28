import { Injectable, Logger } from '@nestjs/common';
import amqp from 'amqplib';
import { DomainEvent } from './domain-event';

@Injectable()
export class EventBus {
  private readonly logger = new Logger(EventBus.name);

  async publish(exchange: string, routingKey: string, event: DomainEvent): Promise<void> {
    const url = process.env.RABBITMQ_URL;
    if (!url) {
      this.logger.warn(`RabbitMQ disabled, skipped ${event.name}`);
      return;
    }
    const connection = await amqp.connect(url);
    const channel = await connection.createChannel();
    await channel.assertExchange(exchange, 'topic', { durable: true });
    channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(event)), {
      contentType: 'application/json',
      persistent: true,
    });
    await channel.close();
    await connection.close();
  }
}
