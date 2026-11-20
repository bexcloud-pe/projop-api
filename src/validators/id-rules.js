// Shared id validation rules. ]po[ ids are PostgreSQL int4.

const MAX_INT4 = 2147483647;
const ID_MESSAGE = `must be a positive integer up to ${MAX_INT4}`;

const isId = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= MAX_INT4;

// Returns an error message, or null when v is an array of unique ids
// with a length between min and max.
const idListError = (v, { min, max }) => {
  if (!Array.isArray(v)) return 'must be an array';
  if (v.length < min || v.length > max) return `must contain between ${min} and ${max} items`;
  if (!v.every(isId)) return `every item ${ID_MESSAGE}`;
  if (new Set(v).size !== v.length) return 'items must be unique';
  return null;
};

module.exports = { MAX_INT4, ID_MESSAGE, isId, idListError };
