import { join } from "node:path";
import { DataSource } from "typeorm";
import { NotificationReminder } from "./entities/notification-reminder.entity";

// Build the same metadata as the integration database, without connecting to
// PostgreSQL. This checks the actual FK TypeORM will synchronize, not merely
// the presence of decorators in the source.
class MetadataDataSource extends DataSource {
  buildForTest() {
    return this.buildMetadatas();
  }
}

describe("notification reminder source relation", () => {
  it("maps the existing nullable column to a non-cascading SET NULL FK", async () => {
    const source = new MetadataDataSource({
      type: "postgres",
      entities: [join(__dirname, "../**/*.entity.ts")],
    });
    await source.buildForTest();
    const metadata = source.getMetadata(NotificationReminder);
    const relation =
      metadata.findRelationWithPropertyPath("sourceNotification")!;
    expect(relation).toBeDefined();
    expect(relation.isNullable).toBe(true);
    expect(relation.isEager).toBe(false);
    expect(relation.isCascadeInsert).toBe(false);
    expect(relation.isCascadeUpdate).toBe(false);
    expect(relation.isCascadeRemove).toBe(false);
    const fk = relation.foreignKeys[0];
    expect(fk.columnNames).toEqual(["source_notification_id"]);
    expect(fk.referencedTablePath).toBe("notifications");
    expect(fk.referencedColumnNames).toEqual(["id"]);
    expect(fk.onDelete).toBe("SET NULL");
    expect(
      metadata.columns.filter(
        (c) => c.databaseName === "source_notification_id",
      ),
    ).toHaveLength(1);
  });
});
