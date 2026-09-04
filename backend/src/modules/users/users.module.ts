import { Module } from '@nestjs/common';
import { GeocodingModule } from '../geocoding/geocoding.module';
import { UsersController } from './presentation/users.controller';

@Module({ imports: [GeocodingModule], controllers: [UsersController] })
export class UsersModule {}
