import { BaseTool } from "../base-tool.js";
import type { ToolResult, ToolContext } from "@jarvis/core";

const MAX_ROWS = 100_000;
const MAX_COLUMNS = 200;
const MAX_CELL_LENGTH = 10_000;
const MAX_FILE_SIZE_BYTES = 50_000_000;

const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

export interface CsvAnalysisOptions {
  operation: string;
  data?: string;
  columns?: string[];
  filterColumn?: string;
  filterValue?: string;
  aggregationColumn?: string;
  aggregationFunction?: string;
}

function escapeCsvField(field: string): string {
  if (
    FORMULA_PREFIXES.some((p) => field.startsWith(p))
  ) {
    return "'" + field;
  }
  return field;
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseCsvLine(lines[0]!);
  const rows: string[][] = [];

  for (let i = 1; i < lines.length && i <= MAX_ROWS + 1; i++) {
    rows.push(parseCsvLine(lines[i]!));
  }

  return { headers, rows };
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function sanitizeCellValue(value: string): string {
  let sanitized = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
  if (sanitized.length > MAX_CELL_LENGTH) {
    sanitized = sanitized.slice(0, MAX_CELL_LENGTH) + "...";
  }
  return escapeCsvField(sanitized);
}

function computeStats(values: number[]): {
  count: number;
  sum: number;
  mean: number;
  min: number;
  max: number;
  median: number;
  stdDev: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = count > 0 ? sum / count : 0;
  const min = count > 0 ? sorted[0]! : 0;
  const max = count > 0 ? sorted[count - 1]! : 0;
  const median =
    count % 2 === 0
      ? (sorted[count / 2 - 1]! + sorted[count / 2]!) / 2
      : sorted[Math.floor(count / 2)]!;
  const variance =
    count > 1
      ? sorted.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (count - 1)
      : 0;
  const stdDev = Math.sqrt(variance);

  return { count, sum, mean, min, max, median, stdDev };
}

function detectAnomalies(values: number[]): number[] {
  if (values.length < 3) return [];
  const stats = computeStats(values);
  if (stats.stdDev === 0) return [];
  const threshold = 1.5;
  return values
    .map((v, i) => (Math.abs(v - stats.mean) > threshold * stats.stdDev ? i : -1))
    .filter((i) => i >= 0);
}

export class CsvAnalyzerTool extends BaseTool {
  constructor() {
    super(
      "data.csv.analyze",
      "CSV Data Analyzer",
      "Analyze CSV data: inspect columns, count rows, compute statistics, filter, aggregate, and detect anomalies. No code execution — pure analysis only.",
      "research",
      [
        {
          name: "operation",
          type: "string",
          description:
            "Analysis operation: inspect, rowCount, stats, filter, aggregate, summary, anomalies",
          required: true,
        },
        {
          name: "data",
          type: "string",
          description: "Raw CSV data as a string",
          required: false,
        },
        {
          name: "columns",
          type: "array",
          description: "Column names to focus on for stats/aggregation",
          required: false,
        },
        {
          name: "filterColumn",
          type: "string",
          description: "Column name to filter by",
          required: false,
        },
        {
          name: "filterValue",
          type: "string",
          description: "Value to match in filterColumn",
          required: false,
        },
        {
          name: "aggregationColumn",
          type: "string",
          description: "Column to aggregate",
          required: false,
        },
        {
          name: "aggregationFunction",
          type: "string",
          description: "Aggregation function: sum, avg, min, max, count, distinct",
          required: false,
        },
      ],
      false,
      ["read"],
      "READ_ONLY",
      "1.0.0",
      true
    );
  }

  validate(params: Record<string, unknown>): boolean {
    if (!super.validate(params)) return false;

    const operation = params.operation;
    const validOps = ["inspect", "rowCount", "stats", "filter", "aggregate", "summary", "anomalies"];
    if (typeof operation !== "string" || !validOps.includes(operation)) return false;

    if (params.data !== undefined && typeof params.data !== "string") return false;
    if (params.data && (params.data as string).length > MAX_FILE_SIZE_BYTES) return false;

    if (params.columns !== undefined) {
      if (!Array.isArray(params.columns)) return false;
      if (params.columns.length > MAX_COLUMNS) return false;
    }

    if (params.aggregationFunction !== undefined) {
      const validFns = ["sum", "avg", "min", "max", "count", "distinct"];
      if (!validFns.includes(params.aggregationFunction as string)) return false;
    }

    return true;
  }

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolResult> {
    const operation = params.operation as string;
    const csvData = typeof params.data === "string" ? params.data : undefined;

    if (csvData === undefined && operation !== "inspect") {
      return this.failure("CSV data is required for this operation");
    }

    if (csvData === undefined || csvData.length === 0) {
      if (operation === "inspect") {
        return this.success(
          { columns: [], columnCount: 0, rowCount: 0 },
          { toolId: this.id }
        );
      }
      return this.failure("CSV data is required for this operation");
    }

    try {
      const { headers, rows } = parseCsv(csvData);

      if (headers.length > MAX_COLUMNS) {
        return this.failure(`Too many columns: ${headers.length} (max ${MAX_COLUMNS})`);
      }

      const sanitizedHeaders = headers.map(sanitizeCellValue);

      switch (operation) {
        case "inspect":
          return this.success(
            {
              columns: sanitizedHeaders.map((h, i) => ({
                name: h,
                index: i,
                sampleValues: rows.slice(0, 5).map((r) => sanitizeCellValue(r[i] ?? "")),
              })),
              columnCount: sanitizedHeaders.length,
              rowCount: rows.length,
            },
            { toolId: this.id }
          );

        case "rowCount":
          return this.success(
            { rowCount: rows.length, columnCount: headers.length },
            { toolId: this.id }
          );

        case "stats":
          return this.executeStats(headers, rows, params.columns as string[] | undefined);

        case "filter":
          return this.executeFilter(headers, rows, params.filterColumn as string, params.filterValue as string);

        case "aggregate":
          return this.executeAggregate(
            headers,
            rows,
            params.aggregationColumn as string,
            params.aggregationFunction as string
          );

        case "summary":
          return this.executeSummary(headers, rows);

        case "anomalies":
          return this.executeAnomalies(headers, rows, params.columns as string[] | undefined);

        default:
          return this.failure(`Unknown operation: ${operation}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Analysis failed";
      return this.failure(`CSV analysis error: ${message}`);
    }
  }

  private executeStats(
    headers: string[],
    rows: string[][],
    targetColumns?: string[]
  ): ToolResult {
    const columnsToAnalyze = targetColumns ?? headers;
    const stats: Record<string, unknown> = {};

    for (const col of columnsToAnalyze) {
      const colIdx = headers.indexOf(col);
      if (colIdx === -1) continue;

      const numericValues: number[] = [];
      let nonNumeric = 0;
      for (const row of rows) {
        const val = row[colIdx] ?? "";
        const num = Number(val);
        if (!isNaN(num) && val.trim() !== "") {
          numericValues.push(num);
        } else {
          nonNumeric++;
        }
      }

      if (numericValues.length > 0) {
        stats[col] = {
          ...computeStats(numericValues),
          nonNumericCount: nonNumeric,
        };
      } else {
        stats[col] = {
          type: "non-numeric",
          nonNumericCount: nonNumeric + rows.length,
          uniqueValues: [...new Set(rows.map((r) => r[colIdx] ?? ""))].slice(0, 20),
        };
      }
    }

    return this.success(
      { stats, analyzedColumns: Object.keys(stats).length, totalRows: rows.length },
      { toolId: this.id }
    );
  }

  private executeFilter(
    headers: string[],
    rows: string[][],
    filterColumn?: string,
    filterValue?: string
  ): ToolResult {
    if (!filterColumn || filterValue === undefined) {
      return this.failure("filterColumn and filterValue are required");
    }

    const colIdx = headers.indexOf(filterColumn);
    if (colIdx === -1) {
      return this.failure(`Column "${filterColumn}" not found`);
    }

    const filtered = rows.filter((row) => (row[colIdx] ?? "") === filterValue);
    const limited = filtered.slice(0, 1000);

    return this.success(
      {
        headers: headers.map(sanitizeCellValue),
        rows: limited.map((row) => row.map(sanitizeCellValue)),
        matchCount: filtered.length,
        returnedCount: limited.length,
        truncated: filtered.length > 1000,
      },
      { toolId: this.id }
    );
  }

  private executeAggregate(
    headers: string[],
    rows: string[][],
    aggregationColumn?: string,
    aggregationFunction?: string
  ): ToolResult {
    if (!aggregationColumn || !aggregationFunction) {
      return this.failure("aggregationColumn and aggregationFunction are required");
    }

    const colIdx = headers.indexOf(aggregationColumn);
    if (colIdx === -1) {
      return this.failure(`Column "${aggregationColumn}" not found`);
    }

    const numericValues: number[] = [];
    const allValues: string[] = [];
    for (const row of rows) {
      const val = row[colIdx] ?? "";
      allValues.push(val);
      const num = Number(val);
      if (!isNaN(num) && val.trim() !== "") numericValues.push(num);
    }

    let result: unknown;
    switch (aggregationFunction) {
      case "sum":
        result = numericValues.reduce((a, b) => a + b, 0);
        break;
      case "avg":
        result = numericValues.length > 0 ? numericValues.reduce((a, b) => a + b, 0) / numericValues.length : 0;
        break;
      case "min":
        result = numericValues.length > 0 ? Math.min(...numericValues) : null;
        break;
      case "max":
        result = numericValues.length > 0 ? Math.max(...numericValues) : null;
        break;
      case "count":
        result = rows.length;
        break;
      case "distinct":
        result = new Set(allValues).size;
        break;
      default:
        return this.failure(`Unknown aggregation function: ${aggregationFunction}`);
    }

    return this.success(
      {
        column: aggregationColumn,
        function: aggregationFunction,
        result,
        rowCount: rows.length,
        numericCount: numericValues.length,
      },
      { toolId: this.id }
    );
  }

  private executeSummary(headers: string[], rows: string[][]): ToolResult {
    const columnSummaries = headers.map((col, i) => {
      const values = rows.map((r) => r[i] ?? "");
      const nonEmpty = values.filter((v) => v.trim() !== "");
      const numericValues = values
        .map(Number)
        .filter((n) => !isNaN(n));
      const unique = new Set(values);

      return {
        name: sanitizeCellValue(col),
        totalRows: rows.length,
        nonEmptyCount: nonEmpty.length,
        uniqueCount: unique.size,
        isNumeric: numericValues.length > rows.length * 0.5,
        ...(numericValues.length > 0
          ? { numericStats: computeStats(numericValues) }
          : {}),
        sampleValues: [...unique].slice(0, 5).map(sanitizeCellValue),
      };
    });

    return this.success(
      {
        totalRows: rows.length,
        totalColumns: headers.length,
        columns: columnSummaries,
      },
      { toolId: this.id }
    );
  }

  private executeAnomalies(
    headers: string[],
    rows: string[][],
    targetColumns?: string[]
  ): ToolResult {
    const columnsToCheck = targetColumns ?? headers;
    const anomalies: Record<string, unknown> = {};

    for (const col of columnsToCheck) {
      const colIdx = headers.indexOf(col);
      if (colIdx === -1) continue;

      const numericValues: number[] = [];
      for (const row of rows) {
        const num = Number(row[colIdx] ?? "");
        if (!isNaN(num)) numericValues.push(num);
      }

      if (numericValues.length >= 3) {
        const anomalyIndices = detectAnomalies(numericValues);
        anomalies[col] = {
          anomalyCount: anomalyIndices.length,
          anomalies: anomalyIndices.slice(0, 10).map((i) => ({
            rowIndex: i,
            value: numericValues[i],
          })),
          stats: computeStats(numericValues),
        };
      }
    }

    return this.success(
      { anomalies, checkedColumns: Object.keys(anomalies).length },
      { toolId: this.id }
    );
  }
}
