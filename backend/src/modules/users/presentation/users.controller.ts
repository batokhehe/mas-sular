import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../../database/prisma.service';
import { CurrentUser, AuthUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CreateAddressDto } from '../application/dto/address.dto';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.prisma.user.findUnique({
      where: { id: user.sub },
      include: {
        roles: { include: { role: true } },
        addresses: { where: { deletedAt: null }, orderBy: { isDefault: 'desc' } },
      },
    });
  }

  @Get('me/addresses')
  getAddresses(@CurrentUser() user: AuthUser) {
    return this.prisma.address.findMany({
      where: { userId: user.sub, deletedAt: null },
      orderBy: { isDefault: 'desc' },
    });
  }

  @Post('me/addresses')
  async createAddress(@CurrentUser() user: AuthUser, @Body() dto: CreateAddressDto) {
    return this.prisma.$transaction(async (prisma) => {
      if (dto.isDefault) {
        await prisma.address.updateMany({
          where: { userId: user.sub, isDefault: true },
          data: { isDefault: false },
        });
      }

      const address = await prisma.address.create({
        data: {
          ...dto,
          userId: user.sub,
        },
      });

      await prisma.user.update({
        where: { id: user.sub },
        data: { isOnboarded: true },
      });

      return address;
    });
  }
}
