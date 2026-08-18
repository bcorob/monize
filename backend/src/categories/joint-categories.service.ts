import { ForbiddenException, Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { tr } from "../i18n/translate";
import { Category } from "./entities/category.entity";
import { CategoriesService } from "./categories.service";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { JointAccountsService } from "../delegation/joint-accounts.service";
import { AccountDelegate } from "../delegation/entities/account-delegate.entity";

/**
 * Grantee category creation on a joint account's owner ledger (the write half
 * of the reference-data policy R1 that `JointAccountsService.jointReferenceData`
 * serves the read half of).
 *
 * A joint row belongs to the OWNER and may only carry the OWNER's category
 * ids, so a grantee typing a new category name into the register's picker has
 * to create it on the owner's ledger -- `POST /categories` writes to the
 * caller's own. Without this path the delegation's `categories_can_create`
 * capability drove nothing in a joint session: the flag was stored, surfaced
 * in the reference-data payload and then had no endpoint to reach, so the
 * form withheld "+ Create" whatever the owner had granted.
 *
 * Same shape as `JointRegisterService`: authorization is decided in full
 * before the audited `withSystemContext` bypass opens, and the write itself
 * reuses `CategoriesService.create` as the owner so parent validation, the
 * income-flag inheritance and the action-history entry are the owner's own.
 */
@Injectable()
export class JointCategoriesService {
  constructor(
    private dataSource: DataSource,
    private jointAccounts: JointAccountsService,
    private categoriesService: CategoriesService,
  ) {}

  /**
   * Create `dto` on the owner of `accountId`'s ledger.
   *
   * The account gate is READ, deliberately: it is the same gate that serves
   * the picker this create feeds (`jointReferenceData`), and the account is
   * here to name *which* owner's ledger is meant, not to authorize the write.
   * The write is authorized by the per-delegation `categoriesCanCreate`
   * capability -- which is exactly, and only, what gates the acting-as
   * `POST /categories` route, where no account grant is consulted at all. A
   * grantee who may edit but not create rows in the account still needs a
   * category for the row they are editing, so keying this on the account's
   * write flags would refuse a create the capability plainly grants.
   */
  async create(
    realUserId: string,
    accountId: string,
    dto: CreateCategoryDto,
  ): Promise<Category> {
    const access = await this.jointAccounts.jointAccessFor(
      realUserId,
      accountId,
      "read",
    );
    await this.assertCategoryCreateGranted(realUserId, access.ownerUserId);
    return withSystemContext(() =>
      this.categoriesService.create(access.ownerUserId, dto),
    );
  }

  /**
   * The delegation between these two users must be active and carry
   * `categories_can_create`. Refuses before anything is written, and before
   * the system-context window opens.
   */
  private async assertCategoryCreateGranted(
    realUserId: string,
    ownerUserId: string,
  ): Promise<void> {
    const delegation = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(AccountDelegate).findOne({
        where: {
          ownerUserId,
          delegateUserId: realUserId,
          status: "active",
        },
        select: ["id", "categoriesCanCreate"],
      }),
    );
    if (!delegation?.categoriesCanCreate) {
      throw new ForbiddenException(
        tr(
          "errors.delegation.jointCategoryCreateNotGranted",
          "The account owner has not granted you permission to create categories. Pick one of their existing categories instead.",
        ),
      );
    }
  }
}
