// Ticket creation service.
//
// Mirrors ]project-open[ im_ticket::new (intranet-helpdesk-procs.tcl) plus the
// after-create steps of intranet-helpdesk/www/new.tcl, in ONE transaction.
// It deliberately does NOT use the BEX function im_ticket__new__api_v2. It only
// calls stock ]po[ functions (im_ticket__new; members via ticket-members.service, audit via audit.service).
//
// Each step is a small function taking (client, ...) so it runs on the
// transaction's client. All SQL is parameterized.

const pool = require('../config/db');
const { OPTIONAL_FIELDS } = require('../validators/create-ticket.validator');
const { ServiceError } = require('./service-error');
const { writeAudit } = require('./audit.service');
const { addTicketMembers } = require('./ticket-members.service');

// ---------------------------------------------------------------------------
// Constants (values from the stock ]po[ code)
// ---------------------------------------------------------------------------
const PROJECT_TYPE_TICKET_CONTAINER = 2502; // SLA ("Ticket Container")
const TOPIC_TYPE_DISCUSSION = 1106; // im_topic_type_id_discussion
const TOPIC_STATUS_OPEN = 1200; // im_topic_status_id_open
const EMPTY_FORUM_MESSAGE = 'No message specified'; // intranet-helpdesk.Empty_Forum_Message

// Request field -> im_tickets column, for the optional fields.
// Unprovided fields are never written (the column stays SQL NULL).
const OPTIONAL_COLUMN_BY_FIELD = {
  priorityId: 'ticket_prio_id',
  customerContactId: 'ticket_customer_contact_id',
  description: 'ticket_description',
  serviceCatalogId: 'ticket_service_catalog',
  customerCompanyId: 'ticket_customer_company',
  customerProjectId: 'ticket_customer_project',
  customClassId: 'ticket_custom_class',
  confItemId: 'ticket_conf_item_id',
  customerDeadline: 'ticket_customer_deadline',
  solutionCategoryId: 'ticket_solution_category',
  assigneeId: 'ticket_assignee_id',
  serviceCatalogNewId: 'ticket_service_catalog_new',
  solutionCategoryNewId: 'ticket_solution_category_new',
  configItemNewId: 'ticket_config_item_new',
  overtime: 'bex_ticket_overtime',
  downtimeHours: 'bex_ticket_downtime_hours',
  customerInitialDate: 'bex_ticket_customer_initial_date',
};

// Fail at load time if the validator and this map drift apart.
for (const field of OPTIONAL_FIELDS) {
  if (!OPTIONAL_COLUMN_BY_FIELD[field]) {
    throw new Error(`create-ticket.service: no im_tickets column mapped for field "${field}"`);
  }
}

// Referenced entities that must exist. Table and column names are constants.
const REFERENCE_CHECKS = [
  { field: 'creatorUserId', table: 'users', column: 'user_id' },
  { field: 'typeId', table: 'im_categories', column: 'category_id' },
  { field: 'statusId', table: 'im_categories', column: 'category_id' },
  { field: 'priorityId', table: 'im_categories', column: 'category_id' },
  { field: 'serviceCatalogId', table: 'im_categories', column: 'category_id' },
  { field: 'customerCompanyId', table: 'im_categories', column: 'category_id' },
  { field: 'customerProjectId', table: 'im_categories', column: 'category_id' },
  { field: 'customClassId', table: 'im_categories', column: 'category_id' },
  { field: 'solutionCategoryId', table: 'im_categories', column: 'category_id' },
  { field: 'customerContactId', table: 'persons', column: 'person_id' },
  { field: 'assigneeId', table: 'persons', column: 'person_id' },
  { field: 'confItemId', table: 'im_conf_items', column: 'conf_item_id' },
];

// ---------------------------------------------------------------------------
// Step functions
// ---------------------------------------------------------------------------

// Pre-check: every referenced entity exists. Returns 404 listing the missing ones.
const assertReferencesExist = async (client, input) => {
  const missing = [];
  for (const { field, table, column } of REFERENCE_CHECKS) {
    const id = input[field];
    if (id === undefined) continue;
    const { rowCount } = await client.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [id]);
    if (rowCount === 0) missing.push({ field, message: `${field} ${id} does not exist` });
  }

  if (input.memberIds) {
    const { rows } = await client.query('SELECT user_id FROM users WHERE user_id = ANY($1::int[])', [input.memberIds]);
    const found = new Set(rows.map((r) => r.user_id));
    for (const id of input.memberIds) {
      if (!found.has(id)) missing.push({ field: 'memberIds', message: `userId ${id} does not exist` });
    }
  }

  if (missing.length > 0) {
    throw new ServiceError(404, 'Referenced entity not found', missing);
  }
};

// The SLA must exist and be a Ticket Container (project_type 2502).
// Returns the SLA's company, which becomes the ticket's company (as in the TCL).
//
// FOR UPDATE makes concurrent tickets of the same SLA wait their turn here.
// Without it, attaching the ticket to the SLA deadlocks on PostgreSQL 9.2: the
// parent_id FK check takes a share lock on the SLA row, then the ]po[ trigger
// im_projects_update_tr asks for FOR UPDATE on that same row to bump
// max_child_sortkey, and two transactions wait on each other's share lock.
// The row lock is released at COMMIT/ROLLBACK. Tickets of other SLAs still run
// in parallel.
const loadSla = async (client, slaId) => {
  const { rows } = await client.query(
    'SELECT project_id, project_type_id, company_id FROM im_projects WHERE project_id = $1 FOR UPDATE',
    [slaId]
  );
  if (rows.length === 0) {
    throw new ServiceError(404, 'Referenced entity not found', [
      { field: 'slaId', message: `slaId ${slaId} does not exist` },
    ]);
  }
  const sla = rows[0];
  if (sla.project_type_id !== PROJECT_TYPE_TICKET_CONTAINER) {
    throw new ServiceError(400, 'Invalid SLA', [
      { field: 'slaId', message: `slaId ${slaId} is not a Ticket Container (project type ${PROJECT_TYPE_TICKET_CONTAINER})` },
    ]);
  }
  if (sla.company_id === null) {
    throw new ServiceError(400, 'Invalid SLA', [
      { field: 'slaId', message: `slaId ${slaId} has no company, so the ticket customer cannot be determined` },
    ]);
  }
  return sla;
};

// Same source as the stock code: im_ticket__new(10 args) does nextval('im_ticket_seq').
const nextTicketNr = async (client) => {
  const { rows } = await client.query("SELECT nextval('im_ticket_seq')::varchar AS ticket_nr");
  return rows[0].ticket_nr;
};

// Same checks as im_ticket::new: the name is unique across im_projects, and
// the nr is unique within the SLA.
// The advisory lock serializes concurrent API calls with the same name,
// since there is no unique constraint behind this check.
const assertNameAndNrUnique = async (client, name, ticketNr, slaId) => {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [name]);

  const byName = await client.query('SELECT 1 FROM im_projects WHERE project_name = $1 LIMIT 1', [name]);
  if (byName.rowCount > 0) {
    throw new ServiceError(409, `A ticket or project named "${name}" already exists`);
  }

  const byNr = await client.query(
    'SELECT 1 FROM im_projects WHERE project_nr = $1 AND parent_id = $2 LIMIT 1',
    [ticketNr, slaId]
  );
  if (byNr.rowCount > 0) {
    throw new ServiceError(409, `Ticket nr ${ticketNr} already exists in this SLA`);
  }
};

// Stock im_ticket__new, 11-arg overload (intranet-helpdesk-create.sql L199):
// (ticket_id, object_type, creation_date, creation_user, creation_ip,
//  context_id, name, nr, customer_id, type_id, status_id).
// context_id is NULL, same as tickets created from the ]po[ UI.
const insertBaseTicket = async (client, { name, ticketNr, companyId, typeId, statusId, creatorUserId, ip }) => {
  const { rows } = await client.query(
    `SELECT im_ticket__new(
        NULL::integer,
        'im_ticket'::varchar,
        now(),
        $1::integer,
        $2::varchar,
        NULL::integer,
        $3::varchar,
        $4::varchar,
        $5::integer,
        $6::integer,
        $7::integer
     ) AS ticket_id`,
    [creatorUserId, ip, name, ticketNr, companyId, typeId, statusId]
  );
  return rows[0].ticket_id;
};

// Same as the TCL "project_update": attach the ticket to its SLA and take the SLA's company.
const attachToSla = async (client, ticketId, slaId) => {
  await client.query(
    `UPDATE im_projects
        SET parent_id  = $1,
            company_id = (SELECT company_id FROM im_projects WHERE project_id = $1)
      WHERE project_id = $2`,
    [slaId, ticketId]
  );
};

// BEX and optional columns of im_tickets. Only provided fields are written,
// as real values; nothing is ever sent as the string 'null' or a sentinel date.
const updateTicketColumns = async (client, ticketId, input) => {
  const columns = [];
  const values = [];
  for (const field of OPTIONAL_FIELDS) {
    if (input[field] === undefined) continue;
    values.push(input[field]);
    columns.push(`${OPTIONAL_COLUMN_BY_FIELD[field]} = $${values.length}`);
  }
  if (columns.length === 0) return;

  values.push(ticketId);
  await client.query(
    `UPDATE im_tickets SET ${columns.join(', ')} WHERE ticket_id = $${values.length}`,
    values
  );
};

// First forum message, same insert as the TCL "topic_insert".
const insertFirstForumTopic = async (client, { ticketId, name, description, creatorUserId }) => {
  const message = description && description.trim() !== '' ? description : EMPTY_FORUM_MESSAGE;
  await client.query(
    `INSERT INTO im_forum_topics (
        topic_id, object_id, parent_id,
        topic_type_id, topic_status_id, owner_id,
        subject, message
     ) VALUES (
        nextval('im_forum_topics_seq'), $1, NULL,
        $2, $3, $4,
        $5, $6
     )`,
    [ticketId, TOPIC_TYPE_DISCUSSION, TOPIC_STATUS_OPEN, creatorUserId, name, message]
  );
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Creates a ticket in a single transaction.
 *
 * @param {object} input Validated body (see validators/create-ticket.validator.js).
 * @param {{ ip: string }} context Request context. `ip` is stored as creation/audit IP.
 * @returns {Promise<{ ticketId: number, ticketNr: string }>}
 * @throws {ServiceError} 400/404/409 for expected failures; anything else is unexpected.
 */
const createTicket = async (input, { ip }) => {
  const client = await pool.connect();
  let releaseError;

  try {
    await client.query('BEGIN');

    await assertReferencesExist(client, input);
    const sla = await loadSla(client, input.slaId);

    const ticketNr = await nextTicketNr(client);
    await assertNameAndNrUnique(client, input.name, ticketNr, input.slaId);

    const ticketId = await insertBaseTicket(client, {
      name: input.name,
      ticketNr,
      companyId: sla.company_id,
      typeId: input.typeId,
      statusId: input.statusId,
      creatorUserId: input.creatorUserId,
      ip,
    });
    await attachToSla(client, ticketId, input.slaId);
    await updateTicketColumns(client, ticketId, input);

    await addTicketMembers(client, ticketId, input, ip);

    await insertFirstForumTopic(client, {
      ticketId,
      name: input.name,
      description: input.description,
      creatorUserId: input.creatorUserId,
    });

    // Workflow start (im_workflow_start_wf) is skipped: only 268 of 38,177 tickets use workflow.

    await writeAudit(client, {
      objectId: ticketId,
      objectType: 'im_ticket',
      action: 'after_create',
      userId: input.creatorUserId,
      ip,
    });

    await client.query('COMMIT');
    return { ticketId, ticketNr };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('createTicket: ROLLBACK failed:', rollbackErr);
      releaseError = rollbackErr; // discard the broken connection instead of returning it to the pool
    }

    if (err instanceof ServiceError) throw err;

    // Foreign key violation: a referenced row we did not pre-check does not exist.
    if (err && err.code === '23503') {
      console.error('createTicket: foreign key violation:', err);
      throw new ServiceError(404, 'A referenced entity does not exist');
    }
    throw err;
  } finally {
    client.release(releaseError);
  }
};

module.exports = { createTicket, ServiceError };
