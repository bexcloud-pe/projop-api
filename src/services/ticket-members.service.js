// Ticket membership service.
//
// Mirrors ]project-open[ im_biz_object_add_role
// (intranet-core/tcl/intranet-biz-object-procs.tcl) and the member-add flow of
// intranet-core/www/member-add-2.tcl, using only stock ]po[ SQL functions
// (im_biz_object_member__new).
//
// The step functions take (client, ...) so they run on the caller's transaction
// client. addMembersToTicket is the one that owns a transaction.

const pool = require('../config/db');
const { ServiceError } = require('./service-error');
const { writeAudit } = require('./audit.service');

// Role ids (intranet-core/tcl/intranet-biz-object-procs.tcl:25-28)
const ROLE_FULL_MEMBER = 1300; // im_biz_object_role_full_member
const ROLE_PROJECT_MANAGER = 1301; // im_biz_object_role_project_manager
const ROLE_KEY_ACCOUNT = 1302; // im_biz_object_role_key_account
const ROLE_OFFICE_ADMIN = 1303; // im_biz_object_role_office_admin

// im_biz_object_add_role never overwrites these roles.
const ADMIN_ROLE_IDS = new Set([ROLE_PROJECT_MANAGER, ROLE_KEY_ACCOUNT, ROLE_OFFICE_ADMIN]);

// Object types that propagate membership to the parent project.
const PROPAGATING_TYPES = new Set(['im_project', 'im_timesheet_task', 'im_ticket']);

const MAX_PARENT_DEPTH = 20; // guard against cycles when walking up parent projects
const AUDIT_COMMENT = 'After adding members';

// im_biz_object_add_role with propagate_superproject_p = 1 (the default) and no
// percentage. Idempotent.
//  - An existing admin role is never downgraded.
//  - If the rel does not exist it is created with stock im_biz_object_member__new.
//  - If the existing role or percentage differs it is updated.
//  - For projects/tasks/tickets, if the user has no rel on the parent project,
//    the user becomes Full Member there too (recursively, going up).
// Skipped on purpose: im_biz_object_delete_timephased_data (tickets have no Gantt
// assignments) and im_permission_flush (cache only).
//
// Returns { relId, roleId, created } or null if the object does not exist.
const addRole = async (client, userId, objectId, roleId, creatorUserId, ip, depth = 0) => {
  const object = await client.query('SELECT object_type FROM acs_objects WHERE object_id = $1', [objectId]);
  if (object.rows.length === 0) return null;
  const objectType = object.rows[0].object_type;

  const existing = await client.query(
    `SELECT r.rel_id, bom.percentage, bom.object_role_id
       FROM acs_rels r, im_biz_object_members bom
      WHERE r.rel_id = bom.rel_id
        AND r.object_id_one = $1
        AND r.object_id_two = $2
      ORDER BY r.rel_id
      LIMIT 1`,
    [objectId, userId]
  );
  const current = existing.rows.length > 0 ? existing.rows[0] : null;

  // Don't overwrite an admin role.
  const effectiveRoleId = current && ADMIN_ROLE_IDS.has(current.object_role_id) ? current.object_role_id : roleId;

  let relId;
  let created = false;
  if (current === null) {
    const { rows } = await client.query(
      `SELECT im_biz_object_member__new(
          NULL::integer,
          'im_biz_object_member'::varchar,
          $1::integer,
          $2::integer,
          $3::integer,
          $4::integer,
          $5::varchar
       ) AS rel_id`,
      [objectId, userId, effectiveRoleId, creatorUserId, ip]
    );
    relId = rows[0].rel_id;
    created = true;
  } else {
    relId = current.rel_id;
    // Percentage is always NULL for us.
    if (current.percentage !== null || current.object_role_id !== effectiveRoleId) {
      await client.query(
        'UPDATE im_biz_object_members SET percentage = NULL, object_role_id = $1 WHERE rel_id = $2',
        [effectiveRoleId, relId]
      );
    }
  }

  if (PROPAGATING_TYPES.has(objectType) && depth < MAX_PARENT_DEPTH) {
    const parent = await client.query('SELECT parent_id FROM im_projects WHERE project_id = $1', [objectId]);
    const parentId = parent.rows.length > 0 ? parent.rows[0].parent_id : null;
    if (parentId !== null) {
      const related = await client.query(
        'SELECT 1 FROM acs_rels WHERE object_id_one = $1 AND object_id_two = $2 LIMIT 1',
        [parentId, userId]
      );
      if (related.rowCount === 0) {
        await addRole(client, userId, parentId, ROLE_FULL_MEMBER, creatorUserId, ip, depth + 1);
      }
    }
  }

  return { relId, roleId: effectiveRoleId, created };
};

// The user becomes Full Member of the ticket and, if not yet related, of each
// parent project going up (the SLA, and its parent, ...).
const addFullMemberToTicket = (client, ticketId, userId, creatorUserId, ip) =>
  addRole(client, userId, ticketId, ROLE_FULL_MEMBER, creatorUserId, ip);

// Members of a new ticket, in order and without duplicates:
//  1. the creator (im_ticket::new),
//  2. the assignee (intranet-helpdesk/www/new.tcl, "Add a new assignee to the members"),
//  3. any additional memberIds (e.g. the members of the ticket being cloned).
const addTicketMembers = async (client, ticketId, { creatorUserId, assigneeId, memberIds = [] }, ip) => {
  const userIds = new Set([creatorUserId]);
  if (assigneeId !== undefined) userIds.add(assigneeId);
  memberIds.forEach((id) => userIds.add(id));

  for (const userId of userIds) {
    await addFullMemberToTicket(client, ticketId, userId, creatorUserId, ip);
  }
};

// 404 unless the id is an acs_objects row of type im_ticket.
const assertTicketExists = async (client, ticketId) => {
  const { rowCount } = await client.query(
    "SELECT 1 FROM acs_objects WHERE object_id = $1 AND object_type = 'im_ticket'",
    [ticketId]
  );
  if (rowCount === 0) {
    throw new ServiceError(404, 'Ticket not found', [
      { field: 'ticketId', message: `ticketId ${ticketId} is not an existing ticket` },
    ]);
  }
};

// 404 listing every user id (members or actor) missing from users.
const assertUsersExist = async (client, userIds, actorUserId) => {
  const wanted = Array.from(new Set([...userIds, actorUserId]));
  const { rows } = await client.query('SELECT user_id FROM users WHERE user_id = ANY($1::int[])', [wanted]);
  const found = new Set(rows.map((r) => r.user_id));

  const missing = [];
  if (!found.has(actorUserId)) {
    missing.push({ field: 'actorUserId', message: `actorUserId ${actorUserId} does not exist` });
  }
  for (const id of userIds) {
    if (!found.has(id)) missing.push({ field: 'userIds', message: `userId ${id} does not exist` });
  }
  if (missing.length > 0) throw new ServiceError(404, 'Referenced user not found', missing);
};

/**
 * Adds users as Full Member of a ticket, in a single transaction
 * (member-add-2.tcl + im_biz_object_add_role + im_audit "after_update").
 *
 * TODO: permission check ("write" on the object) is skipped because the API has
 * no authentication yet.
 *
 * @param {{ ticketId: number, userIds: number[], actorUserId: number }} input Validated input.
 * @param {{ ip: string }} context
 * @returns {Promise<{ ticketId: number, members: Array<{userId:number, relId:number, roleId:number, created:boolean}>, auditId: number|null }>}
 * @throws {ServiceError} 404 for expected failures; anything else is unexpected.
 */
const addMembersToTicket = async ({ ticketId, userIds, actorUserId }, { ip }) => {
  const client = await pool.connect();
  let releaseError;

  try {
    await client.query('BEGIN');

    await assertTicketExists(client, ticketId);
    await assertUsersExist(client, userIds, actorUserId);

    // Serialize concurrent member additions on the same ticket.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ticket-members'), $1::integer)", [ticketId]);

    const members = [];
    for (const userId of userIds) {
      const result = await addRole(client, userId, ticketId, ROLE_FULL_MEMBER, actorUserId, ip);
      members.push({ userId, relId: result.relId, roleId: result.roleId, created: result.created });
    }

    await client.query(
      `UPDATE acs_objects
          SET last_modified = now(), modifying_user = $1, modifying_ip = $2
        WHERE object_id = $3`,
      [actorUserId, ip, ticketId]
    );

    const auditId = await writeAudit(client, {
      objectId: ticketId,
      objectType: 'im_ticket',
      action: 'after_update',
      userId: actorUserId,
      ip,
      comment: AUDIT_COMMENT,
    });

    await client.query('COMMIT');
    return { ticketId, members, auditId };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('addMembersToTicket: ROLLBACK failed:', rollbackErr);
      releaseError = rollbackErr; // discard the broken connection instead of returning it to the pool
    }

    if (err instanceof ServiceError) throw err;

    if (err && err.code === '23503') {
      console.error('addMembersToTicket: foreign key violation:', err);
      throw new ServiceError(404, 'A referenced entity does not exist');
    }
    throw err;
  } finally {
    client.release(releaseError);
  }
};

module.exports = {
  addMembersToTicket,
  addRole,
  addFullMemberToTicket,
  addTicketMembers,
  ROLE_FULL_MEMBER,
};
