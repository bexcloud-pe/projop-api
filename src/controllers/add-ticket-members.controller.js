// POST /tickets/:ticketId/members
// HTTP in/out only: validation lives in the validator, the work in the service.

const { validateAddTicketMembers } = require('../validators/add-ticket-members.validator');
const { addMembersToTicket } = require('../services/ticket-members.service');
const { ServiceError } = require('../services/service-error');

const addTicketMembersHandler = async (req, res) => {
  const { value, errors } = validateAddTicketMembers(req.params.ticketId, req.body);

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Invalid request', details: errors });
  }

  // req.ip honors the 'trust proxy' setting in app.js. audit/creation IP columns are varchar(50).
  const ip = (req.ip || '0.0.0.0').replace(/^::ffff:/, '').slice(0, 50);

  // TODO: permission check (write on the ticket) and actorUserId from the
  // verified identity, once the API has authentication.
  try {
    const result = await addMembersToTicket(value, { ip });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof ServiceError) {
      const body = { error: err.message };
      if (err.details) body.details = err.details;
      return res.status(err.status).json(body);
    }
    // Never leak SQL details to the client: log them here only.
    console.error('addTicketMembers:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { addTicketMembers: addTicketMembersHandler };
