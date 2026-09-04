import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import { isPersistableCoordinate } from '../../../geocoding/geocoding.service';

/**
 * PAXELBOX-61AG.3.7 — the coordinate pair on an address UPDATE.
 *
 * Why this exists: `latitude`/`longitude` are deliberately NOT in LOCATION_FIELDS,
 * so a patch touching only them short-circuits `withCoordinates()` and is written
 * verbatim (that is correct — dragging a pin must not spend a Google request).
 * The consequence, confirmed against a real database in 61AG.3.4 and through a
 * real browser in 61AG.3.5, was that `PATCH {latitude: 0, longitude: 0}` silently
 * replaced a correct geocoded pin with the form's placeholder.
 *
 * The fix belongs HERE rather than in LOCATION_FIELDS: widening that list would
 * make every pin edit re-geocode, buying a Google call to solve a validation
 * problem. Rejecting the value before it reaches the controller costs nothing and
 * changes no geocoding behaviour.
 *
 * Applied to `latitude`, and reads `longitude` off the sibling property, because
 * a coordinate is only meaningful as a PAIR: a lone latitude puts the pin on a
 * point that is neither where it was nor where it was meant to go.
 *
 * `isPersistableCoordinate` is reused rather than reimplemented — the same
 * predicate already guards what GeocodingService will return and what
 * PaxelProvider will transmit, so all three agree on what a usable pin is.
 */
export function IsCoordinatePair(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isCoordinatePair',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown, args: ValidationArguments) =>
          isPersistableCoordinate(value, (args.object as { longitude?: unknown }).longitude),
        defaultMessage: () =>
          'latitude and longitude must be a usable coordinate pair: both are required, ' +
          'latitude between -90 and 90, longitude between -180 and 180, and 0,0 is not a location',
      },
    });
  };
}
