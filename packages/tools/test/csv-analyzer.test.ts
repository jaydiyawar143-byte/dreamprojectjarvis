import { describe, it, expect, beforeEach } from "vitest";
import { CsvAnalyzerTool } from "../src/tools/csv-analyzer.js";

const SAMPLE_CSV = `name,age,score,city
Alice,30,95.5,New York
Bob,25,87.3,London
Charlie,35,92.1,Paris
Diana,28,88.9,Berlin
Eve,32,76.4,Tokyo`;

const MALFORMED_CSV = `name,age
"Alice",30
Bob,25,extra
Charlie`;

const NUMERIC_CSV = `value
100
200
300
400
500`;

describe("CsvAnalyzerTool", () => {
  let tool: CsvAnalyzerTool;

  beforeEach(() => {
    tool = new CsvAnalyzerTool();
  });

  describe("metadata", () => {
    it("has correct id", () => {
      expect(tool.id).toBe("data.csv.analyze");
    });

    it("has READ_ONLY risk", () => {
      expect(tool.risk).toBe("READ_ONLY");
    });

    it("does not require approval", () => {
      expect(tool.requiresApproval).toBe(false);
    });

    it("requires read permission", () => {
      expect(tool.requiredPermissions).toEqual(["read"]);
    });
  });

  describe("validate", () => {
    it("passes with valid inspect operation", () => {
      expect(tool.validate({ operation: "inspect", data: "a,b\n1,2" })).toBe(true);
    });

    it("fails without operation", () => {
      expect(tool.validate({ data: "a,b\n1,2" })).toBe(false);
    });

    it("fails with invalid operation", () => {
      expect(tool.validate({ operation: "hack", data: "a,b\n1,2" })).toBe(false);
    });

    it("passes with valid operations", () => {
      for (const op of ["inspect", "rowCount", "stats", "filter", "aggregate", "summary", "anomalies"]) {
        expect(tool.validate({ operation: op, data: "a,b\n1,2" })).toBe(true);
      }
    });

    it("fails with data exceeding max size", () => {
      expect(tool.validate({ operation: "inspect", data: "x".repeat(50_000_001) })).toBe(false);
    });

    it("fails with invalid aggregation function", () => {
      expect(
        tool.validate({
          operation: "aggregate",
          data: "a,b\n1,2",
          aggregationColumn: "a",
          aggregationFunction: "hack",
        })
      ).toBe(false);
    });

    it("passes with valid aggregation function", () => {
      for (const fn of ["sum", "avg", "min", "max", "count", "distinct"]) {
        expect(
          tool.validate({
            operation: "aggregate",
            data: "a,b\n1,2",
            aggregationColumn: "a",
            aggregationFunction: fn,
          })
        ).toBe(true);
      }
    });
  });

  describe("inspect operation", () => {
    it("returns columns and row count", async () => {
      const result = await tool.execute(
        { operation: "inspect", data: SAMPLE_CSV },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const data = result.data as { columns: Array<{ name: string; index: number; sampleValues: string[] }>; columnCount: number; rowCount: number };
      expect(data.columnCount).toBe(4);
      expect(data.rowCount).toBe(5);
      expect(data.columns[0]!.name).toBe("name");
      expect(data.columns[0]!.sampleValues).toContain("Alice");
    });

    it("handles empty data", async () => {
      const result = await tool.execute(
        { operation: "inspect", data: "" },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const data = result.data as { columnCount: number; rowCount: number };
      expect(data.rowCount).toBe(0);
    });
  });

  describe("rowCount operation", () => {
    it("returns correct counts", async () => {
      const result = await tool.execute(
        { operation: "rowCount", data: SAMPLE_CSV },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const data = result.data as { rowCount: number; columnCount: number };
      expect(data.rowCount).toBe(5);
      expect(data.columnCount).toBe(4);
    });
  });

  describe("stats operation", () => {
    it("computes numeric statistics", async () => {
      const result = await tool.execute(
        { operation: "stats", data: SAMPLE_CSV, columns: ["age"] },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const data = result.data as { stats: Record<string, { count: number; mean: number; min: number; max: number }> };
      expect(data.stats.age).toBeDefined();
      expect(data.stats.age.count).toBe(5);
      expect(data.stats.age.min).toBe(25);
      expect(data.stats.age.max).toBe(35);
    });

    it("analyzes all columns by default", async () => {
      const result = await tool.execute(
        { operation: "stats", data: SAMPLE_CSV },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const data = result.data as { stats: Record<string, unknown> };
      expect(Object.keys(data.stats)).toHaveLength(4);
    });
  });

  describe("filter operation", () => {
    it("filters rows by column value", async () => {
      const result = await tool.execute(
        { operation: "filter", data: SAMPLE_CSV, filterColumn: "city", filterValue: "London" },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const data = result.data as { matchCount: number; rows: string[][] };
      expect(data.matchCount).toBe(1);
      expect(data.rows[0]![0]).toBe("Bob");
    });

    it("returns error without filter params", async () => {
      const result = await tool.execute(
        { operation: "filter", data: SAMPLE_CSV },
        { userId: "user-1" }
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("required");
    });

    it("returns error for non-existent column", async () => {
      const result = await tool.execute(
        { operation: "filter", data: SAMPLE_CSV, filterColumn: "nonexistent", filterValue: "x" },
        { userId: "user-1" }
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("aggregate operation", () => {
    it("computes sum", async () => {
      const result = await tool.execute(
        { operation: "aggregate", data: NUMERIC_CSV, aggregationColumn: "value", aggregationFunction: "sum" },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const data = result.data as { result: number };
      expect(data.result).toBe(1500);
    });

    it("computes avg", async () => {
      const result = await tool.execute(
        { operation: "aggregate", data: NUMERIC_CSV, aggregationColumn: "value", aggregationFunction: "avg" },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const data = result.data as { result: number };
      expect(data.result).toBe(300);
    });

    it("computes min and max", async () => {
      const minResult = await tool.execute(
        { operation: "aggregate", data: NUMERIC_CSV, aggregationColumn: "value", aggregationFunction: "min" },
        { userId: "user-1" }
      );
      expect((minResult.data as { result: number }).result).toBe(100);

      const maxResult = await tool.execute(
        { operation: "aggregate", data: NUMERIC_CSV, aggregationColumn: "value", aggregationFunction: "max" },
        { userId: "user-1" }
      );
      expect((maxResult.data as { result: number }).result).toBe(500);
    });

    it("computes count", async () => {
      const result = await tool.execute(
        { operation: "aggregate", data: SAMPLE_CSV, aggregationColumn: "name", aggregationFunction: "count" },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const data = result.data as { result: number };
      expect(data.result).toBe(5);
    });

    it("computes distinct", async () => {
      const result = await tool.execute(
        { operation: "aggregate", data: SAMPLE_CSV, aggregationColumn: "city", aggregationFunction: "distinct" },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const data = result.data as { result: number };
      expect(data.result).toBe(5);
    });

    it("returns error without required params", async () => {
      const result = await tool.execute(
        { operation: "aggregate", data: SAMPLE_CSV },
        { userId: "user-1" }
      );
      expect(result.success).toBe(false);
    });
  });

  describe("summary operation", () => {
    it("returns per-column summaries", async () => {
      const result = await tool.execute(
        { operation: "summary", data: SAMPLE_CSV },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const data = result.data as { totalRows: number; totalColumns: number; columns: Array<{ name: string; isNumeric: boolean }> };
      expect(data.totalRows).toBe(5);
      expect(data.totalColumns).toBe(4);
      expect(data.columns[0]!.name).toBe("name");
      expect(data.columns[0]!.isNumeric).toBe(false);
    });
  });

  describe("anomalies operation", () => {
    it("detects anomalies in numeric data", async () => {
      const csv = `value\n1\n2\n3\n4\n500`;
      const result = await tool.execute(
        { operation: "anomalies", data: csv },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const data = result.data as { anomalies: Record<string, { anomalyCount: number }> };
      expect(data.anomalies.value).toBeDefined();
      expect(data.anomalies.value.anomalyCount).toBeGreaterThanOrEqual(1);
    });

    it("returns empty for uniform data", async () => {
      const csv = `value\n5\n5\n5\n5\n5`;
      const result = await tool.execute(
        { operation: "anomalies", data: csv },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const data = result.data as { anomalies: Record<string, { anomalyCount: number }> };
      expect(data.anomalies.value.anomalyCount).toBe(0);
    });
  });

  describe("formula injection protection", () => {
    it("escapes formula prefixes in output", async () => {
      const maliciousCsv = `name,value\n=SUM(A1:A10),100\n+CMD,200\n-DELETE,300`;
      const result = await tool.execute(
        { operation: "inspect", data: maliciousCsv },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const data = result.data as { columns: Array<{ sampleValues: string[] }> };
      for (const col of data.columns) {
        for (const val of col.sampleValues) {
          if (val.startsWith("=") || val.startsWith("+") || val.startsWith("-")) {
            expect(val.startsWith("'")).toBe(true);
          }
        }
      }
    });
  });

  describe("malformed CSV", () => {
    it("handles malformed CSV gracefully", async () => {
      const result = await tool.execute(
        { operation: "rowCount", data: MALFORMED_CSV },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
    });
  });

  describe("large CSV", () => {
    it("handles large CSV within limits", async () => {
      const rows = Array.from({ length: 1000 }, (_, i) => `row${i},${i},${i * 1.5}`).join("\n");
      const csv = "name,id,value\n" + rows;
      const result = await tool.execute(
        { operation: "rowCount", data: csv },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const data = result.data as { rowCount: number };
      expect(data.rowCount).toBe(1000);
    });
  });

  describe("no data", () => {
    it("returns guidance when no data provided for inspect", async () => {
      const result = await tool.execute(
        { operation: "inspect" },
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
    });

    it("returns error when no data for non-inspect ops", async () => {
      const result = await tool.execute(
        { operation: "rowCount" },
        { userId: "user-1" }
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("required");
    });
  });
});
