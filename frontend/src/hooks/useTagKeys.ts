import { useEffect, useState } from "react";
import { tagsApi } from "@/lib/tags";
import { collectTagKeys } from "@/lib/tag-key-value";
import { createLogger } from "@/lib/logger";

const logger = createLogger("useTagKeys");

/**
 * Distinct `KEY:VALUE` tag namespace keys the user has, for a "Break down by
 * tag key" control (the `CategoryTagBreakdownPanel` precedent). Empty until
 * tags load, and empty on a failed load -- a caller hides its control rather
 * than showing one with no options.
 */
export function useTagKeys(): string[] {
  const [tagKeys, setTagKeys] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    tagsApi
      .getAll()
      .then((tags) => {
        if (!cancelled) setTagKeys(collectTagKeys(tags.map((tag) => tag.name)));
      })
      .catch((error) => {
        logger.error(error);
        if (!cancelled) setTagKeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return tagKeys;
}
