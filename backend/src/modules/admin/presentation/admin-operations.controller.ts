import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { AdminUser, CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { AdminService } from '../admin.service';
import {
  CreateShipmentDto,
  ListAdminOrdersQueryDto,
  ListAdminShipmentsQueryDto,
  RejectAdminPaymentDto,
  UpdateOrderStatusDto,
  UpdateShipmentDto,
  VerifyAdminPaymentDto,
} from '../application/dto/admin-operations.dto';
import { CreateRoleDto } from '../application/dto/create-role.dto';
import { UpdateRoleDto } from '../application/dto/update-role.dto';
import { UpdateUserDto } from '../application/dto/update-user.dto';

@ApiTags('admin-operations')
@UseGuards(AdminGuard)
@Controller({ path: 'admin', version: '1' })
export class AdminOperationsController {
  constructor(private readonly adminService: AdminService) {}

  @Get('dashboard')
  dashboard() {
    return this.adminService.getDashboard();
  }

  @Get('orders')
  listOrders(@Query() query: ListAdminOrdersQueryDto) {
    return this.adminService.listOrders(query);
  }

  @Get('orders/:id')
  getOrder(@Param('id') id: string) {
    return this.adminService.getOrder(id);
  }

  @Patch('orders/:id/status')
  updateOrderStatus(@Param('id') id: string, @Body() dto: UpdateOrderStatusDto) {
    return this.adminService.updateOrderStatus(id, dto);
  }

  @Get('payments')
  listPayments(@Query('status') status?: PaymentStatus) {
    return this.adminService.listPayments(status);
  }

  @Get('payments/pending-verification')
  listPendingPaymentVerification() {
    return this.adminService.listPayments();
  }

  @Patch('payments/:paymentId/verify')
  verifyPayment(@Param('paymentId') paymentId: string, @CurrentAdmin() admin: AdminUser, @Body() dto: VerifyAdminPaymentDto) {
    return this.adminService.verifyPayment(paymentId, admin.sub, dto);
  }

  @Patch('payments/:paymentId/reject')
  rejectPayment(@Param('paymentId') paymentId: string, @Body() dto: RejectAdminPaymentDto) {
    return this.adminService.rejectPayment(paymentId, dto);
  }

  @Post('shipments')
  createShipment(@Body() dto: CreateShipmentDto) {
    return this.adminService.createShipment(dto);
  }

  @Get('shipments')
  listShipments(@Query() query: ListAdminShipmentsQueryDto) {
    return this.adminService.listShipments(query);
  }

  @Get('shipments/:id')
  getShipment(@Param('id') id: string) {
    return this.adminService.getShipment(id);
  }

  @Patch('shipments/:id')
  updateShipment(@Param('id') id: string, @Body() dto: UpdateShipmentDto) {
    return this.adminService.updateShipment(id, dto);
  }

  @Delete('shipments/:id')
  deleteShipment(@Param('id') id: string) {
    return this.adminService.deleteShipment(id);
  }

  @Get('users')
  listUsers() {
    return this.adminService.listUsers();
  }

  @Get('users/:id')
  getUser(@Param('id') id: string) {
    return this.adminService.getUser(id);
  }

  @Patch('users/:id')
  updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.adminService.updateUser(id, dto);
  }

  @Post('roles')
  createRole(@Body() dto: CreateRoleDto) {
    return this.adminService.createRole(dto);
  }

  @Get('roles')
  listRoles() {
    return this.adminService.listRoles();
  }

  @Get('roles/:id')
  getRole(@Param('id') id: string) {
    return this.adminService.getRole(id);
  }

  @Patch('roles/:id')
  updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.adminService.updateRole(id, dto);
  }

  @Get('permissions')
  listPermissions() {
    return this.adminService.listPermissions();
  }
}
