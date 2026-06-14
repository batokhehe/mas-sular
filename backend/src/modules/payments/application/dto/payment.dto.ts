import { IsOptional, IsString } from 'class-validator';

export class UploadManualPaymentDto {
  @IsString()
  receiptUrl!: string;

  @IsOptional()
  @IsString()
  bankName?: string;

  @IsOptional()
  @IsString()
  accountName?: string;
}
