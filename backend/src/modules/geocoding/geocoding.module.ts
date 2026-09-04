import { Module } from '@nestjs/common';
import { AddressGeocodingService } from './address-geocoding.service';
import { GEOCODING_CONFIG, assertGeocodingConfigured, loadGeocodingConfig } from './geocoding.config';
import { GeocodingService } from './geocoding.service';

/**
 * PAXELBOX-61AG.3. Address -> coordinates, server-side only.
 *
 * Exists as its own module rather than inside `users` because the outlet admin
 * flow has the same need, and because the API key must stay on one side of a
 * clear boundary: nothing here is exported to a browser-facing surface.
 */
@Module({
  providers: [
    {
      provide: GEOCODING_CONFIG,
      useFactory: () => {
        const config = loadGeocodingConfig();
        // Boot fails rather than discovering at the first customer's address
        // that the feature is on with no key.
        assertGeocodingConfigured(config);
        return config;
      },
    },
    GeocodingService,
    AddressGeocodingService,
  ],
  exports: [GeocodingService, AddressGeocodingService],
})
export class GeocodingModule {}
