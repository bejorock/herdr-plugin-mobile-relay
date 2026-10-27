export type ElicitationOption = { const: string; title: string; description?: string };

export type ElicitationProperty =
  | { type: "string" | "number" | "integer" | "boolean"; title?: string; description?: string; enum?: string[]; oneOf?: ElicitationOption[] }
  | { type: "array"; title?: string; description?: string; items: { type: "string"; enum?: string[]; oneOf?: ElicitationOption[] }; minItems?: number; maxItems?: number };

export interface ElicitationSchema {
  properties?: Record<string, ElicitationProperty>;
  required?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
}

function validChoice(value: unknown): value is ElicitationOption {
  return isRecord(value) &&
    typeof value.const === "string" && value.const.length > 0 && value.const.length <= 128 &&
    typeof value.title === "string" && value.title.length > 0 && value.title.length <= 128 &&
    (value.description === undefined || (typeof value.description === "string" && value.description.length <= 512));
}

function validChoices(value: unknown): boolean {
  return value === undefined || (
    Array.isArray(value) && value.length > 0 && value.length <= 32 &&
    value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128) &&
    new Set(value).size === value.length
  );
}

function validOneOf(value: unknown): boolean {
  return value === undefined || (
    Array.isArray(value) && value.length > 0 && value.length <= 32 &&
    value.every(validChoice) && new Set(value.map((item) => item.const)).size === value.length
  );
}

/** Bounded ACP form schemas accepted from local hook adapters. */
export function isValidElicitationSchema(value: unknown): value is ElicitationSchema {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.length > 16 || !value.required.every(validName) || new Set(value.required).size !== value.required.length)) return false;
  if (value.properties === undefined) return true;
  if (!isRecord(value.properties) || Object.keys(value.properties).length > 16) return false;
  return Object.entries(value.properties).every(([name, property]) => {
    if (!validName(name) || !isRecord(property)) return false;
    if (property.title !== undefined && (typeof property.title !== "string" || property.title.length > 128)) return false;
    if (property.description !== undefined && (typeof property.description !== "string" || property.description.length > 512)) return false;
    if (property.type === "string" || property.type === "number" || property.type === "integer" || property.type === "boolean") {
      return validChoices(property.enum) && validOneOf(property.oneOf);
    }
    if (property.type !== "array" || !isRecord(property.items) || property.items.type !== "string") return false;
    if (!validChoices(property.items.enum) || !validOneOf(property.items.oneOf)) return false;
    const minItems = property.minItems;
    const maxItems = property.maxItems;
    if (minItems !== undefined && (!Number.isSafeInteger(minItems) || typeof minItems !== "number" || minItems < 0 || minItems > 32)) return false;
    if (maxItems !== undefined && (!Number.isSafeInteger(maxItems) || typeof maxItems !== "number" || maxItems < 0 || maxItems > 32)) return false;
    return typeof minItems !== "number" || typeof maxItems !== "number" || minItems <= maxItems;
  });
}

function allowedValues(property: ElicitationProperty): Set<string> | null {
  const choices = property.type === "array" ? property.items : property;
  if (choices.enum) return new Set(choices.enum);
  if (choices.oneOf) return new Set(choices.oneOf.map((item) => item.const));
  return null;
}

function matchesProperty(value: unknown, property: ElicitationProperty): boolean {
  if (property.type === "string") {
    if (typeof value !== "string") return false;
    const allowed = allowedValues(property);
    return !allowed || allowed.has(value);
  }
  if (property.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (property.type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (property.type === "boolean") return typeof value === "boolean";
  if (property.type !== "array") return false;
  if (!Array.isArray(value) || value.length > 32 || !value.every((item) => typeof item === "string") || new Set(value).size !== value.length) return false;
  if (property.minItems !== undefined && value.length < property.minItems) return false;
  if (property.maxItems !== undefined && value.length > property.maxItems) return false;
  const allowed = allowedValues(property);
  return !allowed || value.every((item) => allowed.has(item));
}

/** Validate an ACP elicitation response before it consumes a one-shot local interaction. */
export function isValidElicitationResponse(schema: ElicitationSchema | undefined, value: unknown): boolean {
  if (!isRecord(value) || typeof value.action !== "string") return false;
  if (value.action === "decline" || value.action === "cancel") return true;
  if (value.action !== "accept" || !isRecord(value.content)) return false;
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  for (const name of required) if (!(name in value.content)) return false;
  return Object.entries(value.content).every(([name, item]) => {
    const property = properties[name];
    return property !== undefined && matchesProperty(item, property);
  });
}
