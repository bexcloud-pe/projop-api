// Request validation for POST /tickets.
//
// Pure function: takes the parsed JSON body and returns { value, errors }.
// Only whitelisted fields are accepted. Unknown fields are rejected, so a
// typo such as "confItemNewId" fails loudly instead of being ignored.
//
// Optional fields: undefined and null both mean "not provided" and are never
// written to the database (the column stays SQL NULL).

const { ID_MESSAGE, isId, idListError } = require('./id-rules');

const MAX_NAME_LENGTH = 1000;
const MAX_DESCRIPTION_LENGTH = 50000;
const MAX_MEMBER_IDS = 50;

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

// ISO-8601 date or date-time, e.g. 2026-11-30 or 2026-11-30T17:00:00Z.
// Also accepts the PostgreSQL timestamptz output returned by the ]po[ REST API,
// e.g. 2026-05-31 00:00:00-05 (offset without minutes).
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/;

// Date.parse needs "T" as the separator and the offset as +HH:MM.
const toParsableDate = (v) => {
  const s = v.replace(' ', 'T');
  if (!s.includes('T')) return s;
  return s.replace(/([+-]\d{2}):?(\d{2})?$/, (match, hours, minutes) => `${hours}:${minutes || '00'}`);
};

const isIsoDate = (v) => typeof v === 'string' && ISO_DATE_RE.test(v) && !Number.isNaN(Date.parse(toParsableDate(v)));

// Field kinds. Each returns an error message, or null when the value is valid.
const KINDS = {
  id: (v) => (isId(v) ? null : ID_MESSAGE),
  text: (max) => (v) => {
    if (typeof v !== 'string') return 'must be a string';
    if (v.length > max) return `must be at most ${max} characters`;
    return null;
  },
  boolean: (v) => (typeof v === 'boolean' ? null : 'must be a boolean'),
  hours: (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? null : 'must be a number greater than or equal to 0',
  date: (v) => (isIsoDate(v) ? null : 'must be an ISO-8601 date or date-time string'),
};

const REQUIRED_FIELDS = ['name', 'slaId', 'typeId', 'statusId', 'creatorUserId'];

const OPTIONAL_KINDS = {
  priorityId: KINDS.id,
  customerContactId: KINDS.id,
  description: KINDS.text(MAX_DESCRIPTION_LENGTH),
  serviceCatalogId: KINDS.id,
  customerCompanyId: KINDS.id,
  customerProjectId: KINDS.id,
  customClassId: KINDS.id,
  confItemId: KINDS.id,
  customerDeadline: KINDS.date,
  solutionCategoryId: KINDS.id,
  assigneeId: KINDS.id,
  serviceCatalogNewId: KINDS.id,
  solutionCategoryNewId: KINDS.id,
  configItemNewId: KINDS.id,
  overtime: KINDS.boolean,
  downtimeHours: KINDS.hours,
  customerInitialDate: KINDS.date,
};

// Converts validated values to their stored form. Returning undefined means
// "do not write" (the column stays SQL NULL).
// bex_ticket_overtime is char(1) and only ever holds 't' or NULL.
const NORMALIZERS = {
  overtime: (v) => (v ? 't' : undefined),
};

// Optional fields mapped 1:1 to im_tickets columns (see create-ticket.service).
const OPTIONAL_FIELDS = Object.keys(OPTIONAL_KINDS);

// Additional members of the new ticket, besides the creator and the assignee.
// Not a column: each id becomes a Full Member rel (ticket-members.service).
const MEMBER_IDS_FIELD = 'memberIds';

const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS, MEMBER_IDS_FIELD]);

/**
 * @param {unknown} body Parsed JSON body.
 * @returns {{ value: object, errors: Array<{ field: string, message: string }> }}
 *   `value` holds only provided, valid fields (name is trimmed). It is only
 *   meaningful when `errors` is empty.
 */
const validateCreateTicket = (body) => {
  const errors = [];
  const value = {};

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { value, errors: [{ field: '(body)', message: 'must be a JSON object' }] };
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) {
      errors.push({ field: key, message: 'unknown field' });
    }
  }

  // Required fields
  for (const field of ['slaId', 'typeId', 'statusId', 'creatorUserId']) {
    const v = body[field];
    if (v === undefined || v === null) {
      errors.push({ field, message: 'is required' });
    } else {
      const msg = KINDS.id(v);
      if (msg) errors.push({ field, message: msg });
      else value[field] = v;
    }
  }

  if (body.name === undefined || body.name === null) {
    errors.push({ field: 'name', message: 'is required' });
  } else if (!isNonEmptyString(body.name)) {
    errors.push({ field: 'name', message: 'must be a non-empty string' });
  } else if (body.name.trim().length > MAX_NAME_LENGTH) {
    errors.push({ field: 'name', message: `must be at most ${MAX_NAME_LENGTH} characters` });
  } else {
    value.name = body.name.trim();
  }

  // Optional fields
  for (const field of OPTIONAL_FIELDS) {
    const v = body[field];
    if (v === undefined || v === null) continue;
    const msg = OPTIONAL_KINDS[field](v);
    if (msg) {
      errors.push({ field, message: msg });
      continue;
    }
    const normalize = NORMALIZERS[field];
    const stored = normalize ? normalize(v) : v;
    if (stored !== undefined) value[field] = stored;
  }

  // Member ids: an empty array or null means "no additional members".
  const memberIds = body[MEMBER_IDS_FIELD];
  if (memberIds !== undefined && memberIds !== null) {
    const msg = idListError(memberIds, { min: 0, max: MAX_MEMBER_IDS });
    if (msg) errors.push({ field: MEMBER_IDS_FIELD, message: msg });
    else if (memberIds.length > 0) value.memberIds = memberIds.slice();
  }

  return { value, errors };
};

module.exports = { validateCreateTicket, REQUIRED_FIELDS, OPTIONAL_FIELDS };
