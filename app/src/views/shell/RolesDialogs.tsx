import { useState } from "react";
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Input, MessageBar, MessageBarBody, Select, Textarea } from "@fluentui/react-components";
import { listTables } from "../../core/model/ops";
import { listRoles, type RoleView } from "../../core/model/modeling";
import { useDoc, useEnv, useShellState } from "./ShellContext";

/** Manage roles: a role is a name and one DAX filter per table; a member sees the rows where the filter is TRUE. */
export function RolesDialog() {
  const env = useEnv();
  const doc = useDoc();
  const project = doc.project;
  const close = () => env.session.shell.closeDialog();
  const roles = project ? listRoles(project) : [];
  const tables = project ? listTables(project).map((t) => t.name) : [];
  const [current, setCurrent] = useState<string | null>(roles[0]?.name ?? null);
  const [draft, setDraft] = useState<RoleView>(() => structuredClone(roles[0] ?? { name: "", filters: [] }));
  const [isNew, setIsNew] = useState(roles.length === 0);
  const [error, setError] = useState<string | null>(null);
  const pick = (name: string) => {
    const r = roles.find((x) => x.name === name);
    if (!r) return;
    setCurrent(name);
    setDraft(structuredClone(r));
    setIsNew(false);
    setError(null);
  };
  const save = async () => {
    const res = await env.registry.execute("model.setRole", { role: draft, oldName: isNew ? undefined : current });
    if (!res.ok) return setError(res.message);
    setError(null);
    setCurrent(draft.name.trim());
    setIsNew(false);
  };
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && close()}>
      <DialogSurface aria-label="Manage roles" style={{ minWidth: 640 }}>
        <DialogBody>
          <DialogTitle>Manage security roles</DialogTitle>
          <DialogContent>
            <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 12 }}>
              <div>
                <ul aria-label="Roles" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {roles.map((r) => (
                    <li key={r.name}>
                      <Button appearance={!isNew && r.name === current ? "primary" : "subtle"} size="small" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => pick(r.name)}>
                        {r.name}
                      </Button>
                    </li>
                  ))}
                </ul>
                <Button
                  size="small"
                  onClick={() => {
                    setDraft({ name: "", filters: [] });
                    setIsNew(true);
                    setError(null);
                  }}
                >
                  New role
                </Button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ display: "grid", gap: 4 }}>
                  Role name
                  <Input aria-label="Role name" value={draft.name} onChange={(_, d) => setDraft({ ...draft, name: d.value })} />
                </label>
                <div>Table filters (a row is visible when the expression is TRUE)</div>
                {draft.filters.map((f, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "160px 1fr auto", gap: 6, alignItems: "start" }}>
                    <Select aria-label={`Table ${i + 1}`} value={f.table} onChange={(_, d) => setDraft({ ...draft, filters: draft.filters.map((x, k) => (k === i ? { ...x, table: d.value } : x)) })}>
                      {tables.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                    <Textarea aria-label={`Filter expression ${i + 1}`} rows={2} value={f.expression} onChange={(_, d) => setDraft({ ...draft, filters: draft.filters.map((x, k) => (k === i ? { ...x, expression: d.value } : x)) })} />
                    <Button size="small" aria-label={`Remove filter ${i + 1}`} onClick={() => setDraft({ ...draft, filters: draft.filters.filter((_, k) => k !== i) })}>
                      Remove
                    </Button>
                  </div>
                ))}
                <div>
                  <Button size="small" disabled={tables.length === 0} onClick={() => setDraft({ ...draft, filters: [...draft.filters, { table: tables.find((t) => !draft.filters.some((f) => f.table === t)) ?? tables[0], expression: "" }] })}>
                    Add table filter
                  </Button>
                </div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>Example: Customer[Region] = USERNAME(). USERNAME() returns the name entered in View as.</div>
                {error && (
                  <MessageBar intent="error">
                    <MessageBarBody>{error}</MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            {!isNew && current && (
              <Button
                onClick={async () => {
                  const res = await env.registry.execute("model.removeRole", { name: current });
                  if (!res.ok) return setError(res.message);
                  const rest = listRoles(env.session.store.project!);
                  setCurrent(rest[0]?.name ?? null);
                  setDraft(structuredClone(rest[0] ?? { name: "", filters: [] }));
                  setIsNew(rest.length === 0);
                }}
              >
                Delete role
              </Button>
            )}
            <Button appearance="primary" disabled={draft.name.trim() === ""} onClick={() => void save()}>
              Save role
            </Button>
            <Button onClick={close}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** View as: pick roles (and the user name USERNAME() returns); the report then shows what a member of them sees. */
export function ViewAsDialog() {
  const env = useEnv();
  const doc = useDoc();
  const st = useShellState();
  const roles = doc.project ? listRoles(doc.project) : [];
  const [picked, setPicked] = useState<string[]>(st.viewAs?.roles ?? []);
  const [identity, setIdentity] = useState(st.viewAs?.identity ?? "");
  const close = () => env.session.shell.closeDialog();
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && close()}>
      <DialogSurface aria-label="View as roles">
        <DialogBody>
          <DialogTitle>View as roles</DialogTitle>
          <DialogContent style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {roles.length === 0 && <div role="alert">There are no roles yet. Use Manage roles to create one.</div>}
            {roles.map((r) => (
              <Checkbox key={r.name} label={r.name} checked={picked.includes(r.name)} onChange={(_, d) => setPicked(d.checked ? [...picked, r.name] : picked.filter((x) => x !== r.name))} />
            ))}
            <label style={{ display: "grid", gap: 4 }}>
              User name (what USERNAME() returns)
              <Input aria-label="User name" value={identity} onChange={(_, d) => setIdentity(d.value)} />
            </label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Queries then run on a copy of the data that holds only the rows the roles allow. Nothing in the model changes.</div>
          </DialogContent>
          <DialogActions>
            {st.viewAs && (
              <Button
                onClick={async () => {
                  await env.registry.execute("model.viewAs", { roles: [] });
                  close();
                }}
              >
                Stop viewing as roles
              </Button>
            )}
            <Button
              appearance="primary"
              disabled={picked.length === 0}
              onClick={async () => {
                await env.registry.execute("model.viewAs", { roles: picked, identity: identity.trim() });
                close();
              }}
            >
              OK
            </Button>
            <Button onClick={close}>Cancel</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** A thin bar while a role view is on. */
export function ViewAsBar() {
  const env = useEnv();
  const st = useShellState();
  if (!st.viewAs) return null;
  return (
    <section className="notice-bar" role="region" aria-label="Viewing as roles" style={{ display: "flex", gap: 12, alignItems: "center", padding: "4px 10px", background: "#fff4ce" }}>
      <strong>Viewing as</strong>
      <span>{st.viewAs.roles.join(", ")}</span>
      {st.viewAs.identity && <span>(user name {st.viewAs.identity})</span>}
      <Button size="small" onClick={() => void env.registry.execute("model.viewAs", { roles: [] })}>
        Stop viewing as roles
      </Button>
    </section>
  );
}
