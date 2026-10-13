import { Module } from '@nestjs/common';
import { InvoiceService } from './invoice.service';
import { InvoiceTokenService } from './invoice-token.service';
import { InvoicesController } from './invoices.controller';

@Module({
  controllers: [InvoicesController],
  providers: [InvoiceTokenService, InvoiceService],
  exports: [InvoiceTokenService],
})
export class InvoicesModule {}
