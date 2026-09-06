import { registerDecorator, ValidationOptions } from 'class-validator';
import { isIndonesianMobile } from '../../../../common/utils/phone.util';

/**
 * PAXELBOX-61AG.3.20 — the address phone must be an Indonesian MOBILE number.
 *
 * Why the address field is stricter than the rest of the system: this number is
 * what the courier calls on delivery and what Mekari Qontak messages on WhatsApp.
 * Before this, the DTO validated `@IsString() @Length(10, 15)` and nothing else,
 * so `abcdefghij` and `+62abc1234567` were accepted and persisted (61AG.3.19) —
 * then threw `InvalidPhoneError` deep in the notification worker and reached the
 * courier as an uncallable contact.
 *
 * Delegates to the canonical `isIndonesianMobile`; no phone logic lives here.
 * Pair it with the `@Transform` on the DTO, which stores the canonical `628…`
 * form — validation and normalisation are two halves of one contract.
 */
export function IsIndonesianMobile(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isIndonesianMobile',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isIndonesianMobile(value),
        // The rejected value is never echoed back — it is customer data.
        defaultMessage: () =>
          'phone must be an Indonesian mobile number (08xxxxxxxxxx, 628xxxxxxxxxx or +628xxxxxxxxxx)',
      },
    });
  };
}
