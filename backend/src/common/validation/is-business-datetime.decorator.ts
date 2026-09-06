import { applyDecorators } from '@nestjs/common';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsDate } from 'class-validator';
import { parseBusinessDateTime } from '../utils/business-time.util';

export const BUSINESS_DATETIME_MESSAGE =
  'must be a date and time like "2026-09-12T09:59" (read as Asia/Jakarta) or a full ISO-8601 instant';

/**
 * Normalise an admin-supplied business datetime AT THE API BOUNDARY.
 *
 * The property ends up as a real `Date` on the DTO, so services can hand it
 * straight to Prisma and a malformed string can never reach the driver — it is
 * refused as an ordinary 400 first. Create and update share this one decorator
 * rather than each doing their own `new Date(...)`.
 *
 * WHY IT READS `obj[key]` AND NOT `value`
 *
 * The global ValidationPipe runs with `enableImplicitConversion: true`, and
 * class-transformer applies that implicit type conversion BEFORE custom
 * `@Transform` functions. For a property declared `Date`, the implicit step is
 * `new Date(value)` — which reads the NODE PROCESS TIMEZONE for a naked wall
 * clock, the exact mistake this decorator exists to prevent. By the time a
 * transform reading `value` ran, the damage would already be done and invisible:
 * it would receive a valid-looking Date that is seven hours off in production
 * and correct on a developer machine.
 *
 * `obj` is the untouched plain request body, so `obj[key]` is the raw string the
 * browser actually sent, whatever the pipe did to `value`.
 */
export function IsBusinessDateTime(): PropertyDecorator {
  return applyDecorators(
    Transform(
      ({ obj, key }: TransformFnParams) => {
        const raw = (obj as Record<string, unknown>)?.[key];
        if (raw === undefined || raw === null) return raw;
        if (raw instanceof Date) return raw;
        if (typeof raw !== 'string') return raw;
        // On failure the raw value is passed through unchanged so that @IsDate
        // below produces the 400. Returning undefined here would instead look
        // like "field omitted" and silently skip the update.
        return parseBusinessDateTime(raw) ?? raw;
      },
      { toClassOnly: true },
    ),
    IsDate({ message: `$property ${BUSINESS_DATETIME_MESSAGE}` }),
  );
}
