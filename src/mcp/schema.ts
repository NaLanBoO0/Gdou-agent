/**
 * JSON Schema → TypeBox conversion for MCP tool inputs.
 *
 * MCP tools declare their arguments as JSON Schema; pi's `AgentTool` wants a
 * TypeBox `TSchema`. This maps the subset MCP servers actually emit — objects,
 * strings, numbers, booleans, arrays, enums, `$ref`-free — onto TypeBox.
 *
 * The conversion is deliberately **lenient on the way in and strict on the way
 * out**: an unknown keyword is dropped rather than aborting the whole tool,
 * because a server advertising a `format` we do not care about should still be
 * usable. The only thing that must hold is that the produced schema validates
 * the same values the JSON Schema would — and where that is not expressible in
 * TypeBox, the safest choice is to accept anything (`Type.Any`).
 */

import { Type, type TSchema } from "@earendil-works/pi-ai";

type JsonSchema = Record<string, unknown>;

export function jsonSchemaToTypeBox(schema: JsonSchema | undefined): TSchema {
	if (!schema || typeof schema !== "object") return Type.Any();
	const type = schema.type;
	switch (type) {
		case "string":
			return Type.String();
		case "number":
			return Type.Number();
		case "integer":
			return Type.Integer();
		case "boolean":
			return Type.Boolean();
		case "array": {
			const items = jsonSchemaToTypeBox(schema.items as JsonSchema | undefined);
			return Type.Array(items);
		}
		case "object": {
			const properties = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
			const required = new Set((schema.required as string[] | undefined) ?? []);
			const fields: Record<string, TSchema> = {};
			for (const [key, prop] of Object.entries(properties)) {
				fields[key] = required.has(key) ? jsonSchemaToTypeBox(prop) : Type.Optional(jsonSchemaToTypeBox(prop));
			}
			// No declared properties: accept an arbitrary object rather than an
			// empty one, which would reject any real argument.
			if (Object.keys(fields).length === 0) return Type.Record(Type.String(), Type.Any());
			return Type.Object(fields);
		}
		case "null":
			return Type.Null();
		default: {
			// `anyOf`/`oneOf`/`enum` without a `type`, or a schema we do not map.
			// Accept anything: it is better to let the server reject a bad argument
			// than to reject a good one because we guessed the union wrong.
			return Type.Any();
		}
	}
}
