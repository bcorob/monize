import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ActionHistoryModule } from "../../action-history/action-history.module";
import { EncryptionModule } from "../../common/encryption/encryption.module";
import { FaviconModule } from "../../common/favicon/favicon.module";
import { ProviderHealthModule } from "../../provider-health/provider-health.module";
import { Payee } from "../entities/payee.entity";
import { PayeeContactEnrichmentService } from "./payee-contact-enrichment.service";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { AiPayeeContactLookupProvider } from "./ai-payee-contact-lookup.provider";
import { GooglePlacesInstanceUsage } from "./entities/google-places-instance-usage.entity";
import { PayeeLookupSettings } from "./entities/payee-lookup-settings.entity";
import { PayeeLookupUsage } from "./entities/payee-lookup-usage.entity";
import { GooglePlacesClient } from "./google-places/google-places.client";
import { GooglePlacesLookupProvider } from "./google-places/google-places-lookup.provider";
import { PayeeLookupQuotaService } from "./google-places/payee-lookup-quota.service";
import { PayeeLookupSettingsService } from "./google-places/payee-lookup-settings.service";
import { PayeeContactLookupService } from "./payee-contact-lookup.service";
import { PAYEE_CONTACT_LOOKUP_PROVIDER } from "./payee-contact-lookup.types";
import { PayeeLookupController } from "./payee-lookup.controller";
import { RoutingPayeeContactLookupProvider } from "./routing-payee-contact-lookup.provider";

/**
 * Which data source answers a contact lookup is decided here, once.
 *
 * Two adapters exist -- the user's own AI configuration
 * (`AiPayeeContactLookupProvider`) and Google Places
 * (`GooglePlacesLookupProvider`, which has `websiteUri`,
 * `internationalPhoneNumber` and `formattedAddress`, and no email) -- and the
 * token is bound to neither. It is bound to
 * `RoutingPayeeContactLookupProvider`, because the choice is per lookup rather
 * than per deployment: it depends on whose key is configured (the operator's
 * `GOOGLE_PLACES_API_KEY` or the user's own row) and on whether that key's
 * monthly cap is already spent. Nothing outside this module knows any of that.
 *
 * `EncryptionModule` and `ProviderHealthModule` are leaves that import nothing
 * back, so neither edge needs a `forwardRef`.
 */
@Module({
  // Deliberately no AiModule import: the AI adapter and this module's
  // controller both resolve AiService lazily through ModuleRef, so this module
  // sits off every require cycle.
  imports: [
    TypeOrmModule.forFeature([
      UserPreference,
      Payee,
      PayeeLookupSettings,
      PayeeLookupUsage,
      GooglePlacesInstanceUsage,
    ]),
    ActionHistoryModule,
    FaviconModule,
    EncryptionModule,
    ProviderHealthModule,
  ],
  controllers: [PayeeLookupController],
  providers: [
    PayeeContactLookupService,
    PayeeContactEnrichmentService,
    AiPayeeContactLookupProvider,
    GooglePlacesClient,
    GooglePlacesLookupProvider,
    PayeeLookupQuotaService,
    PayeeLookupSettingsService,
    RoutingPayeeContactLookupProvider,
    {
      provide: PAYEE_CONTACT_LOOKUP_PROVIDER,
      useExisting: RoutingPayeeContactLookupProvider,
    },
  ],
  exports: [
    PayeeContactLookupService,
    PayeeContactEnrichmentService,
    PayeeLookupSettingsService,
  ],
})
export class PayeeContactLookupModule {}
