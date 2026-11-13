/// Onyx's own store (accounts.amaete.com): the same shape the accounts service reads in Palasora's database for the games
/// (users with a tenant, tenants, audit_events), in a PocketBase of its own, so the studio's sites and products never share a
/// database with the games. The service adds its own nv_* tables on start-up (lib/schema.mjs).
migrate((app) => {
  const T = (name) => ({ name, type: "text", max: 500 });
  const users = app.findCollectionByNameOrId("users");
  for (const f of [T("tenant_id"), T("handle"), T("display_name"), { name: "account_status", type: "select", values: ["active", "suspended", "deleted"], maxSelect: 1 },
    { name: "profile_kind", type: "select", values: ["human", "editorial_ai", "organization"], maxSelect: 1 }, T("locale")]) users.fields.add(new Field(f));
  users.indexes = [...users.indexes, "CREATE UNIQUE INDEX idx_users_handle ON users (tenant_id, handle) WHERE handle != ''"];
  users.createRule = null;   // people are made by the accounts service only, never through the database API
  app.save(users);
  const stamps = [{ name: "created", type: "autodate", onCreate: true }, { name: "updated", type: "autodate", onCreate: true, onUpdate: true }];
  app.save(new Collection({ type: "base", name: "tenants", fields: [T("slug"), T("name"), T("status"), T("canonical_host"), ...stamps] }));
  app.save(new Collection({ type: "base", name: "audit_events", fields: [T("tenant_id"), T("actor_type"), T("actor_id"), T("action"), T("object_type"), T("object_id"),
    { name: "revision", type: "number" }, { name: "metadata_safe", type: "json", maxSize: 20000 }, T("request_id"), ...stamps] }));
});
