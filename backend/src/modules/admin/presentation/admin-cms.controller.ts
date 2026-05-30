import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { AdminService } from '../admin.service';
import { CreateBannerDto } from '../../cms/application/dto/banner.dto';
import { UpdateBannerDto } from '../application/dto/update-banner.dto';

@ApiTags('admin-cms')
@UseGuards(AdminGuard)
@Controller({ path: 'admin/cms', version: '1' })
export class AdminCmsController {
  constructor(private readonly adminService: AdminService) {}

  @Post('banners')
  createBanner(@Body() dto: CreateBannerDto) {
    return this.adminService.createBanner(dto);
  }

  @Get('banners')
  listBanners() {
    return this.adminService.listBanners();
  }

  @Get('banners/:id')
  getBanner(@Param('id') id: string) {
    return this.adminService.getBanner(id);
  }

  @Patch('banners/:id')
  updateBanner(@Param('id') id: string, @Body() dto: UpdateBannerDto) {
    return this.adminService.updateBanner(id, dto);
  }

  @Delete('banners/:id')
  deleteBanner(@Param('id') id: string) {
    return this.adminService.deleteBanner(id);
  }
}
