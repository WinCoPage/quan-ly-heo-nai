function sanitize(snapshot) {
  if (!snapshot) return null;
  return JSON.stringify(snapshot, (key, value) => /password|token|secret/i.test(key) ? undefined : value);
}

async function recordAudit(db, actor, entityType, entityId, action, beforeSnapshot, afterSnapshot) {
  await db.prepare(
    `INSERT INTO audit_logs
      (entity_type, entity_id, action, before_snapshot, after_snapshot, actor_id, actor_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entityType,
    entityId || null,
    action,
    sanitize(beforeSnapshot),
    sanitize(afterSnapshot),
    actor?.id || null,
    actor?.full_name || actor?.username || null
  );
}

module.exports = { recordAudit, sanitize };
