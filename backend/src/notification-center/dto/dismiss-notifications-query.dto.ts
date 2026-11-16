import { IsEnum, IsIn, IsOptional } from "class-validator";
import { NotificationSeverity } from "../entities/notification.entity";

/**
 * The two halves of the type partition, as the client spells them. Deliberately
 * coarser than `NotificationCategory`: this is "everything the system told me"
 * versus "everything about my money", which is the split the list UI offers.
 */
export const NOTIFICATION_FILTER_CATEGORIES = ["system", "financial"] as const;
export type NotificationFilterCategory =
  (typeof NOTIFICATION_FILTER_CATEGORIES)[number];

/**
 * The filter a dismiss-all command carries. The client sends its active filter
 * explicitly on the command (never inferred from which rows happen to be on
 * screen), and the server restricts the write on it -- an omitted field means
 * "no restriction on that dimension".
 */
export class DismissNotificationsQueryDto {
  @IsOptional()
  @IsEnum(NotificationSeverity)
  severity?: NotificationSeverity;

  @IsOptional()
  @IsIn(NOTIFICATION_FILTER_CATEGORIES)
  category?: NotificationFilterCategory;
}
