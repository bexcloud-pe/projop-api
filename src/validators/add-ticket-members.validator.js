// Request validation for POST /tickets/:ticketId/members.
//
// Pure function: takes the route param and the parsed JSON body and returns
// { value, errors }. Only whitelisted fields are accepted; unknown fields are
// rejected. There is no role field: the role is always Full Member (1300).

const { ID_MESSAGE, isId, idListError } = require('./id-rules');

const MAX_USER_IDS = 50;
const ALLOWED_FIELDS = new Set(['userIds', 'actorUserId']);

/**
 * @param {unknown} ticketIdParam Raw route param (string).
 * @param {unknown} body Parsed JSON body.
 * @returns {{ value: { ticketId?: number, userIds?: number[], actorUserId?: number },
 *             errors: Array<{ field: string, message: string }> }}
 */
const validateAddTicketMembers = (ticketIdParam, body) => {
  const errors = [];
  const value = {};

  if (typeof ticketIdParam === 'string' && /^[0-9]{1,10}$/.test(ticketIdParam) && isId(Number(ticketIdParam))) {
    value.ticketId = Number(ticketIdParam);
  } else {
    errors.push({ field: 'ticketId', message: ID_MESSAGE });
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    errors.push({ field: '(body)', message: 'must be a JSON object' });
    return { value, errors };
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) errors.push({ field: key, message: 'unknown field' });
  }

  const { userIds, actorUserId } = body;

  if (userIds === undefined || userIds === null) {
    errors.push({ field: 'userIds', message: 'is required' });
  } else {
    const msg = idListError(userIds, { min: 1, max: MAX_USER_IDS });
    if (msg) errors.push({ field: 'userIds', message: msg });
    else value.userIds = userIds.slice();
  }

  // TODO: actorUserId comes from the body because the API has no authentication
  // yet. Once auth exists it must come from the verified identity.
  if (actorUserId === undefined || actorUserId === null) {
    errors.push({ field: 'actorUserId', message: 'is required' });
  } else if (!isId(actorUserId)) {
    errors.push({ field: 'actorUserId', message: ID_MESSAGE });
  } else {
    value.actorUserId = actorUserId;
  }

  return { value, errors };
};

module.exports = { validateAddTicketMembers };
