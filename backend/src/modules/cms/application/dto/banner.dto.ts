import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateBannerDto {
  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  imageUrl!: string;

  @IsOptional()
  @IsString()
  href?: string;

  @IsString()
  placement!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
