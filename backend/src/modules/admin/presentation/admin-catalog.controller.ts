import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { AdminService } from '../admin.service';
import { CreateCategoryDto } from '../application/dto/create-category.dto';
import { CreateProductDto } from '../application/dto/create-product.dto';
import { CreatePromoDto } from '../application/dto/create-promo.dto';
import { UpdateCategoryDto } from '../application/dto/update-category.dto';
import { UpdateProductDto } from '../application/dto/update-product.dto';
import { UpdatePromoDto } from '../application/dto/update-promo.dto';

@ApiTags('admin-catalog')
@UseGuards(AdminGuard)
@Controller({ path: 'admin/catalog', version: '1' })
export class AdminCatalogController {
  constructor(private readonly adminService: AdminService) { }

  @Post('products')
  createProduct(@Body() dto: CreateProductDto) {
    return this.adminService.createProduct(dto);
  }

  @Get('products')
  listProducts() {
    return this.adminService.listProducts();
  }

  @Get('products/:id')
  getProduct(@Param('id') id: string) {
    return this.adminService.getProduct(id);
  }

  @Patch('products/:id')
  updateProduct(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.adminService.updateProduct(id, dto);
  }

  @Delete('products/:id')
  deleteProduct(@Param('id') id: string) {
    return this.adminService.deleteProduct(id);
  }

  @Post('categories')
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.adminService.createCategory(dto);
  }

  @Get('categories')
  listCategories() {
    return this.adminService.listCategories();
  }

  @Get('categories/:id')
  getCategory(@Param('id') id: string) {
    return this.adminService.getCategory(id);
  }

  @Patch('categories/:id')
  updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.adminService.updateCategory(id, dto);
  }

  @Delete('categories/:id')
  deleteCategory(@Param('id') id: string) {
    return this.adminService.deleteCategory(id);
  }

  @Post('promos')
  createPromo(@Body() dto: CreatePromoDto) {
    return this.adminService.createPromo(dto);
  }

  @Get('promos')
  listPromos() {
    return this.adminService.listPromos();
  }

  @Get('promos/:id')
  getPromo(@Param('id') id: string) {
    return this.adminService.getPromo(id);
  }

  @Patch('promos/:id')
  updatePromo(@Param('id') id: string, @Body() dto: UpdatePromoDto) {
    return this.adminService.updatePromo(id, dto);
  }

  @Delete('promos/:id')
  deletePromo(@Param('id') id: string) {
    return this.adminService.deletePromo(id);
  }
}
