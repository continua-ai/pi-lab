function withOptions(base, options) {
  return options ? { ...base, ...options } : base;
}

export const Type = {
  Literal(value, options) {
    return withOptions({ const: value }, options);
  },

  String(options) {
    return withOptions({ type: 'string' }, options);
  },

  Number(options) {
    return withOptions({ type: 'number' }, options);
  },

  Object(properties, options) {
    return withOptions({ type: 'object', properties }, options);
  },

  Union(items, options) {
    return withOptions({ anyOf: items }, options);
  },

  Optional(schema) {
    return { ...schema, optional: true };
  },
};
