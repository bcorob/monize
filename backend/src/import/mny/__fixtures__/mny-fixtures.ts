import { readFileSync } from "fs";
import { join } from "path";

/**
 * Test-only helpers for the committed `.mny` sample files. See README.md in
 * this directory for provenance and licensing.
 */

export interface MnyFixture {
  /** Bare file name inside this directory. */
  readonly file: string;
  /** Password needed to open the file, or undefined when none is required. */
  readonly password?: string;
  /** Number of user tables `mdb-reader` reports for the decrypted file. */
  readonly tableCount: number;
}

const FIXTURES = {
  money2001: { file: "money2001.mny", tableCount: 66 },
  money2001Pwd: { file: "money2001-pwd.mny", tableCount: 66 },
  money2002: { file: "money2002.mny", tableCount: 86 },
  money2008: { file: "money2008.mny", tableCount: 83 },
  money2008Pwd: {
    file: "money2008-pwd.mny",
    password: "Test12345",
    tableCount: 83,
  },
  sampleCdRedemption: {
    file: "sample-cd-redemption.mny",
    tableCount: 83,
  },
} as const;

export type MnyFixtureName = keyof typeof FIXTURES;

export const MNY_FIXTURES: Record<MnyFixtureName, MnyFixture> = FIXTURES;

/**
 * Reads a fixture into a fresh buffer. Always call this per assertion --
 * `decryptMsisamInPlace` takes ownership of the buffer it is handed.
 */
export function readMnyFixture(name: MnyFixtureName): Buffer {
  return readFileSync(join(__dirname, MNY_FIXTURES[name].file));
}
