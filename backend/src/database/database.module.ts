import { Module } from "@nestjs/common";
import { SeedService } from "./seed.service";
import { DemoSeedService } from "./demo-seed.service";
import { DemoResetService } from "./demo-reset.service";
import { FaviconModule } from "../common/favicon/favicon.module";

@Module({
  imports: [FaviconModule],
  providers: [SeedService, DemoSeedService, DemoResetService],
  exports: [SeedService, DemoSeedService],
})
export class DatabaseModule {}
