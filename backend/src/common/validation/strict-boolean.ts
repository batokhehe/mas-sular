import type { TransformFnParams } from 'class-transformer';

/*
 * Boolean fields under the global ValidationPipe. main.ts enables
 * `enableImplicitConversion`, which turns ANY non-empty string - including
 * "false" - into `true` for a field typed `boolean`. Used with @Transform on
 * product flags (P2 #10 isPromoSpecial, P2 #11 isTrialPack) so the value is read
 * before that conversion and @IsBoolean decides.
 */

/** JSON body: the value exactly as sent; @IsBoolean then rejects anything that is not a real boolean. */
export const rawBoolean = ({ obj, key }: TransformFnParams): unknown => (obj as Record<string, unknown>)[key];

/** Query string: only "true"/"false" (or real booleans) convert; anything else is left for @IsBoolean to reject. */
export const queryBoolean = ({ obj, key }: TransformFnParams): unknown => {
  const raw = (obj as Record<string, unknown>)[key];
  if (raw === 'true' || raw === true) return true;
  if (raw === 'false' || raw === false) return false;
  return raw;
};
