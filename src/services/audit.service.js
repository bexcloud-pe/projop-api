// Shared audit module.
//
// Mirrors ]project-open[ im_audit_impl (intranet-core/tcl/intranet-audit-procs.tcl):
//   1. read the old value from the audit pointed to by acs_objects.last_audit_id,
//   2. build the new value (im_audit_object_value),
//   3. diff them (im_audit_calculate_diff),
//   4. insert an im_audits row ONLY if the diff is not empty, and update acs_objects.
//
// "after_create" is the same flow with no previous audit: the diff is every
// non-empty line, so it is never empty and always inserts.
//
// audit_value: "select *" over the object type's base table LEFT JOINed with its
// extension tables, one "column<TAB>value" line per column.
//
// Relationship lines ("acs_rel-<id>...") are NOT included: on the BEX instance
// AuditObjectRelationshipsP is off, and no audit written by ]po[ contains them.
// So adding a member usually produces an empty diff and no audit row.

const SAFE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SKIPPED_AUDIT_COLUMNS = new Set(['tree_sortkey', 'max_child_sortkey', 'rule_engine_old_value']);
const JOIN_ALIASES = 'bcdefghijklmnopqrstuvwxyz'.split('');

const safeIdentifier = (name) => {
  if (typeof name !== 'string' || !SAFE_IDENTIFIER_RE.test(name)) {
    throw new Error(`Unsafe SQL identifier from DB metadata: ${name}`);
  }
  return name;
};

// Raw text values (no Date/number parsing), so the audit text equals what the
// Tcl layer would read from the database.
const RAW_TYPES = { getTypeParser: () => (value) => value };

const runRaw = async (client, text, values) => {
  const result = await client.query({ text, values, rowMode: 'array', types: RAW_TYPES });
  return { names: result.fields.map((f) => f.name), rows: result.rows };
};

// \n and \t are the line/column separators, so they are escaped inside values.
const escapeAuditValue = (v) =>
  v === null || v === undefined ? '' : String(v).replace(/\n/g, '\\n').replace(/\t/g, '\\t');

// Equivalent of im_audit_object_type_sql + the value loop of im_audit_object_value.
const buildAuditValue = async (client, objectType, objectId) => {
  const base = await client.query(
    'SELECT table_name, id_column FROM acs_object_types WHERE object_type = $1',
    [objectType]
  );
  if (base.rows.length === 0) throw new Error(`Unknown object type for audit: ${objectType}`);
  const baseTable = safeIdentifier(base.rows[0].table_name);
  const baseIdColumn = safeIdentifier(base.rows[0].id_column);

  const ext = await client.query(
    'SELECT table_name, id_column FROM acs_object_type_tables WHERE object_type = $1',
    [objectType]
  );

  let sql = `SELECT * FROM ${baseTable} a`;
  ext.rows.forEach((row, i) => {
    const alias = JOIN_ALIASES[i];
    if (!alias) throw new Error(`Too many extension tables for ${objectType}`);
    sql += ` LEFT OUTER JOIN ${safeIdentifier(row.table_name)} ${alias} ON (a.${baseIdColumn} = ${alias}.${safeIdentifier(row.id_column)})`;
  });
  sql += ` WHERE a.${baseIdColumn} = $1`;

  const { names, rows } = await runRaw(client, sql, [objectId]);
  if (rows.length === 0) throw new Error(`Audit: object ${objectId} not found in ${baseTable}`);

  let value = '';
  names.forEach((name, i) => {
    if (SKIPPED_AUDIT_COLUMNS.has(name)) return;
    value += `${name}\t${escapeAuditValue(rows[0][i])}\n`;
  });
  return value;
};

// im_audit_calculate_diff: a line of the new value is kept only when its value
// differs from the old value of the same variable (a missing variable counts as
// ""). Lines that exist only in the old value are ignored.
const calculateDiff = (oldValue, newValue) => {
  const oldByVar = new Map();
  for (const line of oldValue.split('\n')) {
    const pieces = line.split('\t');
    oldByVar.set(pieces[0], pieces.length > 1 ? pieces[1] : ''); // last one wins, as in Tcl
  }

  let diff = '';
  for (const line of newValue.split('\n')) {
    const pieces = line.split('\t');
    const val = pieces.length > 1 ? pieces[1] : '';
    const oldVal = oldByVar.has(pieces[0]) ? oldByVar.get(pieces[0]) : '';
    if (val !== oldVal) diff += line + '\n';
  }
  return diff;
};

/**
 * Equivalent of `im_audit -object_id ... -action ...`.
 * Must run inside the caller's transaction (uses its client).
 *
 * @param {import('pg').PoolClient} client
 * @param {{ objectId: number, objectType: string, action: string,
 *           userId: number, ip: string, comment?: string }} params
 * @returns {Promise<number|null>} the new audit_id, or null when nothing changed.
 */
const writeAudit = async (client, { objectId, objectType, action, userId, ip, comment }) => {
  // Old value: only when acs_objects.last_audit_id points to an existing audit.
  const last = await client.query(
    `SELECT a.audit_value AS old_value, o.last_audit_id
       FROM im_audits a, acs_objects o
      WHERE o.object_id = $1 AND o.last_audit_id = a.audit_id`,
    [objectId]
  );
  const oldValue = last.rows.length > 0 && last.rows[0].old_value !== null ? last.rows[0].old_value : '';
  const lastAuditId = last.rows.length > 0 ? last.rows[0].last_audit_id : null;

  const value = await buildAuditValue(client, objectType, objectId);
  const diff = calculateDiff(oldValue, value);
  if (diff === '') return null;

  const inserted = await client.query(
    `INSERT INTO im_audits (
        audit_id, audit_object_id, audit_object_status_id, audit_action,
        audit_user_id, audit_date, audit_ip, audit_last_id,
        audit_ref_object_id, audit_value, audit_diff, audit_note, audit_hash
     ) VALUES (
        nextval('im_audit_seq'), $1, im_biz_object__get_status_id($1), $2,
        $3, now(), $4, $5,
        NULL, $6, $7, $8, NULL
     )
     RETURNING audit_id`,
    [objectId, action, userId, ip, lastAuditId, value, diff, comment === undefined ? null : comment]
  );
  const auditId = inserted.rows[0].audit_id;

  await client.query(
    `UPDATE acs_objects
        SET last_audit_id  = $1,
            last_modified  = now(),
            modifying_user = $2,
            modifying_ip   = $3
      WHERE object_id = $4`,
    [auditId, userId, ip, objectId]
  );
  return auditId;
};

module.exports = { writeAudit, buildAuditValue, calculateDiff, escapeAuditValue };
