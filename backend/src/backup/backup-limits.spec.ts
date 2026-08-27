import {
  MEASURED_PEAK_FIXED_BYTES,
  MEASURED_PEAK_SLOPE,
  RESTORE_HEADROOM_SHARE,
  deriveDefaultLimitBytes,
  deriveRestoreExpandedLimitBytes,
  detectProcessMemoryLimitBytes,
  restorePeakBytes,
  parseByteSize,
  resolveByteLimit,
  resolveRestoreExpandedLimitBytes,
  resolveRestoreUploadLimitBytes,
  restoreProcessBaselineBytes,
  warnIfLimitExceedsMemory,
  warnIfRestoreUploadLimitIsCramped,
  warnIfRestoreUploadLimitIsUnsafe,
} from "./backup-limits";

const MIB = 1024 * 1024;

describe("backup size limits", () => {
  describe("parseByteSize", () => {
    it("reads the units the deployment docs use", () => {
      expect(parseByteSize("1024")).toBe(1024);
      expect(parseByteSize("512kb")).toBe(512 * 1024);
      expect(parseByteSize("400mb")).toBe(400 * 1024 * 1024);
      expect(parseByteSize("2gb")).toBe(2 * 1024 * 1024 * 1024);
    });

    it("is case- and space-insensitive", () => {
      expect(parseByteSize(" 512MB ")).toBe(512 * 1024 * 1024);
      expect(parseByteSize("1.5gb")).toBe(1.5 * 1024 * 1024 * 1024);
    });

    it("returns null for anything it cannot read", () => {
      // Not zero and not Infinity: either would be a ceiling that is not there.
      // A caller that cannot read the value must fall back to its default.
      for (const bad of ["", "  ", "mb", "-5mb", "0", "0mb", "512tb", "abc"]) {
        expect(parseByteSize(bad)).toBeNull();
      }
      expect(parseByteSize(undefined)).toBeNull();
    });
  });

  describe("resolveByteLimit", () => {
    it("uses the configured value when it parses", () => {
      expect(resolveByteLimit("256mb", 999 * MIB)).toBe(256 * 1024 * 1024);
    });

    it("falls back and reports when it does not", () => {
      const onInvalid = jest.fn();
      expect(resolveByteLimit("enormous", 128 * MIB, onInvalid)).toBe(
        128 * MIB,
      );
      expect(onInvalid).toHaveBeenCalledTimes(1);
      expect(onInvalid.mock.calls[0][0]).toContain("enormous");
    });

    it("falls back silently when nothing is configured", () => {
      const onInvalid = jest.fn();
      expect(resolveByteLimit(undefined, 128 * MIB, onInvalid)).toBe(128 * MIB);
      expect(resolveByteLimit("", 123, onInvalid)).toBe(123);
      // An unset variable is not a misconfiguration; warning on it trains people
      // to ignore the warning that matters.
      expect(onInvalid).not.toHaveBeenCalled();
    });
  });

  /**
   * The defaults used to be fixed numbers -- 512 MiB of export JSON, 1 GiB of
   * expanded restore -- while the chart's default backend memory limit is
   * 400 MiB. Neither could ever fire: the pod was OOM-killed first, which is the
   * outcome the ceilings existed to prevent. A ceiling has to be smaller than the
   * thing it protects, and only the container knows how big that is.
   */
  describe("deriveDefaultLimitBytes", () => {
    it("stays well under the container's memory limit", () => {
      // The case that was broken: the chart's default backend.
      const derived = deriveDefaultLimitBytes(400 * MIB);
      expect(derived).toBeLessThan(400 * MIB);
      // And not merely under it -- a buffered export holds several copies of the
      // payload at peak, on top of the ~140 MiB the process needs anyway.
      expect(derived).toBeLessThanOrEqual(Math.floor(400 * MIB * 0.25));
    });

    it("scales with a larger container instead of staying pinned", () => {
      expect(deriveDefaultLimitBytes(2048 * MIB)).toBeGreaterThan(
        deriveDefaultLimitBytes(400 * MIB),
      );
    });

    it("does not derive a limit too small to be usable", () => {
      // A 128 MiB dev container would otherwise derive 32 MiB and refuse
      // ordinary datasets; below the floor the operator should be choosing.
      expect(deriveDefaultLimitBytes(128 * MIB)).toBe(64 * MIB);
    });

    it("caps the derived value however large the container", () => {
      // Past a point the ceiling stops being a guard against a hostile payload.
      expect(deriveDefaultLimitBytes(64 * 1024 * MIB)).toBe(1024 * MIB);
    });

    it("falls back to a modest default when the limit is unknown", () => {
      // Bare metal, a dev machine, an unconstrained container: nothing is known,
      // and a ceiling that only fires on an enormous payload still beats none.
      expect(deriveDefaultLimitBytes(null)).toBe(256 * MIB);
    });
  });

  describe("detectProcessMemoryLimitBytes", () => {
    it("returns a positive number or null, never a sentinel", () => {
      // cgroup v2 writes the literal "max" and v1 a rounded 2^63 when
      // unconstrained. Deriving a ceiling from 8 exbibytes is the same as having
      // none, so both must read as unknown.
      const limit = detectProcessMemoryLimitBytes();
      if (limit !== null) {
        expect(limit).toBeGreaterThan(0);
        expect(limit).toBeLessThan(Number.MAX_SAFE_INTEGER);
      }
    });
  });

  /**
   * `express.raw` buffers the whole body before the controller, the guards, the
   * authentication lookup and every service ceiling, so this is the earliest and
   * therefore the only limit that can protect the process from an oversized
   * upload. It defaulted to the string "500mb" against a 400 MiB pod.
   */
  describe("the restore ceilings, derived from the measurement", () => {
    /** Memory left for a restore after the ordinary process is reserved. */
    const headroom = (container: number) =>
      container - restoreProcessBaselineBytes(container);

    /**
     * The invariant the whole derivation exists for, at every supported pod size:
     * the modeled peak of what the deployment will admit has to fit the memory it
     * actually has. The old chain could not state this, because the expanded
     * ceiling was a share of the container and the peak was a multiple of the
     * ceiling -- the same constant on both sides.
     */
    it.each([256, 400, 512, 1024, 2048, 8192])(
      "keeps the modeled peak inside the container at %i MiB",
      (containerMib) => {
        const container = containerMib * MIB;
        const expanded = deriveRestoreExpandedLimitBytes(container);
        expect(
          restoreProcessBaselineBytes(container) + restorePeakBytes(expanded),
        ).toBeLessThanOrEqual(container);
      },
    );

    /**
     * The fixed part of the cost is what decides whether a small container can
     * restore at all, and modelling the cost as a bare multiple of the payload
     * hid it: the derivation handed a 200 MiB pod a 6 MiB ceiling whose measured
     * decode needs about 116 MiB against 60 MiB of headroom. Refusing outright is
     * the honest answer, and the one the operator can act on.
     */
    it.each([128, 160, 200])(
      "admits nothing at %i MiB, where the fixed cost alone does not fit",
      (containerMib) => {
        const container = containerMib * MIB;
        expect(deriveRestoreExpandedLimitBytes(container)).toBe(0);
        // Not a rounding artefact: the fixed cost genuinely exceeds the headroom.
        const headroom = container - restoreProcessBaselineBytes(container);
        expect(headroom * RESTORE_HEADROOM_SHARE).toBeLessThanOrEqual(
          MEASURED_PEAK_FIXED_BYTES,
        );
      },
    );

    /**
     * And the other end of the same correction: charging the fixed cost once
     * instead of inside a per-byte multiple gives a big pod a *larger* ceiling
     * than the multiple did (87 MiB -> 101 MiB at 1 GiB), because it was paying
     * that overhead again for every byte.
     */
    it("does not charge the fixed cost per byte on a large container", () => {
      const container = 1024 * MIB;
      const expanded = deriveRestoreExpandedLimitBytes(container);
      expect(expanded).toBeGreaterThan(100 * MIB);
      expect(
        restoreProcessBaselineBytes(container) + restorePeakBytes(expanded),
      ).toBeLessThanOrEqual(container);
    });

    /**
     * A container smaller than the modeled process baseline is left out of the
     * table above deliberately: nothing about a restore can fit there, so the
     * assertion to make is that the derivation says zero rather than that the
     * arithmetic closes. On a 128 MiB pod the baseline alone (140 MiB, the
     * chart's own request) is already over the limit.
     */
    it("has nothing to offer a container below the process baseline", () => {
      const container = 128 * MIB;
      expect(restoreProcessBaselineBytes(container)).toBeGreaterThan(container);
      expect(deriveRestoreExpandedLimitBytes(container)).toBe(0);
    });

    /**
     * And it keeps a real margin over the measurement rather than sitting exactly
     * on it: the measured multiple omits the database phase and rises on smaller
     * artifacts, so a derivation with no slack would be a coin flip.
     */
    it.each([256, 400, 512, 1024])(
      "leaves at least 15%% of margin over the measured cost at %i MiB",
      (containerMib) => {
        const container = containerMib * MIB;
        const expanded = deriveRestoreExpandedLimitBytes(container);
        // The margin lives in the headroom share. What has to hold is that the
        // MEASURED cost of the largest artifact this deployment will admit, plus
        // 15%, still fits the memory left for it -- the measurement covers the
        // decode phases only, so the slack is what the database phase runs in.
        expect(restorePeakBytes(expanded) * 1.15).toBeLessThanOrEqual(
          headroom(container),
        );
      },
    );

    it("keeps the cost model in one place", () => {
      // Slope and fixed part, applied the same way everywhere. A caller
      // re-deriving `slope * expanded` without the fixed term is the defect this
      // model replaced.
      expect(restorePeakBytes(0)).toBe(MEASURED_PEAK_FIXED_BYTES);
      expect(restorePeakBytes(10 * MIB)).toBe(
        Math.ceil(MEASURED_PEAK_SLOPE * 10 * MIB) + MEASURED_PEAK_FIXED_BYTES,
      );
    });

    /**
     * F3R6-005, restated for the new derivation: a usability floor must never win
     * over the safety maximum. `MIN_DERIVED_LIMIT_BYTES` (64 MiB) deliberately
     * does not apply here -- a 256 MiB pod gets 12 MiB, not a floor whose modeled
     * peak exceeds the container.
     */
    it("applies no usability floor", () => {
      expect(deriveRestoreExpandedLimitBytes(256 * MIB)).toBeLessThan(64 * MIB);
      expect(deriveRestoreExpandedLimitBytes(400 * MIB)).toBeLessThan(64 * MIB);
    });

    /**
     * Zero is a real answer, not a failure to compute one: a container smaller
     * than the process baseline has no room for any restore, and the honest number
     * is what turns an OOM kill mid-restore into a 503 naming the lever.
     */
    it("derives zero where no restore fits", () => {
      expect(deriveRestoreExpandedLimitBytes(128 * MIB)).toBe(0);
      expect(resolveRestoreUploadLimitBytes(undefined, 128 * MIB)).toBe(0);
    });

    it("scales with the container rather than being fixed", () => {
      expect(deriveRestoreExpandedLimitBytes(1024 * MIB)).toBeGreaterThan(
        deriveRestoreExpandedLimitBytes(400 * MIB),
      );
    });

    it("caps a very large container, so the ceiling stays a guard", () => {
      expect(deriveRestoreExpandedLimitBytes(64 * 1024 * MIB)).toBe(1024 * MIB);
    });

    /**
     * The wire ceiling IS the expanded ceiling. Two separately derived numbers let
     * the deployment accept a 66 MiB upload whose 100 MiB expanded ceiling it then
     * refused at decompression -- and gzip output is never smaller than what it
     * expands to, so any upload above the expanded ceiling is one this deployment
     * could not decompress even in principle.
     */
    it("refuses on the wire exactly what it could not decompress", () => {
      for (const containerMib of [256, 400, 1024]) {
        const container = containerMib * MIB;
        expect(resolveRestoreUploadLimitBytes(undefined, container)).toBe(
          deriveRestoreExpandedLimitBytes(container),
        );
      }
    });

    /**
     * The lever the docs offer for trading artifact size against concurrency is
     * `BACKUP_RESTORE_EXPANDED_LIMIT`. Reading the *derived* ceiling for the wire
     * limit left it at 27.6 MiB while `gunzip` enforced the operator's 8 MiB, so a
     * 27 MiB upload was accepted and then refused on decompression -- the exact
     * accept-then-refuse defect the single-ceiling change was made to close, one
     * level along, and the same class as F3R7-002.
     */
    it("follows an operator's expanded limit onto the wire", () => {
      const container = 400 * MIB;
      expect(resolveRestoreUploadLimitBytes(undefined, container, "8mb")).toBe(
        8 * MIB,
      );
      // And upwards too, where the operator raised it on a pod that can take it.
      expect(
        resolveRestoreUploadLimitBytes(undefined, 4096 * MIB, "300mb"),
      ).toBe(300 * MIB);
    });

    /**
     * The startup warning has to be measured against the ceiling in force for the
     * same reason: an operator who lowered the expanded limit and left
     * `BACKUP_RESTORE_LIMIT` alone is exactly the one it exists to tell.
     */
    it("warns about an upload limit above the operator's own expanded limit", () => {
      const onWarn = jest.fn();
      warnIfRestoreUploadLimitIsUnsafe(
        27 * MIB,
        "27mb",
        onWarn,
        400 * MIB,
        "8mb",
      );
      expect(onWarn).toHaveBeenCalledTimes(1);
      expect(onWarn.mock.calls[0][0]).toContain("8MiB");
    });

    it("honours an explicit operator value", () => {
      expect(resolveRestoreUploadLimitBytes("64mb", 400 * MIB)).toBe(64 * MIB);
      expect(resolveRestoreExpandedLimitBytes("64mb", 400 * MIB)).toBe(
        64 * MIB,
      );
    });

    /**
     * With no visible limit nothing can be derived, so the fallback is a peak
     * *budget* the cost model is solved against, rather than an artifact ceiling
     * picked directly. The old fixed 256 MiB fallback modeled a 2.3 GiB peak
     * without saying so.
     */
    it("falls back to a coherent budget when the container limit is unknown", () => {
      const expanded = resolveRestoreUploadLimitBytes(undefined, null);
      expect(expanded).toBeGreaterThan(0);
      // Whatever it works out to, the model's own cost for it fits the budget
      // the fallback names -- which is the property, not the number.
      expect(restorePeakBytes(expanded)).toBeLessThanOrEqual(1024 * MIB);
    });

    it("spends only the headroom share it says it does", () => {
      const container = 400 * MIB;
      expect(
        restorePeakBytes(deriveRestoreExpandedLimitBytes(container)),
      ).toBeLessThanOrEqual(
        Math.ceil(headroom(container) * RESTORE_HEADROOM_SHARE),
      );
    });
  });

  describe("warnIfRestoreUploadLimitIsCramped", () => {
    it("warns when the derived limit is below the usable threshold", () => {
      const onWarn = jest.fn();
      const limit = resolveRestoreUploadLimitBytes(undefined, 128 * MIB);
      warnIfRestoreUploadLimitIsCramped(limit, undefined, onWarn);
      expect(onWarn).toHaveBeenCalledTimes(1);
      expect(String(onWarn.mock.calls[0][0])).toMatch(/refused|memory/i);
    });

    it("stays quiet on a roomy container", () => {
      const onWarn = jest.fn();
      const limit = resolveRestoreUploadLimitBytes(undefined, 400 * MIB);
      warnIfRestoreUploadLimitIsCramped(limit, undefined, onWarn);
      expect(onWarn).not.toHaveBeenCalled();
    });

    it("stays quiet when the operator set the value themselves", () => {
      // A cramped limit the operator chose is their decision, not a surprise.
      const onWarn = jest.fn();
      warnIfRestoreUploadLimitIsCramped(8 * MIB, "8mb", onWarn);
      expect(onWarn).not.toHaveBeenCalled();
    });
  });

  describe("warnIfLimitExceedsMemory", () => {
    it("warns when a configured ceiling cannot protect the process", () => {
      const onWarn = jest.fn();
      warnIfLimitExceedsMemory(
        "BACKUP_EXPORT_BUFFER_LIMIT",
        2048 * MIB,
        onWarn,
        400 * MIB,
      );
      expect(onWarn).toHaveBeenCalledTimes(1);
      const message = onWarn.mock.calls[0][0] as string;
      // Names the variable, both numbers, and what will actually happen -- an
      // operator should not have to infer "OOM-killed" from "check your config".
      expect(message).toContain("BACKUP_EXPORT_BUFFER_LIMIT");
      expect(message).toContain("2048MiB");
      expect(message).toContain("400MiB");
      expect(message).toMatch(/OOM-killed/);
    });

    it("stays quiet for a limit the container can absorb", () => {
      const onWarn = jest.fn();
      warnIfLimitExceedsMemory("X", 64 * MIB, onWarn, 400 * MIB);
      expect(onWarn).not.toHaveBeenCalled();
    });

    it("stays quiet when there is no memory limit to compare against", () => {
      const onWarn = jest.fn();
      warnIfLimitExceedsMemory("X", 8192 * MIB, onWarn, null);
      expect(onWarn).not.toHaveBeenCalled();
    });

    /**
     * A derivation must never warn about itself: the threshold is the number the
     * derivation produced, in the units the operator sets. Checking a wire limit
     * against a share it was never derived from would warn on every deployment,
     * which is how this check came to be missing from `main.ts` rather than merely
     * unwired.
     */
    it("does not warn about a limit it derived itself", () => {
      const onWarn = jest.fn();
      const container = 400 * MIB;
      warnIfRestoreUploadLimitIsUnsafe(
        resolveRestoreUploadLimitBytes(undefined, container),
        undefined,
        onWarn,
        container,
      );
      expect(onWarn).not.toHaveBeenCalled();
    });

    it("still warns about an upload override the container cannot decompress", () => {
      const onWarn = jest.fn();
      const container = 400 * MIB;
      warnIfRestoreUploadLimitIsUnsafe(2048 * MIB, "2gb", onWarn, container);
      expect(onWarn).toHaveBeenCalledTimes(1);
      const message = onWarn.mock.calls[0][0] as string;
      expect(message).toContain("BACKUP_RESTORE_LIMIT");
      // The figure suggested is the derived ceiling, which the operator can paste
      // back -- not a share of the container, which would OOM-kill the pod.
      expect(message).toContain(
        `${Math.round(deriveRestoreExpandedLimitBytes(container) / MIB)}MiB`,
      );
    });

    it("stays quiet when there is no container limit to compare against", () => {
      const onWarn = jest.fn();
      warnIfRestoreUploadLimitIsUnsafe(8192 * MIB, "8gb", onWarn, null);
      // Unknown means unknown: 8 GiB may be correct on a bare-metal host, and
      // the fallback ceiling is a judgement about a machine nobody measured --
      // not a threshold to hold an operator's own number against. This test
      // asserted the opposite of its own name and comment for one commit.
      expect(onWarn).not.toHaveBeenCalled();
    });
  });
});
