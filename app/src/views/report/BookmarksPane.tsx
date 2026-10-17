import { useState } from "react";
import { Button, Checkbox, Input, Select, Switch } from "@fluentui/react-components";
import { listBookmarkGroups, listBookmarks } from "../../core/report/bookmarks";
import { useReport } from "./reportContext";

export function BookmarksPane() {
  const c = useReport();
  const list = listBookmarks(c.project);
  const groups = listBookmarkGroups(c.project);
  const [name, setName] = useState("");
  const [ticked, setTicked] = useState<string[]>([]);
  const [groupName, setGroupName] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const selected = list.find((b) => b.id === sel);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 8, height: "100%", overflow: "auto" }} aria-label="Bookmarks pane">
      <div style={{ display: "flex", gap: 4 }}>
        <Input size="small" style={{ flex: 1 }} aria-label="Bookmark name" placeholder="New bookmark name" value={name} onChange={(_, d) => setName(d.value)} />
        <Button
          size="small"
          appearance="primary"
          onClick={() => {
            c.dispatch("report.bookmark.add", { name });
            setName("");
          }}
        >
          Add
        </Button>
      </div>
      <div role="list" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {list.map((b, i) => {
          const g = b.group ? groups.find((x) => x.id === b.group) : undefined;
          const firstOfGroup = g && list.findIndex((x) => x.group === b.group) === i;
          return (
            <div key={b.id} role="presentation" style={{ display: "contents" }}>
              {firstOfGroup && g && (
                <div role="group" aria-label={`Bookmark group ${g.name}`} style={{ display: "flex", alignItems: "center", gap: 4, fontWeight: 600, marginTop: 4 }}>
                  <span style={{ flex: 1 }}>▾ {g.name}</span>
                  <button
                    aria-label={`Rename group ${g.name}`}
                    onClick={() => {
                      const n = window.prompt("Group name", g.name);
                      if (n !== null) c.dispatch("report.bookmark.group.rename", { id: g.id, name: n });
                    }}
                    style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer" }}
                  >
                    ✎
                  </button>
                  <button aria-label={`Ungroup ${g.name}`} onClick={() => c.dispatch("report.bookmark.group.ungroup", { id: g.id })} style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer" }}>
                    ⤴
                  </button>
                  <button aria-label={`Delete group ${g.name}`} onClick={() => c.dispatch("report.bookmark.group.delete", { id: g.id })} style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer" }}>
                    ✕
                  </button>
                </div>
              )}
              <div role="listitem" style={{ display: "flex", alignItems: "center", gap: 2, marginLeft: b.group ? 14 : 0, background: sel === b.id ? "#e8f1fb" : undefined, borderRadius: 3, color: sel === b.id ? "#123" : undefined }}>
                <Checkbox aria-label={`Select bookmark ${b.name}`} checked={ticked.includes(b.id)} onChange={(_, d) => setTicked(d.checked ? [...ticked, b.id] : ticked.filter((x) => x !== b.id))} />
                <button
                  aria-label={`Apply bookmark ${b.name}`}
                  onClick={() => {
                    setSel(b.id);
                    c.dispatch("report.bookmark.apply", { id: b.id });
                  }}
                  style={{ flex: 1, textAlign: "left", border: "none", background: "transparent", color: "inherit", padding: "4px 6px", cursor: "pointer", font: "inherit" }}
                >
                  {b.name}
                </button>
                <button aria-label={`Options for bookmark ${b.name}`} onClick={() => setSel(sel === b.id ? null : b.id)} style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer" }}>
                  ⋯
                </button>
                <button aria-label={`Move ${b.name} up`} disabled={i === 0} onClick={() => c.dispatch("report.bookmark.move", { id: b.id, index: i - 1 })} style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer" }}>
                  ↑
                </button>
              </div>
            </div>
          );
        })}
        {list.length === 0 && <span style={{ fontSize: 12, opacity: 0.7 }}>No bookmarks yet. Set up the page the way you want it, then choose Add.</span>}
      </div>
      {list.length > 1 && (
        <div style={{ display: "flex", gap: 4 }}>
          <Input size="small" style={{ flex: 1 }} aria-label="Group name" placeholder="Group name" value={groupName} onChange={(_, d) => setGroupName(d.value)} />
          <Button
            size="small"
            disabled={ticked.length === 0 || !groupName.trim()}
            onClick={() => {
              c.dispatch("report.bookmark.group", { name: groupName, ids: list.filter((b) => ticked.includes(b.id)).map((b) => b.id) });
              setGroupName("");
              setTicked([]);
            }}
          >
            Group
          </Button>
        </div>
      )}
      {selected && (
        <div role="group" aria-label={`Bookmark ${selected.name}`} style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: "1px solid #ddd", paddingTop: 6 }}>
          <Button size="small" onClick={() => c.dispatch("report.bookmark.update", { id: selected.id })}>
            Update to the current view
          </Button>
          <Button
            size="small"
            onClick={() => {
              const n = window.prompt("Bookmark name", selected.name);
              if (n !== null) c.dispatch("report.bookmark.rename", { id: selected.id, name: n });
            }}
          >
            Rename
          </Button>
          {groups.length > 0 && (
            <Select aria-label="Group of this bookmark" value={selected.group ?? ""} onChange={(_, d) => c.dispatch("report.bookmark.moveToGroup", { id: selected.id, group: d.value || null })}>
              <option value="">(no group)</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          )}
          <Switch label="Data (filters, slicers, drill)" checked={selected.options.data} onChange={(_, d) => c.dispatch("report.bookmark.setOptions", { id: selected.id, options: { ...selected.options, data: d.checked } })} />
          <Switch label="Display (hidden visuals)" checked={selected.options.display} onChange={(_, d) => c.dispatch("report.bookmark.setOptions", { id: selected.id, options: { ...selected.options, display: d.checked } })} />
          <Switch label="Stay on the current page" checked={selected.options.currentPage} onChange={(_, d) => c.dispatch("report.bookmark.setOptions", { id: selected.id, options: { ...selected.options, currentPage: d.checked } })} />
          <Button size="small" onClick={() => c.dispatch("report.bookmark.delete", { id: selected.id })}>
            Delete
          </Button>
        </div>
      )}
    </div>
  );
}
