import {
    Controller,
    Post,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { UploadService } from './upload.service';

@Controller('upload')
export class UploadController {
    constructor(
        private readonly uploadService: UploadService,
    ) { }

    @Post()
    @UseInterceptors(
        FileInterceptor('file', {
            storage: diskStorage({
                destination: './uploads',

                filename: (req, file, cb) => {
                    const uniqueName =
                        Date.now() +
                        '-' +
                        Math.round(Math.random() * 1e9);

                    cb(
                        null,
                        `${uniqueName}${extname(
                            file.originalname,
                        )}`,
                    );
                },
            }),
        }),
    )
    uploadFile(
        @UploadedFile() file: Express.Multer.File,
    ) {
        return {
            success: true,
            url: this.uploadService.getFileUrl(
                file.filename,
            ),
        };
    }
}