import { useState, useSyncExternalStore } from "react";
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Textarea } from "@fluentui/react-components";
import type { Comment } from "../../core/collab/types";
import { useEnv } from "./ShellContext";

function shown(text: string): React.ReactNode {
  // @name stands out
  return text.split(/(@[\w.@+-]+)/g).map((part, i) => (part.startsWith("@") ? <strong key={i}>{part}</strong> : part));
}

function Thread({ root, replies }: { root: Comment; replies: Comment[] }) {
  const env = useEnv();
  const [reply, setReply] = useState("");
  const [open, setOpen] = useState(false);
  const line = (c: Comment, isRoot: boolean) => (
    <div key={c.id} style={{ padding: "4px 0", marginLeft: isRoot ? 0 : 18 }}>
      <div style={{ fontSize: 12, opacity: 0.8 }}>
        <strong>{c.author}</strong>
        {` · ${c.createdAt.replace("T", " ").replace("Z", " UTC")}`}
        {isRoot && (c.anchor.page || c.anchor.visual) ? ` · about ${c.anchor.visual ? `visual ${c.anchor.visual}` : `page ${c.anchor.page}`}` : ""}
        {c.resolved && isRoot ? " · resolved" : ""}
      </div>
      <div>{shown(c.text)}</div>
    </div>
  );
  return (
    <li style={{ borderBottom: "1px solid var(--colorNeutralStroke2)", padding: "6px 0", opacity: root.resolved ? 0.65 : 1 }} aria-label={`Comment thread by ${root.author}`}>
      {line(root, true)}
      {replies.map((r) => line(r, false))}
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <Button size="small" onClick={() => setOpen(!open)}>
          Reply
        </Button>
        <Button size="small" onClick={() => void env.run("comments.resolve", { id: root.id, resolved: !root.resolved })}>
          {root.resolved ? "Reopen" : "Resolve"}
        </Button>
        <Button size="small" onClick={() => void env.run("comments.delete", { id: root.id })}>
          Delete
        </Button>
      </div>
      {open && (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <Textarea aria-label={`Reply to ${root.author}`} style={{ flex: 1 }} value={reply} onChange={(_, d) => setReply(d.value)} />
          <Button
            appearance="primary"
            disabled={!reply.trim()}
            onClick={async () => {
              if (await env.run("comments.add", { text: reply, parent: root.id })) {
                setReply("");
                setOpen(false);
              }
            }}
          >
            Send
          </Button>
        </div>
      )}
    </li>
  );
}

export function CommentsDialog() {
  const env = useEnv();
  const ui = env.session.comments;
  const state = useSyncExternalStore(ui.subscribe, ui.getSnapshot);
  const shell = env.session.shell.getSnapshot();
  const coedit = useSyncExternalStore(env.session.subscribe, env.session.getSnapshot).coedit;
  const [text, setText] = useState("");
  const [about, setAbout] = useState(true);
  const selected = shell.selectedVisual;
  const close = () => env.session.shell.closeDialog();
  const roots = state.comments.filter((c) => !c.parent);
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && close()}>
      <DialogSurface aria-label="Comments" style={{ maxWidth: 720, width: "94vw" }}>
        <DialogBody>
          <DialogTitle>Comments</DialogTitle>
          <DialogContent style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: "70vh", overflowY: "auto" }}>
            {state.error && (
              <div role="alert" style={{ color: "var(--colorPaletteRedForeground1)" }}>
                {state.error}
              </div>
            )}
            <div style={{ fontSize: 12 }}>{`Comments are kept ${state.where}.`}</div>
            {state.mentionsMe > 0 && <div role="status">{`You are mentioned in ${state.mentionsMe} open comment${state.mentionsMe === 1 ? "" : "s"}.`}</div>}
            <Textarea aria-label="New comment" placeholder="Write a comment. Use @name to mention someone." value={text} onChange={(_, d) => setText(d.value)} />
            {state.people.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 12 }} aria-label="People to mention">
                {state.people.map((p) => (
                  <Button key={p} size="small" appearance="subtle" onClick={() => setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}@${p} `)}>
                    {`@${p}`}
                  </Button>
                ))}
              </div>
            )}
            {selected && <Checkbox label={`About the selected visual (${selected.visual})`} checked={about} onChange={(_, d) => setAbout(d.checked === true)} />}
            <div>
              <Button
                appearance="primary"
                disabled={!text.trim() || state.busy}
                onClick={async () => {
                  const anchor = selected && about ? { page: selected.page, visual: selected.visual } : {};
                  if (await env.run("comments.add", { text, anchor })) setText("");
                }}
              >
                Add comment
              </Button>
            </div>
            <ul aria-label="Comment threads" style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {roots.length === 0 && <li style={{ fontSize: 12 }}>No comments yet.</li>}
              {roots.map((c) => (
                <Thread key={c.id} root={c} replies={state.comments.filter((r) => r.parent === c.id)} />
              ))}
            </ul>
            {coedit && (
              <details open>
                <summary>{`Changes made together (${state.changes.length})`}</summary>
                <ul aria-label="Recent changes" style={{ margin: "4px 0 0 18px", fontSize: 12 }}>
                  {state.changes.map((c, i) => (
                    <li key={i}>{`${c.time.replace("T", " ").replace("Z", "")}  ${c.actor}: ${c.summary}`}</li>
                  ))}
                </ul>
              </details>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => void env.run("comments.refresh")}>Refresh</Button>
            <Button appearance="primary" onClick={close}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
