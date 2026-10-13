import { IntegrationDirection, IntegrationOutcome, IntegrationProvider } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDate, IsEnum, IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/pagination/pagination';

const toDate = (value: unknown): Date | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const toInt = (value: unknown): number | undefined => (value === undefined || value === '' ? undefined : Number(value));

/** Filters for GET /admin/integration-logs. Same shape as ListSystemLogsQueryDto. */
export class ListIntegrationLogsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(128) search?: string;

  @IsOptional() @IsEnum(IntegrationProvider) provider?: IntegrationProvider;

  @IsOptional() @IsString() @MaxLength(48) operation?: string;

  @IsOptional() @IsEnum(IntegrationDirection) direction?: IntegrationDirection;

  @IsOptional() @IsEnum(IntegrationOutcome) applicationOutcome?: IntegrationOutcome;

  @IsOptional() @Transform(({ value }) => toInt(value)) @IsInt() httpStatus?: number;

  @IsOptional() @IsString() @MaxLength(36) operationId?: string;

  @IsOptional() @IsString() @MaxLength(64) requestId?: string;

  @IsOptional() @IsString() @MaxLength(36) orderId?: string;

  @IsOptional() @IsString() @MaxLength(36) paymentId?: string;

  @IsOptional() @IsString() @MaxLength(36) shipmentId?: string;

  @IsOptional() @Transform(({ value }) => toDate(value)) @IsDate() dateFrom?: Date;

  @IsOptional() @Transform(({ value }) => toDate(value)) @IsDate() dateTo?: Date;

  @IsOptional() @IsIn(['asc', 'desc']) sort?: 'asc' | 'desc';
}
