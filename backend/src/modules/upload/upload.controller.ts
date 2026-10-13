import {
    Controller,
    Post,
    UploadedFile,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { UploadService } from './upload.service';
import { MEMORY_UPLOAD_OPTIONS, persistValidatedImage, publicUploadDir, UPLOAD_THROTTLE } from './upload.util';

/**
 * Admin catalogue/banner image upload.
 *
 * H3 / L7: authentication AND the Media.upload permission are checked by guards,
 * which run before the Multer interceptor; Multer buffers in memory only; the file
 * is written (to the PUBLIC directory - these images are shown on the storefront)
 * only after its magic bytes prove it is an image.
 */
@Controller('upload')
@UseGuards(AdminGuard, PermissionGuard)
export class UploadController {
    constructor(
        private readonly uploadService: UploadService,
    ) { }

    @Post()
    @ApiBearerAuth()
    @Permissions('Media.upload')
    @Throttle({ default: UPLOAD_THROTTLE })
    @UseInterceptors(FileInterceptor('file', MEMORY_UPLOAD_OPTIONS))
    async uploadFile(
        @UploadedFile() file: Express.Multer.File,
    ) {
        const filename = await persistValidatedImage(file, publicUploadDir());
        return {
            success: true,
            url: this.uploadService.getFileUrl(filename),
        };
    }
}
