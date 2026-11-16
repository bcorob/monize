/**
 * Pulls every container image reference out of a Dockerfile `FROM`, a
 * workflow/compose `image:`, or a shell script's `*_IMAGE=` default -- the
 * surfaces `ci-images.guard.spec.ts` (registry allowlist) and
 * `image-digest-pin.guard.spec.ts` (digest pinning) both scan. An earlier
 * Dockerfile stage referenced by name (`FROM builder AS production`) and a
 * build arg (`FROM $BASE`) are not images and are skipped.
 */
export function extractImageRefs(
  file: string,
  text: string,
): Array<{ line: number; image: string }> {
  const found: Array<{ line: number; image: string }> = [];
  const lines = text.split("\n");
  const shell = file.endsWith(".sh");
  const dockerfile = /(^|\/)Dockerfile[^/]*$/.test(file);
  const stages = new Set<string>();
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    let image: string | null = null;
    if (dockerfile) {
      const m = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
      if (m) {
        image =
          stages.has(m[1].toLowerCase()) || m[1].startsWith("$") ? null : m[1];
        if (m[2]) stages.add(m[2].toLowerCase());
      }
    } else if (shell) {
      const m = /^[A-Z_]*IMAGE="(?:\$\{[A-Z_]+:-)?([^"}]+)\}?"/.exec(line);
      image = m ? m[1] : null;
    } else {
      const m = /^image:\s*["']?(.+?)["']?\s*(?:\s#.*)?$/.exec(line);
      image = m ? m[1] : null;
    }
    if (image !== null) found.push({ line: index + 1, image });
  }
  return found;
}
