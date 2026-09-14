import { Body, Controller, ForbiddenException, Get, Header, NotFoundException, Param, Post, Req, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { createReadStream, promises as fs } from 'fs';
import { extname, join } from 'path';
import { AuthUser, CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import {
  CONTENT_TYPE_FOR_EXT,
  MEMORY_UPLOAD_OPTIONS,
  persistValidatedImage,
  receiptUploadDir,
  STORED_UPLOAD_NAME,
  UPLOAD_THROTTLE,
} from '../../upload/upload.util';
import { UploadService } from '../../upload/upload.service';
import { UploadManualPaymentDto } from '../application/dto/payment.dto';
import { PaymentsService } from '../payments.service';
import {
  AdminOrCustomerGuard,
  isAdminWithPaymentRead,
  PaymentOwnerGuard,
  PaymentUploadTokenGuard,
  ReceiptPrincipal,
} from './payment-upload.guards';

/**
 * Receipt image uploads (H3 / L8):
 *   - authentication, token and ownership are guards, so they finish before Multer
 *     reads the body; Multer buffers in memory; nothing is written unless every check
 *     passed AND the bytes are a real image;
 *   - receipts are written to the PRIVATE receipts directory (never served
 *     statically) and returned as an authenticated /payments/receipts/<file> URL.
 */
@ApiTags('payments')
@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly uploads: UploadService,
  ) {}

  @Post(':paymentId/manual-receipt')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  uploadManualReceipt(
    @Param('paymentId') paymentId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UploadManualPaymentDto,
  ) {
    return this.payments.uploadManualReceipt(paymentId, user.sub, dto);
  }

  // Authenticated receipt image upload (login flow). Owner-scoped; returns an
  // application-owned URL that the manual-receipt endpoint will accept.
  @Post(':paymentId/manual-receipt/file')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, PaymentOwnerGuard)
  @Throttle({ default: UPLOAD_THROTTLE })
  @UseInterceptors(FileInterceptor('file', MEMORY_UPLOAD_OPTIONS))
  async uploadReceiptFile(@UploadedFile() file: Express.Multer.File) {
    const filename = await persistValidatedImage(file, receiptUploadDir());
    return { url: this.uploads.getReceiptUrl(filename) };
  }

  // Public, unauthenticated upload-link surface. Access is by single-use token
  // (no login, no paymentId in the URL) so customers can pay without an account.
  @Get('upload/:token')
  getUploadPage(@Param('token') token: string) {
    return this.payments.getUploadPage(token);
  }

  // Anonymous receipt image upload, gated by an active token. Returns an
  // application-owned URL for the subsequent submit call.
  @Post('upload/:token/file')
  @UseGuards(PaymentUploadTokenGuard)
  @Throttle({ default: UPLOAD_THROTTLE })
  @UseInterceptors(FileInterceptor('file', MEMORY_UPLOAD_OPTIONS))
  async uploadTokenReceiptFile(@UploadedFile() file: Express.Multer.File) {
    const filename = await persistValidatedImage(file, receiptUploadDir());
    return { url: this.uploads.getReceiptUrl(filename) };
  }

  /**
   * Private receipt download (L8). An admin needs Payment.read; a customer must own
   * a payment that references this receipt. Anything else - including a well-formed
   * name nobody may see - is a 404, so the endpoint does not confirm a file exists.
   */
  @Get('receipts/:filename')
  @UseGuards(AdminOrCustomerGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async receipt(@Param('filename') filename: string, @Req() req: Request & { user: ReceiptPrincipal }) {
    if (!STORED_UPLOAD_NAME.test(filename)) throw new NotFoundException('Receipt not found');
    const user = req.user;
    const allowed = isAdminWithPaymentRead(user)
      ? true
      : user.kind === 'admin'
        ? false
        : await this.payments.customerOwnsReceipt(filename, user.sub);
    if (!allowed) {
      if (user.kind === 'admin') throw new ForbiddenException('Insufficient permissions');
      throw new NotFoundException('Receipt not found');
    }
    const path = join(receiptUploadDir(), filename);
    try {
      await fs.access(path);
    } catch {
      throw new NotFoundException('Receipt not found');
    }
    return new StreamableFile(createReadStream(path), {
      type: CONTENT_TYPE_FOR_EXT[extname(filename)] ?? 'application/octet-stream',
      disposition: 'inline',
    });
  }

  @Post('upload/:token')
  submitReceipt(@Param('token') token: string, @Body() dto: UploadManualPaymentDto) {
    return this.payments.submitReceiptByToken(token, dto);
  }

  // NOTE: payment verification is admin-only and lives on the admin surface
  // (PATCH /admin/payments/:paymentId/verify), which binds the verifier to the
  // authenticated admin principal.
}
