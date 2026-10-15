// Builds the DAX queries behind the measure editor. Pure functions.

/** `'Table name'` (single quotes doubled). */
export function quoteTable(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** `[Column]` (closing brackets doubled). */
export function quoteBracket(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

export function columnRef(table: string, column: string): string {
  return `${quoteTable(table)}${quoteBracket(column)}`;
}

/** The measure's own name must not collide with the model: the draft is evaluated under this temporary name. */
export const DRAFT_NAME = "BIForge draft measure";

function define(table: string, expression: string): string {
  return `DEFINE MEASURE ${quoteTable(table)}${quoteBracket(DRAFT_NAME)} = ${expression}`;
}

/** Value of a measure expression with no filters. */
export function valueQuery(table: string, expression: string): string {
  return `${define(table, expression)}\nEVALUATE ROW("Value", ${quoteBracket(DRAFT_NAME)})`;
}

/** The measure split by the values of one column. */
export function byColumnQuery(table: string, expression: string, byTable: string, byColumn: string): string {
  const col = columnRef(byTable, byColumn);
  return `${define(table, expression)}
EVALUATE SUMMARIZECOLUMNS(${col}, "Value", ${quoteBracket(DRAFT_NAME)})
ORDER BY ${col}`;
}
