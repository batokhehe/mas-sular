import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InvoiceService } from './invoice.service';

/**
 * P2 #14: PUBLIC customer invoice (no guard, no login). Access is the capability
 * token in the path; it is redacted from request/exception logs (see
 * common/logging/redact.ts) and never persisted in plaintext.
 */
@ApiTags('invoices')
@Controller({ path: 'invoices', version: '1' })
export class InvoicesController {
  constructor(private readonly invoices: InvoiceService) {}

  @Get(':token')
  // Customer data behind a bearer link: never cache it anywhere on the way.
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  getInvoice(@Param('token') token: string) {
    return this.invoices.getByToken(token);
  }
}
