/**
 * The Jest transform for the unit and integration suites: ts-jest, plus a
 * rewrite of the two ESM-only constructs it cannot compile to CommonJS.
 *
 * NestJS 12 and its companion packages are published as pure ESM. Jest runs
 * this project as CommonJS, so those packages are on the
 * `transformIgnorePatterns` allowlist and ts-jest compiles them like source.
 * That works for `import`/`export`, but several files build a `require` from
 * the module URL:
 *
 *     const require = createRequire(import.meta.url);
 *
 * `import.meta` is a syntax error outside an ES module, and redeclaring
 * `require` collides with the parameter of Jest's module wrapper, so every
 * spec that loaded such a file failed with "Must use import to load ES
 * Module". In CommonJS `require` and `__filename` already exist, so the
 * declaration is dropped and any other `import.meta.url` becomes the file URL
 * of `__filename`. Only files under `node_modules` are rewritten; the project's
 * own sources never use `import.meta`.
 *
 * Native ESM (`--experimental-vm-modules`) loads the packages unchanged but ran
 * a three-file sample (module-graph, accounts service, two-factor) in 282 s
 * against 98 s with this transform, and needs the existing allowlist entries
 * removed, which is why this is a transform rather than a loader switch.
 */
const { TsJestTransformer } = require("ts-jest");

const CREATE_REQUIRE_DECLARATION =
  /^[ \t]*const require = createRequire\(import\.meta\.url\);[ \t]*$/gm;
const IMPORT_META_URL = /\bimport\.meta\.url\b/g;
const CJS_FILE_URL = 'require("node:url").pathToFileURL(__filename).href';

function rewrite(sourceText, sourcePath) {
  if (
    !sourcePath.includes("/node_modules/") ||
    !sourceText.includes("import.meta")
  ) {
    return sourceText;
  }
  return sourceText
    .replace(CREATE_REQUIRE_DECLARATION, "")
    .replace(IMPORT_META_URL, CJS_FILE_URL);
}

class EsmInteropTransformer extends TsJestTransformer {
  process(sourceText, sourcePath, transformOptions) {
    return super.process(
      rewrite(sourceText, sourcePath),
      sourcePath,
      transformOptions,
    );
  }

  processAsync(sourceText, sourcePath, transformOptions) {
    return super.processAsync(
      rewrite(sourceText, sourcePath),
      sourcePath,
      transformOptions,
    );
  }

  getCacheKey(sourceText, sourcePath, transformOptions) {
    return super.getCacheKey(
      rewrite(sourceText, sourcePath),
      sourcePath,
      transformOptions,
    );
  }

  getCacheKeyAsync(sourceText, sourcePath, transformOptions) {
    return super.getCacheKeyAsync(
      rewrite(sourceText, sourcePath),
      sourcePath,
      transformOptions,
    );
  }
}

module.exports = {
  createTransformer: (tsJestConfig) => new EsmInteropTransformer(tsJestConfig),
};
