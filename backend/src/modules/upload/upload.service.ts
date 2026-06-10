import { Injectable } from '@nestjs/common';

@Injectable()
export class UploadService {
    getFileUrl(filename: string) {
        return `${process.env.APP_URL}/uploads/${filename}`;
    }
}