import {
  BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RejectUrlCredentialsGuard } from '../../../common/guards/reject-url-credentials.guard';
import { AdminUser, CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { buildAdminNotification } from '../../../infrastructure/admin-notifications/admin-notification.builder';
import { AdminNotificationDispatcher } from '../../../infrastructure/admin-notifications/admin-notification.dispatcher';
import { AdminNotificationMetrics } from '../../../infrastructure/admin-notifications/admin-notification.metrics';
import { AdminNotificationRepository } from '../../../infrastructure/admin-notifications/admin-notification.repository';
import { SseHubService } from '../../../infrastructure/admin-notifications/sse-hub.service';
import { BellListQueryDto, ManualNotificationDto, RegisterPushDto } from '../application/dto/bell-query.dto';

/**
 * Admin notification platform API: bell feed (cursor pagination), unread badge,
 * realtime SSE stream, read state, web-push token registry, manual broadcast.
 */
@ApiTags('admin-bell')
@Controller({ path: 'admin/notifications', version: '1' })
export class AdminBellController {
  constructor(
    private readonly repository: AdminNotificationRepository,
    private readonly dispatcher: AdminNotificationDispatcher,
    private readonly sseHub: SseHubService,
    private readonly metrics: AdminNotificationMetrics,
  ) {}

  @UseGuards(AdminGuard, PermissionGuard)
  @Permissions('Notification.read')
  @Get()
  list(@CurrentAdmin() admin: AdminUser, @Query() query: BellListQueryDto) {
    return this.repository.list({
      adminId: admin.sub,
      cursor: query.cursor,
      limit: query.limit,
      unread: query.unread === true,
      category: query.category,
    });
  }

  @UseGuards(AdminGuard, PermissionGuard)
  @Permissions('Notification.read')
  @Get('unread-count')
  async unreadCount(@CurrentAdmin() admin: AdminUser) {
    return { count: await this.repository.unreadCount(admin.sub) };
  }

  @UseGuards(AdminGuard, PermissionGuard)
  @Permissions('Notification.read')
  @Get('metrics')
  observability() {
    return { ...this.metrics.snapshot(), activeSseConnections: this.sseHub.activeConnections() };
  }

  /**
   * SSE stream (H2). Authenticated exactly like every sibling endpoint: the httpOnly
   * admin session cookie (EventSource `withCredentials: true`) through AdminGuard,
   * then PermissionGuard against the admin's LIVE database permissions.
   *
   * The former `?token=<JWT>` authentication is gone. The URL carried the admin
   * access token into the nginx access log and the pino request log on every
   * (re)connect; RejectUrlCredentialsGuard now refuses such a request outright, even
   * when a valid cookie is also present, so no client can keep leaking a token.
   */
  @UseGuards(RejectUrlCredentialsGuard, AdminGuard, PermissionGuard)
  @Permissions('Notification.read')
  @Get('stream')
  stream(@CurrentAdmin() admin: AdminUser, @Res() res: Response) {
    this.sseHub.register(admin.sub, res);
  }

  @UseGuards(AdminGuard, PermissionGuard)
  @Permissions('Notification.read')
  @Patch('read-all')
  async readAll(@CurrentAdmin() admin: AdminUser) {
    const result = await this.repository.markAllRead(admin.sub);
    this.dispatcher.notifyRead(admin.sub, 'all'); // sync every open tab
    return result;
  }

  @UseGuards(AdminGuard, PermissionGuard)
  @Permissions('Notification.read')
  @Patch(':id/read')
  async read(@Param('id') id: string, @CurrentAdmin() admin: AdminUser) {
    const result = await this.repository.markRead(id, admin.sub);
    this.dispatcher.notifyRead(admin.sub, id);
    return result;
  }

  // Manual broadcast to every active admin (announcements / ops notices).
  @UseGuards(AdminGuard, PermissionGuard)
  @Permissions('Notification.manage')
  @Post('manual')
  async manual(@Body() dto: ManualNotificationDto, @CurrentAdmin() admin: AdminUser) {
    const draft = buildAdminNotification('manual.notification', { ...dto });
    if (!draft) throw new BadRequestException('Invalid manual notification');
    draft.metadata = { ...(draft.metadata ?? {}), sentBy: admin.sub };
    const created = await this.dispatcher.dispatch(draft);
    return { created };
  }
}

/** Web-push token registry (spec path: /admin/push/register). */
@ApiTags('admin-bell')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/push', version: '1' })
export class AdminPushController {
  constructor(private readonly repository: AdminNotificationRepository) {}

  @Permissions('Notification.read')
  @Post('register')
  register(@Body() dto: RegisterPushDto, @CurrentAdmin() admin: AdminUser, @Req() req: Request) {
    return this.repository.registerPushToken(admin.sub, { ...dto, userAgent: req.headers['user-agent'] as string | undefined });
  }

  @Permissions('Notification.read')
  @Delete('register/:token')
  unregister(@Param('token') token: string, @CurrentAdmin() admin: AdminUser) {
    return this.repository.removePushToken(admin.sub, token);
  }
}
