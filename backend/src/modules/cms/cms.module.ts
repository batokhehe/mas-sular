import { Module } from '@nestjs/common';
import { CmsController } from './presentation/cms.controller';

@Module({ controllers: [CmsController] })
export class CmsModule {}
