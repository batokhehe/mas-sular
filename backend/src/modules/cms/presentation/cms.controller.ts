import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../../database/prisma.service';
import { CreateBannerDto } from '../application/dto/banner.dto';

@ApiTags('cms')
@Controller({ path: 'cms', version: '1' })
export class CmsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('banners')
  banners(@Query('placement') placement?: string) {
    return this.prisma.banner.findMany({
      where: { deletedAt: null, isActive: true, placement },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
  }

  @Post('banners')
  createBanner(@Body() dto: CreateBannerDto) {
    return this.prisma.banner.create({ data: { ...dto, isActive: dto.isActive ?? true } });
  }
}
