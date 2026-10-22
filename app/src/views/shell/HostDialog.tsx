import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Dropdown, Input, Option, Textarea } from "@fluentui/react-components";
import type { Connection, RlsRole, WsRole } from "../../core/host/types";
import { useEnv } from "./ShellContext";

function Frame({ title, onClose, children, actions }: { title: string; onClose(): void; children: React.ReactNode; actions: React.ReactNode }) {
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface aria-label={title} style={{ maxWidth: 820, width: "94vw" }}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: "70vh", overflowY: "auto" }}>{children}</DialogContent>
          <DialogActions>{actions}</DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function useHostUi() {
  const { session } = useEnv();
  const ui = session.hostUi;
  return { ui, state: useSyncExternalStore(ui.subscribe, ui.getSnapshot) };
}

const ROLES: WsRole[] = ["viewer", "editor", "admin"];

function HostSwitch() {
  const env = useEnv();
  const { state } = useHostUi();
  const [lan, setLan] = useState(false);
  const [tls, setTls] = useState(true);
  const [publicUrl, setPublicUrl] = useState("");
  return (
    <fieldset style={{ border: "1px solid var(--colorNeutralStroke2)", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
      <legend>Host from this PC</legend>
      {state.status.running ? (
        <>
          <div role="status">{`Hosting is on at ${state.status.url}${state.status.lan ? " (other computers on your network can connect)" : " (only this PC can connect)"}.`}</div>
          {state.status.fingerprint ? (
            <div style={{ fontSize: 12 }}>{`Encrypted with TLS. Certificate fingerprint (SHA-256): ${state.status.fingerprint}. Invitation links carry it, so guests trust exactly this certificate.`}</div>
          ) : (
            <div style={{ fontSize: 12 }}>Not encrypted (plain HTTP): use it on a trusted network or over a VPN.</div>
          )}
          <div>
            <Button onClick={() => void env.run("host.stop")}>Turn off hosting</Button>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12 }}>
            BIForge answers requests from the people you invite while it is open. It is free and uses your own computer. Traffic is encrypted with a certificate made on this PC (free; the invitation link carries its fingerprint, so there is no authority to pay). Reports are stored unencrypted on this PC.
          </div>
          <Checkbox label="Encrypt connections (TLS, recommended)" checked={tls} onChange={(_, d) => setTls(d.checked === true)} />
          <Checkbox label="Let other computers on my network connect" checked={lan} onChange={(_, d) => setLan(d.checked === true)} />
          {lan && <Input aria-label="Address others use" placeholder={`${tls ? "https" : "http"}://192.168.1.20:7878 (goes into invite links)`} value={publicUrl} onChange={(_, d) => setPublicUrl(d.value)} />}
          <div>
            <Button appearance="primary" onClick={() => void env.run("host.start", { lan, tls, publicUrl: publicUrl.trim() || null })}>
              Turn on Host from this PC
            </Button>
          </div>
        </>
      )}
    </fieldset>
  );
}

function Invite({ roleNames }: { roleNames: string[] }) {
  const env = useEnv();
  const { state } = useHostUi();
  const [role, setRole] = useState<WsRole>("viewer");
  const [identity, setIdentity] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  return (
    <fieldset style={{ border: "1px solid var(--colorNeutralStroke2)", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
      <legend>Invite someone</legend>
      <Input aria-label="Invite identity" placeholder="Who is it for? (e-mail address; this is what data roles compare with)" value={identity} onChange={(_, d) => setIdentity(d.value)} />
      <Dropdown aria-label="Invite role" value={role} selectedOptions={[role]} onOptionSelect={(_, d) => setRole((d.optionValue as WsRole) ?? "viewer")}>
        {ROLES.map((r) => (
          <Option key={r} value={r}>
            {r}
          </Option>
        ))}
      </Dropdown>
      {roleNames.length > 0 && (
        <div role="group" aria-label="Data roles for the invitation">
          {roleNames.map((n) => (
            <Checkbox key={n} label={`Data role ${n}`} checked={roles.includes(n)} onChange={(_, d) => setRoles(d.checked === true ? [...roles, n] : roles.filter((x) => x !== n))} />
          ))}
        </div>
      )}
      <div>
        <Button appearance="primary" disabled={!identity.trim()} onClick={() => void env.run("host.invite", { role, identity, rlsRoles: roles, expiresMinutes: 60 * 24 })}>
          Create invitation link
        </Button>
      </div>
      {state.invite && (
        <div role="status" aria-label="Invitation">
          <div>Send this link to the person. It works once and expires {state.invite.expiresAt}.</div>
          <Input aria-label="Invitation link" readOnly style={{ width: "100%" }} value={state.invite.link} />
          <div style={{ fontSize: 12 }}>
            Or give them the server address and the code: <code>{state.invite.token}</code>
          </div>
        </div>
      )}
    </fieldset>
  );
}

function RolesEditor({ report }: { report: string }) {
  const env = useEnv();
  const { state } = useHostUi();
  const current = state.roles?.report === report ? state.roles.roles : null;
  const [text, setText] = useState("");
  useEffect(() => {
    if (current) setText(current.map((r) => `${r.name}\n${r.filters.map((f) => `  ${f.table}: ${f.expression}`).join("\n")}`).join("\n"));
  }, [current]);
  if (!current) return null;
  // one role per block: a name line, then one "  Table: DAX filter" line per table
  const parse = (): RlsRole[] => {
    const out: RlsRole[] = [];
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      if (!/^\s/.test(raw)) out.push({ name: raw.trim(), filters: [] });
      else {
        const i = raw.indexOf(":");
        if (!out.length || i < 0) throw new Error(`Line "${raw.trim()}" should look like "  Table: [Column] = USERPRINCIPALNAME()" under a role name.`);
        out[out.length - 1].filters.push({ table: raw.slice(0, i).trim(), expression: raw.slice(i + 1).trim() });
      }
    }
    return out;
  };
  return (
    <div role="group" aria-label={`Data roles of ${report}`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 12 }}>
        A data role shows a member only the rows where the DAX filter is true. Write the role name on its own line, then one indented line per table. Members get roles through their invitation or in the member list. Viewers without a role on a report that has roles see nothing; editors and admins see everything.
      </div>
      <Textarea aria-label="Data roles" rows={6} value={text} onChange={(_, d) => setText(d.value)} />
      <div>
        <Button
          appearance="primary"
          onClick={() => {
            try {
              void env.run("host.roles.save", { report, roles: parse() });
            } catch (e) {
              env.session.hostUi.setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Save data roles
        </Button>
      </div>
    </div>
  );
}

function Workspace({ conn }: { conn: Connection }) {
  const env = useEnv();
  const { state } = useHostUi();
  const [name, setName] = useState("");
  const isAdmin = conn.role === "admin";
  const roleNames = state.roles ? state.roles.roles.map((r) => r.name) : [];
  return (
    <>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }} role="tablist" aria-label="Workspaces">
        {state.workspaces.map((w) => (
          <Button key={w.id} role="tab" aria-selected={w.id === state.workspace} appearance={w.id === state.workspace ? "primary" : "secondary"} onClick={() => void env.run("host.select", { connection: conn.id, workspace: w.id })}>
            {w.name}
          </Button>
        ))}
        {!conn.workspaceId && isAdmin && (
          <>
            <Input aria-label="New workspace name" placeholder="New workspace" value={name} onChange={(_, d) => setName(d.value)} />
            <Button
              disabled={!name.trim()}
              onClick={async () => {
                await env.run("host.workspace.create", { name });
                setName("");
              }}
            >
              Create workspace
            </Button>
          </>
        )}
      </div>
      {state.workspace && (
        <>
          <section aria-label="Reports on the server">
            <strong>Reports</strong>
            {state.reports.length === 0 ? (
              <div style={{ fontSize: 12 }}>No report yet. Open a project, choose Publish & Share, add the destination Host from this PC and publish.</div>
            ) : (
              <ul style={{ margin: "4px 0 0 0", padding: 0, listStyle: "none" }}>
                {state.reports.map((r) => (
                  <li key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "2px 0" }}>
                    <span style={{ flex: 1 }}>{`${r.name} (${r.id}), version ${r.version}${r.hasRoles ? ", has data roles" : ""}`}</span>
                    <Button size="small" onClick={() => void env.run("server.report.open", { connection: conn.id, workspace: state.workspace, report: r.id })}>
                      Open for viewing
                    </Button>
                    <Button size="small" onClick={() => void env.run("host.versions.load", { report: r.id })}>
                      Versions
                    </Button>
                    {conn.role !== "viewer" && (
                      <Button size="small" onClick={() => void env.run("host.roles.load", { report: r.id })}>
                        Data roles
                      </Button>
                    )}
                    {isAdmin && (
                      <Button size="small" onClick={() => void env.run("host.report.delete", { report: r.id })}>
                        Remove
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {state.versions && (
            <section aria-label="Version history">
              <strong>{`Versions of ${state.versions.report}`}</strong>
              <ul style={{ margin: "4px 0 0 0", padding: 0, listStyle: "none" }}>
                {state.versions.list.map((v) => (
                  <li key={v.version} style={{ display: "flex", gap: 8, alignItems: "center", padding: "2px 0" }}>
                    <span style={{ flex: 1 }}>{`Version ${v.version}${v.current ? " (current)" : ""}, ${v.at}, ${v.uploadedBy}, ${(v.sizeBytes / 1024).toFixed(0)} KB`}</span>
                    {conn.role !== "viewer" && !v.current && (
                      <Button size="small" aria-label={`Make version ${v.version} current`} onClick={() => void env.run("host.version.restore", { report: state.versions!.report, version: v.version })}>
                        Make current
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {state.roles && <RolesEditor report={state.roles.report} />}
          {isAdmin && <Invite roleNames={roleNames.length ? roleNames : [...new Set(state.members.flatMap((m) => m.rlsRoles))]} />}
          {isAdmin && (
            <section aria-label="Members">
              <strong>Members</strong>
              {state.members.length === 0 ? (
                <div style={{ fontSize: 12 }}>Nobody has joined yet.</div>
              ) : (
                <table style={{ width: "100%", fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th align="left">Name</th>
                      <th align="left">Identity</th>
                      <th align="left">Role</th>
                      <th align="left">Data roles</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {state.members.map((m) => (
                      <tr key={m.id}>
                        <td>{m.name}</td>
                        <td>{m.identity}</td>
                        <td>
                          <Dropdown aria-label={`Role of ${m.name}`} size="small" disabled={m.revoked} value={m.role} selectedOptions={[m.role]} onOptionSelect={(_, d) => void env.run("host.member.set", { member: m.id, role: d.optionValue })}>
                            {ROLES.map((r) => (
                              <Option key={r} value={r}>
                                {r}
                              </Option>
                            ))}
                          </Dropdown>
                        </td>
                        <td>{m.rlsRoles.join(", ") || "none"}</td>
                        <td>
                          {m.revoked ? (
                            "removed"
                          ) : (
                            <Button size="small" onClick={() => void env.run("host.member.revoke", { member: m.id })}>
                              Remove
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
          {isAdmin && (
            <details>
              <summary>{`Activity log (${state.audit.length})`}</summary>
              <ul style={{ margin: "4px 0 0 18px", fontSize: 12 }}>
                {[...state.audit].reverse().map((a, i) => (
                  <li key={i}>{`${a.time}  ${a.actor}  ${a.event}  ${a.detail}`}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </>
  );
}

export function HostDialog() {
  const env = useEnv();
  const { state } = useHostUi();
  const close = () => env.session.shell.closeDialog();
  const conn = state.connections.find((c) => c.id === state.selected) ?? null;
  return (
    <Frame title="Host and collaborate" onClose={close} actions={<><Button onClick={() => void env.run("server.join")}>Join a server</Button><Button appearance="primary" onClick={close}>Close</Button></>}>
      {state.error && (
        <div role="alert" style={{ color: "var(--colorPaletteRedForeground1)" }}>
          {state.error}
        </div>
      )}
      <HostSwitch />
      {state.connections.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }} role="tablist" aria-label="Servers">
          {state.connections.map((c) => (
            <Button key={c.id} role="tab" aria-selected={c.id === state.selected} appearance={c.id === state.selected ? "primary" : "secondary"} onClick={() => void env.run("host.select", { connection: c.id })}>
              {c.label}
            </Button>
          ))}
          {conn && !conn.isHost && (
            <Button appearance="subtle" onClick={() => void env.run("server.forget", { id: conn.id })}>
              Forget this server
            </Button>
          )}
        </div>
      )}
      {conn && (
        <div style={{ fontSize: 12 }}>
          {conn.isHost ? "You are the host (admin)." : `You are ${conn.identity} (${conn.role}).`}
        </div>
      )}
      {conn && <Workspace conn={conn} />}
    </Frame>
  );
}

function fmtTime(secs: number): string {
  try {
    return new Date(secs * 1000).toLocaleString();
  } catch {
    return String(secs);
  }
}

/** Host side of a direct (peer to peer) session: the code, join requests, guests, copies guests sent. */
export function P2pPanel({ targetId }: { targetId: string }) {
  const env = useEnv();
  const { state } = useHostUi();
  const view = state.p2pHosts[targetId];
  useEffect(() => {
    void env.run("p2p.host.refresh", { target: targetId });
    const t = setInterval(() => void env.run("p2p.host.refresh", { target: targetId }), 2000);
    return () => clearInterval(t);
  }, [env, targetId]);
  if (!view) return null;
  if (!view.running)
    return (
      <div role="note" style={{ fontSize: 12 }}>
        The direct session is not running. Publish to start it; you then get a pairing code for the other person.
      </div>
    );
  return (
    <fieldset aria-label="Direct session" style={{ border: "1px solid var(--colorNeutralStroke2)", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
      <legend>Direct session (version {view.version})</legend>
      <div>
        Pairing code: <Input aria-label="Pairing code" readOnly style={{ width: "100%" }} value={view.code} />
      </div>
      <details>
        <summary>Long code (also works on a network without internet)</summary>
        <Input aria-label="Long pairing code" readOnly style={{ width: "100%" }} value={view.ticket} />
      </details>
      <div style={{ fontSize: 12 }}>
        Expires {fmtTime(view.expiresAt)}. BIForge must stay open and both computers online. The code alone gives nobody access: you approve every person below.
      </div>
      {view.pending.length > 0 && (
        <section aria-label="Join requests">
          <strong>Waiting for your approval</strong>
          {view.pending.map((p) => (
            <div key={p.id} style={{ display: "flex", gap: 6, alignItems: "center", padding: "2px 0" }}>
              <span style={{ flex: 1 }}>{`${p.name} (device ${p.endpointId.slice(0, 10)}…)`}</span>
              <Button size="small" appearance="primary" onClick={() => void env.run("p2p.approve", { target: targetId, request: p.id, role: "readOnly" })}>
                Accept read-only
              </Button>
              <Button size="small" onClick={() => void env.run("p2p.approve", { target: targetId, request: p.id, role: "edit" })}>
                Accept with edit role
              </Button>
              <Button size="small" onClick={() => void env.run("p2p.deny", { target: targetId, request: p.id })}>
                Refuse
              </Button>
            </div>
          ))}
        </section>
      )}
      {view.peers.length > 0 && (
        <section aria-label="Guests">
          <strong>Guests</strong>
          {view.peers.map((p) => (
            <div key={p.endpointId} style={{ display: "flex", gap: 6, alignItems: "center", padding: "2px 0" }}>
              <span style={{ flex: 1 }}>{`${p.name}: ${p.role === "edit" ? "edit role" : "read only"}, ${p.revoked ? "access ended" : p.connected ? "connected" : "not connected"}`}</span>
              {!p.revoked && (
                <Button size="small" onClick={() => void env.run("p2p.revoke", { target: targetId, endpoint: p.endpointId })}>
                  End access
                </Button>
              )}
            </div>
          ))}
          <div style={{ fontSize: 12 }}>Ending access closes the connection at once and refuses that device again. A copy the guest already received stays with them.</div>
        </section>
      )}
      {view.pushes.length > 0 && (
        <section aria-label="Copies from guests">
          <strong>Copies guests sent</strong>
          {view.pushes.map((p) => (
            <div key={p.id} style={{ display: "flex", gap: 6, alignItems: "center", padding: "2px 0" }}>
              <span style={{ flex: 1 }}>{`${p.name}: ${Math.round(p.bytes / 1024)} KB`}</span>
              <Button size="small" onClick={() => void env.run("p2p.push.take", { target: targetId, push: p.id })}>
                Save the copy as a file
              </Button>
            </div>
          ))}
        </section>
      )}
    </fieldset>
  );
}

export function JoinServerDialog({ request }: { request: { link?: string; invite?: string } }) {
  const env = useEnv();
  const { state } = useHostUi();
  const [link, setLink] = useState(request.link ?? "");
  const [invite, setInvite] = useState(request.invite ?? "");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [adminUrl, setAdminUrl] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [adminPin, setAdminPin] = useState("");
  const isLink = link.trim().startsWith("biforge://");
  const isCode = /^BF1T?-/.test(link.trim());
  const guest = state.p2pGuest;
  const close = () => env.session.shell.closeDialog();
  return (
    <Frame
      title="Join a server"
      onClose={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button appearance="primary" disabled={!link.trim() || !name.trim() || (!isLink && !isCode && !invite.trim()) || state.busy || guest?.view?.state === "waiting"} onClick={() => void env.run(isCode ? "p2p.join.run" : "server.join.run", isCode ? { code: link, name } : { link, invite, name, pin })}>
            Join
          </Button>
        </>
      }
    >
      {state.error && (
        <div role="alert" style={{ color: "var(--colorPaletteRedForeground1)" }}>
          {state.error}
        </div>
      )}
      <div style={{ fontSize: 12 }}>Paste the invitation link you were sent, or the server address and the invitation code, or a pairing code (BF1-...) for a direct session. Nothing needs to be installed. You see what your role allows; the host decides which rows you see.</div>
      <Input aria-label="Invitation link or server address" placeholder="biforge://open?src=server..., http://192.168.1.20:7878 or BF1-..." value={link} onChange={(_, d) => setLink(d.value)} />
      {guest && guest.view?.state === "waiting" && (
        <div role="status">Connected. Waiting for the host to approve you. The report opens here by itself.</div>
      )}
      {guest && guest.view?.state === "denied" && <div role="alert">{guest.view.reason}</div>}
      {!isLink && !isCode && <Input aria-label="Invitation code" placeholder="Invitation code (bfi_...)" value={invite} onChange={(_, d) => setInvite(d.value)} />}
      {!isLink && !isCode && link.trim().startsWith("https://") && <Input aria-label="Certificate fingerprint" placeholder="Certificate fingerprint of the server (64 hex digits)" value={pin} onChange={(_, d) => setPin(d.value)} />}
      <Input aria-label="Your name" placeholder="Your name" value={name} onChange={(_, d) => setName(d.value)} />
      <details>
        <summary>I run this server (sign in as administrator)</summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          <div style={{ fontSize: 12 }}>Use the address and the admin token biforge-server.exe printed when it started (the token is kept in Windows Credential Manager). With an https server also enter the certificate fingerprint it printed.</div>
          <Input aria-label="Server address" placeholder="https://192.168.1.20:7878" value={adminUrl} onChange={(_, d) => setAdminUrl(d.value)} />
          <Input aria-label="Admin token" type="password" placeholder="Admin token (bfa_...)" value={adminToken} onChange={(_, d) => setAdminToken(d.value)} />
          <Input aria-label="Admin certificate fingerprint" placeholder="Certificate fingerprint (https servers)" value={adminPin} onChange={(_, d) => setAdminPin(d.value)} />
          <div>
            <Button disabled={!adminUrl.trim() || !adminToken.trim() || state.busy} onClick={() => void env.run("server.connectAdmin", { url: adminUrl, token: adminToken, pin: adminPin })}>
              Sign in as administrator
            </Button>
          </div>
        </div>
      </details>
    </Frame>
  );
}
