import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Unique,
} from "typeorm";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Exclude } from "class-transformer";
import { Category } from "../../categories/entities/category.entity";
import { User } from "../../users/entities/user.entity";
import { ContactLookupSource } from "../lookup/payee-contact-lookup.types";

@Entity("payees")
@Unique(["userId", "name"])
export class Payee {
  @ApiProperty({ example: "c5f5d5f0-1234-4567-890a-123456789abc" })
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @ApiProperty({ example: "user-uuid" })
  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @ApiProperty({ example: "Starbucks", description: "Name of the payee" })
  @Column({ type: "varchar", length: 255 })
  name: string;

  @ApiProperty({
    example: "category-uuid",
    required: false,
    description: "Default category for transactions with this payee",
  })
  @Column({ type: "uuid", name: "default_category_id", nullable: true })
  defaultCategoryId: string | null;

  @ApiProperty({ example: "Local coffee shop on Main Street", required: false })
  @Column({ type: "text", nullable: true })
  notes: string;

  /**
   * The payee's site. Stored absolute so it can go straight into an anchor:
   * a schemeless address would be resolved relative to the current page.
   */
  @ApiProperty({ example: "https://www.starbucks.com", required: false })
  @Column({ type: "varchar", length: 2048, nullable: true })
  website: string | null;

  // Cached favicon bytes. Never selected by default and never serialized to the
  // client -- the bytes are served only through GET /payees/:id/logo.
  @Exclude()
  @Column({ type: "bytea", name: "logo_data", nullable: true, select: false })
  logoData: Buffer | null;

  @Exclude()
  @Column({
    type: "varchar",
    name: "logo_content_type",
    length: 100,
    nullable: true,
    select: false,
  })
  logoContentType: string | null;

  @ApiProperty({
    example: true,
    description: "Whether a cached brand logo is available",
  })
  @Column({ type: "boolean", name: "has_logo", default: false })
  hasLogo: boolean;

  @ApiPropertyOptional()
  @Column({ type: "timestamp", name: "logo_fetched_at", nullable: true })
  logoFetchedAt: Date | null;

  /**
   * Free-text postal address. One field rather than structured parts: formats
   * are locale-specific, and the only consumer is a maps handoff that takes a
   * single query string anyway.
   */
  @ApiPropertyOptional({ example: "1912 Pike Pl, Seattle, WA 98101" })
  @Column({ type: "text", nullable: true })
  address: string | null;

  @ApiPropertyOptional({ example: "hello@starbucks.com" })
  @Column({ type: "varchar", length: 255, nullable: true })
  email: string | null;

  /**
   * E.164 with an optional RFC 3966 extension suffix (`+12064488762`,
   * `+442079460958;ext=12`), normalized on write by `PayeesService`. Rows
   * written before that rule are not backfilled, so a reader formats through
   * `formatPhoneForDisplay` rather than assuming the shape.
   */
  @ApiPropertyOptional({ example: "+12064488762" })
  @Column({ type: "varchar", length: 50, nullable: true })
  phone: string | null;

  /**
   * When a contact lookup last got an answer for this payee -- found
   * something, or established there was nothing to find. Stamped by the
   * background enrichment and the on-demand re-run; the enrichment's UPDATE is
   * keyed on this being NULL, so the automatic path runs at most once. A failed
   * attempt (provider offline, no answer) leaves it NULL so a later attempt can
   * still run.
   */
  @ApiPropertyOptional()
  @Column({ type: "timestamptz", name: "contact_lookup_at", nullable: true })
  contactLookupAt: Date | null;

  /**
   * Which lookup wrote at least one of the contact fields. NULL when every
   * stored value was typed by the user (including a form save of a prefilled
   * suggestion, which the user reviewed). The detail page's "looked up
   * automatically" badge keys off this, not off contactLookupAt.
   */
  @ApiPropertyOptional({ example: "ai-web-search" })
  @Column({
    type: "varchar",
    name: "contact_lookup_source",
    length: 32,
    nullable: true,
  })
  contactLookupSource: ContactLookupSource | null;

  @ApiProperty({ example: true, description: "Whether the payee is active" })
  @Column({ type: "boolean", name: "is_active", default: true })
  isActive: boolean;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: "default_category_id" })
  defaultCategory: Category;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
