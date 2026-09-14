import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import { publicUploadDir, receiptUploadDir } from './upload.util';

/** The API route base (`/api/v1`), derived exactly as main.ts derives it. */
export function apiRouteBase(env: NodeJS.ProcessEnv = process.env): string {
  const prefix = (env.API_PREFIX ?? 'api').replace(/^\/+|\/+$/g, '');
  return `/${prefix}/v${env.API_VERSION ?? '1'}`;
}

@Injectable()
export class UploadService implements OnModuleInit {
  private readonly logger = new Logger(UploadService.name);

  async onModuleInit(): Promise<void> {
    // Both directories live on the uploads volume; create them up front so the
    // first upload after a fresh deploy does not race on mkdir.
    for (const dir of [publicUploadDir(), receiptUploadDir()]) {
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (err) {
        this.logger.error(`cannot create upload directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private base(): string {
    const base = process.env.APP_URL;
    // APP_URL is required + URL-validated at startup; guard defensively so we never
    // emit a malformed "undefined/uploads/..." URL if this is ever reached unset.
    if (!base) {
      throw new Error('APP_URL is not configured; cannot build an upload URL');
    }
    return base.replace(/\/+$/, '');
  }

  /** Public catalogue/banner image: served statically from uploads/public. */
  getFileUrl(filename: string) {
    return `${this.base()}/uploads/${filename}`;
  }

  /** Private payment receipt: only readable through the authenticated receipts endpoint. */
  getReceiptUrl(filename: string) {
    return `${this.base()}${apiRouteBase()}/payments/receipts/${filename}`;
  }
}
