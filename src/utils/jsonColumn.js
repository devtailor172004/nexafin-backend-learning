/**
 * JSON column helpers.
 *
 * On this deployment the MySQL columns declared as `DataTypes.JSON` are
 * physically LONGTEXT (the schema predates them / the ALTER to JSON did not
 * apply). The mysql2 driver only parses real JSON columns, so Sequelize hands
 * back a *string* for these attributes.
 *
 * Left unhandled that silently breaks anything that treats the value as an
 * object — e.g. `{ ...record.rawResponse }` spreads a string into indexed
 * characters, and replaying a stored idempotent response sends a JSON string
 * instead of the original object.
 *
 * `parseMaybeJson` normalises both cases, and `jsonColumnGetter` wires it into
 * a Sequelize attribute so reads are always parsed while writes are unchanged.
 */

export const parseMaybeJson = (value) => {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value !== 'string') return value;

    const trimmed = value.trim();
    if (!trimmed) return null;

    try {
        return JSON.parse(trimmed);
    } catch {
        // Not JSON — return the original value rather than throwing.
        return value;
    }
};

/**
 * Builds a Sequelize attribute `get()` that always returns a parsed value.
 * @param {string} attribute Sequelize attribute name
 */
export const jsonColumnGetter = (attribute) => function jsonGetter() {
    return parseMaybeJson(this.getDataValue(attribute));
};

/** Shallow-merges into a JSON-ish attribute without corrupting string values. */
export const mergeMaybeJson = (existing, patch) => ({
    ...(parseMaybeJson(existing) || {}),
    ...patch
});

export default parseMaybeJson;
