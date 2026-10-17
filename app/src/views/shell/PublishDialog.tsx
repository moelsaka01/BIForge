import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Dropdown, Input, Option, Radio, RadioGroup } from "@fluentui/react-components";
import { freeTierLines, getGuide, guideForAdapter, guideHiddenKey, type Guide } from "../../core/publish/guides";
import { PROVIDER_OF } from "../../core/publish/publishUi";
import type { AccessLevel, AdapterInfo, Envelope, IncludedTable, Provider, Target } from "../../core/publish/types";
import { useEnv, useSettings } from "./ShellContext";

const STATUS_TEXT: Record<Target["status"], string> = {
  neverPublished: "Not published yet",
  published: "Published",
  unpublished: "Removed from the destination",
  error: "Last attempt failed",
};

function Frame({ title, onClose, children, actions, label }: { title: string; onClose(): void; children: React.ReactNode; actions: React.ReactNode; label?: string }) {
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface aria-label={label ?? title} style={{ maxWidth: 760, width: "92vw" }}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: "68vh", overflowY: "auto" }}>{children}</DialogContent>
          <DialogActions>{actions}</DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function usePublishUi() {
  const { session } = useEnv();
  const ui = session.publishUi;
  return { ui, state: useSyncExternalStore(ui.subscribe, ui.getSnapshot) };
}

export function dataList(included: IncludedTable[]): string {
  return included.map((t) => `${t.table}: ${t.columns.join(", ")}`).join("\n");
}

// ---- connecting an account ----

const PROVIDER_NAME: Record<Provider, string> = { github: "GitHub", cloudflare: "Cloudflare" };
const GUIDE_OF: Record<Provider, string> = { github: "static-github-pages", cloudflare: "static-cloudflare-pages" };

/** The click-by-click steps and the field where the token is pasted. The token goes straight to the Windows Credential Manager. */
export function ConnectPanel({ provider }: { provider: Provider }) {
  const env = useEnv();
  const { state } = usePublishUi();
  const [token, setToken] = useState("");
  const [accountId, setAccountId] = useState("");
  const name = PROVIDER_NAME[provider];
  const account = state.connected[provider];
  const steps = getGuide(GUIDE_OF[provider])?.steps ?? [];
  if (account !== undefined)
    return (
      <div role="status" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span>{account ? `${name} is connected as ${account}.` : `${name} is connected.`}</span>
        <Button size="small" onClick={() => void env.run("account.disconnect", { provider })}>
          Disconnect {name}
        </Button>
      </div>
    );
  return (
    <div role="group" aria-label={`Connect ${name}`} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <ol aria-label={`How to get a ${name} token`} style={{ margin: "0 0 0 18px" }}>
        {steps.map((st) => (
          <li key={st}>{st}</li>
        ))}
      </ol>
      {provider === "cloudflare" && <Input aria-label="Cloudflare account ID" placeholder="Account ID (32 letters and digits)" value={accountId} onChange={(_, d) => setAccountId(d.value)} />}
      <Input aria-label={`${name} token`} type="password" placeholder={provider === "github" ? "Token (ghp_…)" : "API token"} value={token} onChange={(_, d) => setToken(d.value)} />
      <div style={{ fontSize: 12, opacity: 0.8 }}>The token is kept in Windows Credential Manager. It is never written into the project, a package or a log.</div>
      <div>
        <Button
          appearance="primary"
          disabled={!token.trim() || state.busy || (provider === "cloudflare" && !accountId.trim())}
          onClick={async () => {
            const ok = await env.run("account.connect", { provider, token, accountId });
            if (ok) setToken("");
          }}
        >
          Connect {name}
        </Button>
      </div>
      {state.error && <div role="alert" style={{ color: "var(--colorPaletteRedForeground1)" }}>{state.error}</div>}
    </div>
  );
}

// ---- the setup pop-up ----

export function GuideView({ guide, adapters, included, onDone, onFolder }: { guide: Guide; adapters: AdapterInfo[]; included: IncludedTable[]; onDone(): void; onFolder?(folder: string): void }) {
  const env = useEnv();
  const [how, setHow] = useState(false);
  const [dont, setDont] = useState(false);
  const free = freeTierLines(guide, adapters);
  const finish = () => {
    if (dont) env.session.shell.settings.setOption(guideHiddenKey(guide.id), true);
    onDone();
  };
  return (
    <div role="group" aria-label={guide.title} className="guide">
      <h3 style={{ margin: 0 }}>{guide.title}</h3>
      {guide.paragraphs.map((p) => (
        <p key={p} style={{ margin: "4px 0" }}>
          {p}
        </p>
      ))}
      {guide.listsData && (
        <ul aria-label="Tables and columns that will leave this computer" style={{ margin: "0 0 0 18px" }}>
          {included.length === 0 ? <li>No tables are selected.</li> : included.map((t) => <li key={t.table}>{`${t.table}: ${t.columns.join(", ")}`}</li>)}
        </ul>
      )}
      {guide.buttons.map((b) => (b.action.kind === "connect" ? <ConnectPanel key={b.id} provider={b.action.provider} /> : null))}
      {how && guide.howItWorks && (
        <ul aria-label="How it works" style={{ margin: "0 0 0 18px" }}>
          {guide.howItWorks.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {free.length > 0 && (
        <div>
          <strong>Free limits</strong>
          <ul style={{ margin: "2px 0 0 18px" }}>
            {free.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {guide.buttons.map((b) => {
          const a = b.action;
          if (a.kind === "connect") return null;
          if (a.kind === "notImplemented")
            return (
              <Button key={b.id} disabled title={`Not implemented yet (planned for phase ${a.phase})`}>
                {b.label} (not implemented)
              </Button>
            );
          return (
            <Button
              key={b.id}
              appearance={b.primary ? "primary" : "secondary"}
              onClick={async () => {
                if (a.kind === "reveal") return setHow((v) => !v);
                if (a.kind === "pickFolder") {
                  const f = await env.session.dialogs.pickFolder();
                  if (f && onFolder) onFolder(f);
                  return;
                }
                finish();
              }}
            >
              {b.label}
            </Button>
          );
        })}
        <Checkbox label="Don't show again" checked={dont} onChange={(_, d) => setDont(d.checked === true)} />
      </div>
    </div>
  );
}

/** A guide opened on its own (for example "Using a server?" in the open dialog). */
export function GuideDialog({ guideId }: { guideId: string }) {
  const env = useEnv();
  const { state } = usePublishUi();
  const guide = getGuide(guideId);
  const close = () => env.session.shell.closeDialog();
  if (!guide) return null;
  return (
    <Frame title={guide.title} onClose={close} actions={<Button onClick={close}>Close</Button>}>
      <GuideView guide={guide} adapters={state.adapters} included={[]} onDone={close} />
    </Frame>
  );
}

// ---- Publish & Share ----

function ChooseData() {
  const { ui, state } = usePublishUi();
  return (
    <fieldset style={{ border: "1px solid var(--colorNeutralStroke2)", padding: 8 }}>
      <legend>What leaves this computer</legend>
      {state.available.length === 0 && <div>No data is loaded. Refresh the data first.</div>}
      {state.available.map((t) => {
        const chosen = state.chosen.find((c) => c.table === t.table)?.columns ?? [];
        return (
          <div key={t.table}>
            <Checkbox
              label={`${t.table} (${chosen.length} of ${t.columns.length} columns)`}
              checked={chosen.length === t.columns.length ? true : chosen.length === 0 ? false : "mixed"}
              onChange={(_, d) => ui.setChosen(t.table, null, d.checked === true)}
            />
            <div style={{ marginLeft: 24, display: "flex", flexWrap: "wrap", columnGap: 12 }}>
              {t.columns.map((c) => (
                <Checkbox key={c} label={c} checked={chosen.includes(c)} onChange={(_, d) => ui.setChosen(t.table, c, d.checked === true)} />
              ))}
            </div>
          </div>
        );
      })}
      {state.warnings.length > 0 && (
        <ul aria-label="Warnings about the published copy" style={{ margin: "6px 0 0 18px", color: "var(--colorPaletteDarkOrangeForeground1)" }}>
          {state.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

function AddDestination({ onAdded }: { onAdded(): void }) {
  const env = useEnv();
  const settings = useSettings();
  const { ui, state } = usePublishUi();
  const [adapterId, setAdapterId] = useState("local-folder");
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState<AccessLevel>("private");
  const [folder, setFolder] = useState("");
  const [repo, setRepo] = useState("");
  const [accountId, setAccountId] = useState("");
  const [siteName, setSiteName] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const projectSlug = (env.session.store.project?.name ?? "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "report";
  const info = state.adapters.find((a) => a.id === adapterId);
  const guide = guideForAdapter(adapterId);
  const caps = info?.capabilities;
  const accessOk = caps ? (access === "public" ? caps.publicAccess : caps.privateAccess) : false;
  const hidden = settings.options[guideHiddenKey(guide?.id ?? "")] === true;
  const add = async () => {
    const settings: Record<string, string> =
      adapterId === "local-folder" ? { folder } : adapterId === "github-pages" ? { repo: repo.trim() || `biforge-${projectSlug}` } : adapterId === "cloudflare-pages" ? { accountId: accountId.trim(), name: siteName.trim() || `biforge-${projectSlug}` } : {};
    const ok = await env.run("publish.addTarget", { adapterId, label, access, settings });
    if (ok) onAdded();
  };
  const startAdd = () => (guide && !hidden ? setGuideOpen(true) : void add());
  if (guideOpen && guide)
    return (
      <GuideView
        guide={guide}
        adapters={state.adapters}
        included={ui.selection()}
        onDone={() => {
          setGuideOpen(false);
          void add();
        }}
        onFolder={(f) => setFolder(f)}
      />
    );
  return (
    <fieldset style={{ border: "1px solid var(--colorNeutralStroke2)", padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
      <legend>Add a destination</legend>
      <Dropdown
        aria-label="Destination type"
        value={info ? (info.capabilities.implemented ? info.name : `${info.name} - not implemented (planned ${info.phase})`) : ""}
        selectedOptions={[adapterId]}
        onOptionSelect={(_, d) => setAdapterId(d.optionValue ?? "local-folder")}
      >
        {state.adapters.map((a) => (
          <Option key={a.id} value={a.id} text={a.name} disabled={!a.capabilities.implemented}>
            {a.capabilities.implemented ? a.name : `${a.name} - not implemented (planned ${a.phase})`}
          </Option>
        ))}
      </Dropdown>
      <Input aria-label="Destination name" placeholder="Name for this destination" value={label} onChange={(_, d) => setLabel(d.value)} />
      <RadioGroup layout="horizontal" value={access} onChange={(_, d) => setAccess(d.value as AccessLevel)} aria-label="Access level">
        <Radio value="private" label="Private (encrypted, needs an access key)" disabled={!caps?.privateAccess} />
        <Radio value="public" label="Public (not encrypted)" disabled={!caps?.publicAccess} />
      </RadioGroup>
      {adapterId === "local-folder" && (
        <div style={{ display: "flex", gap: 6 }}>
          <Input aria-label="Folder" style={{ flex: 1 }} placeholder="C:\Shared\Reports" value={folder} onChange={(_, d) => setFolder(d.value)} />
          <Button onClick={async () => setFolder((await env.session.dialogs.pickFolder()) ?? folder)}>Browse…</Button>
        </div>
      )}
      {adapterId === "github-pages" && <Input aria-label="Repository name" placeholder={`Repository for the site (default biforge-${projectSlug})`} value={repo} onChange={(_, d) => setRepo(d.value)} />}
      {adapterId === "cloudflare-pages" && (
        <>
          <Input aria-label="Cloudflare account ID" placeholder="Account ID (32 letters and digits)" value={accountId} onChange={(_, d) => setAccountId(d.value)} />
          <Input aria-label="Site name" placeholder={`Site name (default biforge-${projectSlug})`} value={siteName} onChange={(_, d) => setSiteName(d.value)} />
        </>
      )}
      {info && info.limitations.length > 0 && (
        <ul aria-label="Limitations" style={{ margin: "0 0 0 18px", fontSize: 12 }}>
          {info.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <div>
        <Button appearance="primary" disabled={!caps?.implemented || !accessOk || !label.trim() || (adapterId === "local-folder" && !folder.trim()) || (adapterId === "cloudflare-pages" && !accountId.trim())} onClick={startAdd}>
          Add destination
        </Button>
        {guide && hidden && (
          <Button appearance="subtle" onClick={() => setGuideOpen(true)}>
            Show the setup guide
          </Button>
        )}
      </div>
    </fieldset>
  );
}

function TargetDetails({ target, info }: { target: Target; info: AdapterInfo }) {
  const env = useEnv();
  const { ui, state } = usePublishUi();
  const settings = useSettings();
  const c = info.capabilities;
  const published = target.status === "published";
  const [name, setName] = useState(typeof settings.options["publish.publisherName"] === "string" ? (settings.options["publish.publisherName"] as string) : "");
  const [shown, setShown] = useState<string | null>(null);
  const blocked = state.issues.find((i) => i.severity === "error");
  const sel = ui.selection();
  const provider = PROVIDER_OF[target.adapterId];
  const isStatic = info.method === "staticHosting";
  const canPublish = c.implemented && !state.busy && !blocked && sel.length > 0 && ui.confirmed && name.trim() !== "" && (target.status !== "published" || c.update);
  const row = (k: string, v: React.ReactNode) => (
    <div style={{ display: "flex", gap: 8 }}>
      <span style={{ width: 130, opacity: 0.75 }}>{k}</span>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{v}</span>
    </div>
  );
  return (
    <section aria-label={`Destination ${target.label}`} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {row("Destination", `${target.label} (${info.name})`)}
      {row("Status", STATUS_TEXT[target.status])}
      {row("Access level", target.access === "private" ? "Private (encrypted)" : "Public (not encrypted)")}
      {row("Account", c.needsAccount ? (target.account ?? "Not connected") : "None needed")}
      {row("Last sync", target.lastSync ?? "Never")}
      {row("Version", target.lastVersion === null ? "-" : String(target.lastVersion))}
      {target.lastError && <div role="alert" style={{ color: "var(--colorPaletteRedForeground1)" }}>{target.lastError}</div>}
      {!c.implemented && <div role="note">Not implemented yet (planned for phase {info.phase}). Nothing can be published here.</div>}
      {provider && state.connected[provider] === undefined && (
        <details open>
          <summary>Connect {PROVIDER_NAME[provider]}</summary>
          <ConnectPanel provider={provider} />
        </details>
      )}
      {provider && state.connected[provider] !== undefined && <ConnectPanel provider={provider} />}
      {state.issues.map((i) => (
        <div key={i.message} role={i.severity === "error" ? "alert" : "note"} style={{ color: i.severity === "error" ? "var(--colorPaletteRedForeground1)" : undefined }}>
          {i.severity === "error" ? "Problem: " : "Note: "}
          {i.message}
        </div>
      ))}
      <details>
        <summary>Limitations of this destination</summary>
        <ul style={{ margin: "4px 0 0 18px" }}>
          {info.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </details>
      {c.implemented && (
        <>
          <ChooseData />
          <Checkbox
            label={
              isStatic
                ? "I have checked this list. I understand that these tables and columns will be put on a public web address and leave this computer: anyone on the internet can download them (a private report is encrypted, but the encrypted file is public)."
                : "I have checked this list: these tables and columns will leave this computer."
            }
            checked={ui.confirmed}
            disabled={sel.length === 0}
            onChange={(_, d) => ui.confirmShown(d.checked === true)}
          />
          <Input
            aria-label="Publisher name"
            placeholder="Your name, shown to viewers"
            value={name}
            onChange={(_, d) => {
              setName(d.value);
              env.session.shell.settings.setOption("publish.publisherName", d.value);
            }}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button appearance="primary" disabled={!canPublish} onClick={() => void env.run("publish.run", { publisherName: name })}>
              {published ? "Publish update" : "Publish"}
            </Button>
            {c.keyRotation && target.access === "private" && published && (
              <Button disabled={!canPublish} onClick={() => void env.run("publish.run", { publisherName: name, rotate: true })} title="Makes a new access key. People with the old key cannot open the new version; copies they already have stay readable.">
                Revoke access (new key)
              </Button>
            )}
            {c.shareLink && published && <Button onClick={() => void env.run("publish.link")}>Create share link</Button>}
            {target.access === "private" && published && (
              <Button onClick={async () => setShown(await ui.showAccessKey())}>Show access key</Button>
            )}
            {c.unpublish && published && <Button onClick={() => void env.run("publish.unpublish")}>Stop sharing</Button>}
            <Button appearance="subtle" onClick={() => void env.run("publish.removeTarget", { id: target.id })}>
              Remove destination
            </Button>
          </div>
        </>
      )}
      {state.outcome && state.outcome.targetId === target.id && (
        <div role="status" style={{ border: "1px solid var(--colorNeutralStroke2)", padding: 8 }}>
          {state.outcome.rotated ? "Access revoked: version " : "Published version "}
          {state.outcome.state.version} to {state.outcome.state.location}.
          {state.outcome.newAccessKey && (
            <div>
              <strong>Access key (shown once here; keep it safe and send it separately from the link):</strong>
              <div style={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>{state.outcome.newAccessKey}</div>
              <Button size="small" onClick={() => void navigator.clipboard?.writeText(state.outcome!.newAccessKey!)}>
                Copy key
              </Button>
            </div>
          )}
        </div>
      )}
      {shown && (
        <div role="status" style={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>
          {shown}
        </div>
      )}
      {state.link && (
        <div role="status">
          Share link (it does not contain the access key): <span style={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>{state.link}</span>{" "}
          <Button size="small" onClick={() => void navigator.clipboard?.writeText(state.link!)}>
            Copy link
          </Button>
        </div>
      )}
    </section>
  );
}

export function PublishDialog() {
  const env = useEnv();
  const { ui, state } = usePublishUi();
  const [adding, setAdding] = useState(false);
  const close = () => env.session.shell.closeDialog();
  const target = state.targets.find((t) => t.id === state.selected) ?? null;
  const info = target ? state.adapters.find((a) => a.id === target.adapterId) : undefined;
  return (
    <Frame title="Publish & Share" onClose={close} actions={<Button appearance="primary" onClick={close}>Close</Button>} label="Publish and Share">
      {state.error && <div role="alert" style={{ color: "var(--colorPaletteRedForeground1)" }}>{state.error}</div>}
      <div style={{ fontSize: 12, opacity: 0.8 }}>
        BIForge has no servers and costs nothing: you share through a folder, a free account of your own, or your own computer. Row-level security is only enforced by a hosted workspace (not available yet); packages show everything they contain to everyone who can open them.
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }} role="tablist" aria-label="Destinations of this report">
        {state.targets.map((t) => (
          <Button key={t.id} role="tab" aria-selected={t.id === state.selected} appearance={t.id === state.selected ? "primary" : "secondary"} onClick={() => void ui.select(t.id)}>
            {t.label}
          </Button>
        ))}
        <Button appearance="subtle" onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "Add a destination"}
        </Button>
      </div>
      {(adding || state.targets.length === 0) && <AddDestination onAdded={() => setAdding(false)} />}
      {target && info && !adding && <TargetDetails target={target} info={info} />}
      {state.audit.length > 0 && (
        <details>
          <summary>Activity log ({state.audit.length})</summary>
          <ul style={{ margin: "4px 0 0 18px", fontSize: 12 }}>
            {[...state.audit].reverse().map((a) => (
              <li key={`${a.time}${a.event}${a.targetId}`}>{`${a.time}  ${a.event}  ${a.detail}`}</li>
            ))}
          </ul>
        </details>
      )}
    </Frame>
  );
}

// ---- open a shared report ----

export function OpenPackageDialog({ request }: { request: { path?: string; feedUrl?: string; fromLink?: boolean } }) {
  const env = useEnv();
  const { state } = usePublishUi();
  const [path, setPath] = useState(request.path ?? "");
  const [env_, setEnv] = useState<Envelope | null>(null);
  const [key, setKey] = useState("");
  const [link, setLink] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState("");
  const [pin, setPin] = useState<string | null>(null);
  const [keep, setKeep] = useState(true);
  const feedUrl = request.feedUrl;
  const close = () => env.session.shell.closeDialog();

  // a link to a static host: download the package first (nothing is opened yet), then show what it is
  useEffect(() => {
    if (!feedUrl) return;
    let live = true;
    setBusy(true);
    env.session
      .publish!.linkedFetch(feedUrl)
      .then((l) => {
        if (!live) return;
        setPath(l.path);
        setChecked(l.path);
        setEnv(l.envelope);
        setPin(l.existingPin);
      })
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedUrl]);

  const check = async (p: string) => {
    setErr(null);
    setEnv(null);
    setChecked(p);
    if (!p) return;
    try {
      setEnv(await env.session.publish!.peek(p));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  if (!feedUrl && path && checked !== path && !err) void check(path);

  const open = async () => {
    setBusy(true);
    const ok = await env.run("package.open.run", { path, accessKey: key, feedUrl, expectedPublisher: pin, subscribe: keep });
    setBusy(false);
    if (!ok) setErr(env.error ?? "The report could not be opened.");
  };
  const needsKey = env_?.encrypted === true;
  return (
    <Frame
      title="Open a shared report"
      onClose={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button appearance="primary" disabled={!env_ || busy || (needsKey && key.trim() === "")} onClick={() => void open()}>
            Open for viewing
          </Button>
        </>
      }
    >
      {request.fromLink && <div role="note">This link came from outside BIForge. Check the file and publisher below before opening it.</div>}
      {feedUrl && <div>Address: <span style={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>{feedUrl}</span></div>}
      <div style={{ display: "flex", gap: 6 }}>
        <Input aria-label="Report file" disabled={!!feedUrl} style={{ flex: 1 }} placeholder="Path of a .biforge file" value={path} onChange={(_, d) => setPath(d.value)} />
        <Button
          onClick={async () => {
            const p = await env.session.dialogs.pickFile("BIForge shared report", ["biforge"]);
            if (p) setPath(p);
          }}
        >
          Browse…
        </Button>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <Input aria-label="Link" style={{ flex: 1 }} placeholder="Or paste a biforge:// link" value={link} onChange={(_, d) => setLink(d.value)} />
        <Button
          disabled={!link.trim()}
          onClick={async () => {
            const ok = await env.run("link.open", { link: link.trim() });
            if (!ok) setErr(env.error ?? "The link could not be used.");
          }}
        >
          Use link
        </Button>
      </div>
      {err && <div role="alert" style={{ color: "var(--colorPaletteRedForeground1)" }}>{err}</div>}
      {env_ && (
        <section aria-label="Package details">
          <div>Signature: valid (the file is unchanged since the publisher signed it).</div>
          <div>Publisher key: {env_.publisherPublicKey.slice(0, 16)}… Check with the publisher that this is theirs.</div>
          <div>Version {env_.version}, {env_.access === "private" ? "private (encrypted)" : "public (not encrypted)"}.</div>
          {pin ? <div>You have opened this report before: the publisher is checked against the key you accepted then.</div> : feedUrl ? <div>First time: BIForge will remember this publisher key and refuse later versions signed by anyone else.</div> : null}
          <div>It opens as a read-only view. Nothing in the report is run and nothing is saved on this computer except a temporary copy.</div>
        </section>
      )}
      {feedUrl && <Checkbox label="Keep this report and let me check for updates (the access key, if any, is kept in Windows Credential Manager)" checked={keep} onChange={(_, d) => setKeep(d.checked === true)} />}
      {needsKey && <Input aria-label="Access key" type="password" placeholder="Access key (AGE-SECRET-KEY-…)" value={key} onChange={(_, d) => setKey(d.value)} />}
      <details>
        <summary>Using a server or another way of sharing?</summary>
        {(() => {
          const g = getGuide("backend-connect")!;
          return <GuideView guide={g} adapters={state.adapters} included={[]} onDone={() => undefined} />;
        })()}
      </details>
    </Frame>
  );
}

