'use strict';

/**
 * Small JSON Schema validator for the pinned provider contracts in
 * tests/contract/specs (no dependency). It covers the keywords those
 * documents use: $ref (local pointers), allOf, anyOf, oneOf (with an OpenAPI
 * discriminator), type (also as an array, and OpenAPI 3.0 `nullable`), enum,
 * const, required, properties, additionalProperties, items, min/maxItems,
 * min/maxLength, pattern, minimum/maximum. `format` is not checked.
 *
 * One deliberate deviation: `allOf` members are merged before validation
 * (properties, required and additionalProperties combined), the way OpenAPI
 * code generators read them. Strict JSON Schema would make Meta's
 * `TextMessage` (allOf of the base properties and `{additionalProperties:
 * false, properties: {type, text}}`) reject every real message.
 */

/**
 * @param {object} doc - Root document `$ref`s point into.
 * @param {string} ref
 * @returns {object}
 */
function resolve(doc, ref) {
  if (!ref.startsWith('#/')) throw new Error(`external $ref not supported: ${ref}`);
  const node = ref
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((n, key) => (n === undefined ? undefined : n[key]), doc);
  if (node === undefined) throw new Error(`unresolved $ref ${ref}`);
  return node;
}

/**
 * Resolves `$ref` and merges `allOf` into one schema.
 *
 * @param {object} doc
 * @param {object} schema
 * @param {number} [depth]
 * @returns {object}
 */
function flatten(doc, schema, depth = 0) {
  if (depth > 50) throw new Error('schema nesting too deep');
  let s = schema || {};
  while (s.$ref)
    s = { ...resolve(doc, s.$ref), ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== '$ref')) };
  if (!Array.isArray(s.allOf)) return s;
  const merged = { ...s };
  delete merged.allOf;
  for (const part of s.allOf.map((p) => flatten(doc, p, depth + 1))) {
    for (const [key, value] of Object.entries(part)) {
      if (key === 'properties') merged.properties = { ...(merged.properties || {}), ...value };
      else if (key === 'required') merged.required = [...new Set([...(merged.required || []), ...value])];
      else if (key === 'additionalProperties') {
        merged.additionalProperties = merged.additionalProperties === false || value === false ? false : value;
      } else if (!(key in merged)) merged[key] = value;
    }
  }
  return merged;
}

/**
 * @param {*} value
 * @returns {string}
 */
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/**
 * Validates `value` against `schema`.
 *
 * @param {object} doc - Document holding the referenced components.
 * @param {object} schema
 * @param {*} value
 * @param {string} [at] - Path for messages.
 * @returns {string[]} Error messages; empty when valid.
 */
function validate(doc, schema, value, at = '$') {
  const s = flatten(doc, schema);
  const errors = [];
  if (value === null && s.nullable === true) return errors;

  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) {
    const options = s.oneOf || s.anyOf;
    const tag = s.discriminator?.propertyName;
    if (tag && value && typeof value === 'object' && s.discriminator.mapping?.[value[tag]]) {
      errors.push(...validate(doc, { $ref: s.discriminator.mapping[value[tag]] }, value, at));
    } else {
      const results = options.map((o) => validate(doc, o, value, at));
      const passing = results.filter((r) => r.length === 0).length;
      if (passing === 0) {
        const best = results.reduce((a, b) => (b.length < a.length ? b : a));
        errors.push(`${at}: matches none of ${options.length} alternatives (closest: ${best.slice(0, 3).join('; ')})`);
      }
    }
  }

  if (s.const !== undefined && value !== s.const) errors.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(s.enum)}`);
  }

  if (s.type) {
    const allowed = Array.isArray(s.type) ? s.type : [s.type];
    const actual = typeOf(value);
    const ok = allowed.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) {
      errors.push(`${at}: expected ${allowed.join('|')}, got ${actual}`);
      return errors;
    }
  }

  if (typeof value === 'string') {
    if (Number.isInteger(s.minLength) && value.length < s.minLength) errors.push(`${at}: shorter than ${s.minLength}`);
    if (Number.isInteger(s.maxLength) && value.length > s.maxLength) errors.push(`${at}: longer than ${s.maxLength}`);
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(value)) {
      errors.push(`${at}: does not match ${s.pattern}`);
    }
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) errors.push(`${at}: below ${s.minimum}`);
    if (typeof s.maximum === 'number' && value > s.maximum) errors.push(`${at}: above ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(s.minItems) && value.length < s.minItems) errors.push(`${at}: fewer than ${s.minItems} items`);
    if (Number.isInteger(s.maxItems) && value.length > s.maxItems) errors.push(`${at}: more than ${s.maxItems} items`);
    if (s.items) value.forEach((item, i) => errors.push(...validate(doc, s.items, item, `${at}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of s.required || []) {
      if (!(key in value)) errors.push(`${at}: missing required "${key}"`);
    }
    const props = s.properties || {};
    for (const [key, child] of Object.entries(value)) {
      if (props[key]) errors.push(...validate(doc, props[key], child, `${at}.${key}`));
      else if (s.additionalProperties === false) errors.push(`${at}: "${key}" is not in the spec`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
        errors.push(...validate(doc, s.additionalProperties, child, `${at}.${key}`));
      }
    }
  }
  return errors;
}

/**
 * Turns a form body into an object typed by the schema (form values are
 * strings; arrays are repeated keys), so it can be validated like JSON.
 *
 * @param {object} doc
 * @param {object} schema - Form object schema.
 * @param {URLSearchParams} form
 * @returns {object}
 */
function formToObject(doc, schema, form) {
  const props = flatten(doc, schema).properties || {};
  const out = {};
  for (const key of new Set(form.keys())) {
    const values = form.getAll(key);
    const prop = props[key] ? flatten(doc, props[key]) : {};
    const types = Array.isArray(prop.type) ? prop.type : [prop.type];
    const scalar = (v) => {
      if (types.includes('integer') && /^-?\d+$/.test(v)) return Number(v);
      if (types.includes('number') && v !== '' && Number.isFinite(Number(v))) return Number(v);
      if (types.includes('boolean') && (v === 'true' || v === 'false')) return v === 'true';
      return v;
    };
    out[key] = types.includes('array') ? values : scalar(values[values.length - 1]);
  }
  return out;
}

/**
 * Request body schema of an OpenAPI operation.
 *
 * @param {object} spec - OpenAPI subset (`paths`, `components`).
 * @param {string} method
 * @param {string} path
 * @param {string} contentType
 * @returns {object}
 */
function requestSchema(spec, method, path, contentType) {
  const op = spec.paths[path]?.[method];
  if (!op) throw new Error(`${method} ${path} is not in the pinned spec`);
  const body = op.requestBody?.$ref ? resolve(spec, op.requestBody.$ref) : op.requestBody;
  const schema = body?.content?.[contentType]?.schema;
  if (!schema) throw new Error(`${method} ${path} has no ${contentType} request schema`);
  return schema;
}

/**
 * Response schema of an OpenAPI operation.
 *
 * @param {object} spec
 * @param {string} method
 * @param {string} path
 * @param {string} status
 * @returns {object|null}
 */
function responseSchema(spec, method, path, status) {
  const op = spec.paths[path]?.[method];
  if (!op) throw new Error(`${method} ${path} is not in the pinned spec`);
  const response = op.responses?.[status]?.$ref ? resolve(spec, op.responses[status].$ref) : op.responses?.[status];
  return response?.content?.['application/json']?.schema || null;
}

/**
 * Example values of a response, keyed by example name.
 *
 * @param {object} spec
 * @param {string} method
 * @param {string} path
 * @param {string} status
 * @returns {Record<string, *>}
 */
function responseExamples(spec, method, path, status) {
  const content = spec.paths[path]?.[method]?.responses?.[status]?.content?.['application/json'] || {};
  const out = {};
  for (const [name, example] of Object.entries(content.examples || {})) out[name] = example.value;
  if (content.example !== undefined) out.example = content.example;
  return out;
}

/**
 * Query parameters an operation declares (path-level and operation-level).
 *
 * @param {object} spec
 * @param {string} method
 * @param {string} path
 * @returns {Map<string, object>} name → parameter
 */
function queryParameters(spec, method, path) {
  const item = spec.paths[path] || {};
  const list = [...(item.parameters || []), ...(item[method]?.parameters || [])].map((p) =>
    p.$ref ? resolve(spec, p.$ref) : p
  );
  return new Map(list.filter((p) => p.in === 'query').map((p) => [p.name, p]));
}

module.exports = {
  validate,
  flatten,
  formToObject,
  requestSchema,
  responseSchema,
  responseExamples,
  queryParameters,
  resolve,
};
