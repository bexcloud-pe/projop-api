// POST /tickets
// HTTP in/out only: validation lives in the validator, the work in the service.

const { validateCreateTicket } = require('../validators/create-ticket.validator');
const { createTicket, ServiceError } = require('../services/create-ticket.service');

const createTicketHandler = async (req, res) => {
  const { value, errors } = validateCreateTicket(req.body);

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Invalid request body', details: errors });
  }

  // req.ip honors the 'trust proxy' setting in app.js. audit/creation IP columns are varchar(50).
  const ip = (req.ip || '0.0.0.0').replace(/^::ffff:/, '').slice(0, 50);

  // TODO: creatorUserId comes from the request body because the API has no
  // authentication yet. Once auth exists it must come from the verified
  // identity, and the field must be removed from the request contract.
  try {
    const { ticketId, ticketNr } = await createTicket(value, { ip });
    return res.status(201).json({ ticketId, ticketNr });
  } catch (err) {
    if (err instanceof ServiceError) {
      const body = { error: err.message };
      if (err.details) body.details = err.details;
      return res.status(err.status).json(body);
    }
    // Never leak SQL details to the client: log them here only.
    console.error('createTicket:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { createTicket: createTicketHandler };
