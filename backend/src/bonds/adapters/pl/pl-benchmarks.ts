import { BenchmarkDefinition } from "../../domain/benchmark";

export const PL_NBP_REFERENCE = "PL_NBP_REFERENCE";
export const PL_CPI_GUS_YOY = "PL_CPI_GUS_YOY";

/** The Polish series the retail savings bonds reference. */
export const plBenchmarks: readonly BenchmarkDefinition[] = [
  { id: PL_NBP_REFERENCE, kind: "STEP", publisher: "NBP" },
  { id: PL_CPI_GUS_YOY, kind: "MONTHLY", publisher: "GUS" },
];
