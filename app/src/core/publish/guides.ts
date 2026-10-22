// Setup guides: the pop-up shown the first time a sharing method is used. Plain language, what is needed, what
// the buttons do, nothing that costs money. A button for something that is not built yet is shown disabled with the
// phase that builds it (nothing is simulated). Wording and buttons are data so tests can check them.
import type { AdapterInfo } from "./types";

export type GuideAction =
  | { kind: "continue" }
  | { kind: "reveal" }
  | { kind: "pickFolder" }
  | { kind: "pickPackage" }
  | { kind: "connect"; provider: "github" | "cloudflare" }
  | { kind: "connectStorage"; provider: "google-drive" | "onedrive" | "dropbox" }
  | { kind: "openHost" }
  | { kind: "openJoin" }
  | { kind: "notImplemented"; phase: string };

export interface GuideButton {
  id: string;
  label: string;
  primary?: boolean;
  action: GuideAction;
}

export interface Guide {
  id: string;
  title: string;
  paragraphs: string[];
  /** Click-by-click steps to get the token this method needs (shown with the Connect button). */
  steps?: string[];
  /** Shown after "How it works" is pressed. */
  howItWorks?: string[];
  /** The pop-up lists the tables and columns that will leave this computer. */
  listsData: boolean;
  buttons: GuideButton[];
}

export const GUIDE_FOR_ADAPTER: Record<string, string> = {
  "local-folder": "local-folder",
  "github-pages": "static-github-pages",
  "cloudflare-pages": "static-cloudflare-pages",
  "google-drive": "storage-google-drive",
  onedrive: "storage-onedrive",
  dropbox: "storage-dropbox",
  p2p: "p2p",
  "host-from-pc": "backend-host",
  "biforge-server": "backend-host",
};

const STATIC_COMMON = [
  "Your report is published as a file on a free web address. Anyone who has the address can download the file.",
  "Public: anyone can open it. Private: the file is locked (encrypted) and only people you give the access key to can open it. The file itself is still downloadable by anyone, and the data inside a private report is only as safe as the key.",
  "You need a free account. BIForge never asks for a payment card, and if a provider ever asks for one at sign-up, do not enter it: choose another destination.",
  "These tables and columns will leave this computer:",
];

const GUIDES: Guide[] = [
  {
    id: "local-folder",
    title: "Share through a folder",
    paragraphs: [
      "BIForge saves the report as one file in a folder you choose. You can pick a shared network folder, or a folder that a sync tool copies to other people. No account is needed.",
      "Public: anyone who can open the folder can read the report. Private: the file is locked and people need the access key BIForge shows you after publishing.",
      "These tables and columns will leave this computer:",
    ],
    listsData: true,
    buttons: [
      { id: "folder", label: "Choose folder", primary: true, action: { kind: "pickFolder" } },
      { id: "ok", label: "Continue", action: { kind: "continue" } },
    ],
  },
  {
    id: "static-github-pages",
    title: "Publish with GitHub Pages",
    paragraphs: [...STATIC_COMMON, "A free GitHub account is required. On the free plan GitHub Pages only serves public repositories, so a private report is a locked file in a public place. BIForge makes one repository for the report (or reuses the one it made) and never touches your other repositories."],
    steps: [
      "Open github.com and sign in. Click your picture (top right), then Settings.",
      "At the bottom of the left menu click Developer settings, then Personal access tokens, then Tokens (classic).",
      "Click Generate new token, then Generate new token (classic). Name it BIForge and pick an expiry (90 days is fine).",
      "Tick the boxes repo and workflow (workflow is only needed for scheduled refresh). Leave the others empty.",
      "Click Generate token at the bottom, copy the token (it starts with ghp_), and paste it below. GitHub shows it only once.",
    ],
    listsData: true,
    buttons: [
      { id: "connect", label: "Connect GitHub", primary: true, action: { kind: "connect", provider: "github" } },
      { id: "ok", label: "Continue", action: { kind: "continue" } },
    ],
  },
  {
    id: "static-cloudflare-pages",
    title: "Publish with Cloudflare",
    paragraphs: [...STATIC_COMMON, "A free Cloudflare account is required. The report is served from a free address of the form name.your-subdomain.workers.dev. BIForge has not been run against a real Cloudflare account yet, so the first publish may reveal problems; it will tell you."],
    steps: [
      "Open dash.cloudflare.com and sign in (create a free account if you have none; no card is needed).",
      "In the left menu open Workers & Pages once. If it asks you to choose a workers.dev subdomain, pick one.",
      "Your Account ID: on the same page, copy the Account ID shown on the right side, or open the three-dot menu next to your account name and choose Copy account ID.",
      "Click your picture (top right), then My Profile, then API Tokens, then Create Token, then Create Custom Token.",
      "Name it BIForge. Under Permissions choose Account, Workers Scripts, Edit. Under Account Resources choose your account. Click Continue to summary, then Create Token.",
      "Copy the token (shown once) and paste it below together with your Account ID.",
    ],
    listsData: true,
    buttons: [
      { id: "connect", label: "Connect Cloudflare", primary: true, action: { kind: "connect", provider: "cloudflare" } },
      { id: "ok", label: "Continue", action: { kind: "continue" } },
    ],
  },
  ...[
    ["storage-google-drive", "Google Drive", "Connect Google Drive", "google-drive"],
    ["storage-onedrive", "OneDrive", "Connect OneDrive", "onedrive"],
    ["storage-dropbox", "Dropbox", "Connect Dropbox", "dropbox"],
  ].map(
    ([id, name, button, provider]): Guide => ({
      id,
      title: `Share through ${name}`,
      paragraphs: [
        `This shares the editable project file through your ${name}, not a live dashboard. People you invite through ${name} open the file in BIForge.`,
        `Choose the ${name} account you want to use. BIForge asks ${name} for permission with a sign-in page in your browser; the sign-in token is kept in Windows Credential Manager and never in the project.`,
        "The files BIForge uploads count against your free storage.",
        "These tables and columns will leave this computer:",
      ],
      listsData: true,
      buttons: [
        { id: "connect", label: button, primary: true, action: { kind: "connectStorage", provider: provider as "google-drive" | "onedrive" | "dropbox" } },
        { id: "ok", label: "Continue", action: { kind: "continue" } },
      ],
    }),
  ),
  {
    id: "p2p",
    title: "Connect directly with another person",
    paragraphs: [
      "BIForge connects your computer to the other person's computer with an encrypted direct connection. Both of you must be online at the same time, and BIForge must stay open.",
      "It may not work on some networks (for example, some company or school networks). If it cannot connect, BIForge tells you and you can use another method such as a folder or a cloud drive.",
      "You start a session and read a pairing code to the other person. Nothing is shared until you approve them.",
    ],
    listsData: false,
    buttons: [
      { id: "start", label: "Start session", primary: true, action: { kind: "continue" } },
      { id: "join", label: "Join with code", action: { kind: "openJoin" } },
    ],
  },
  {
    id: "backend-host",
    title: "Host a shared workspace",
    paragraphs: [
      "To host a shared workspace for others, either turn on Host from this PC (BIForge must stay open and this PC online), or install biforge-server.exe on a computer that stays on.",
      "Only a hosted workspace can restrict who sees which rows (row-level security). It is free: it runs on your own computer.",
    ],
    howItWorks: [
      "Host from this PC: BIForge itself answers requests from the people you invite, while it is open.",
      "biforge-server.exe: the same engine as a small program for a computer that is always on (no Docker needed).",
      "People you invite get an invite link or a server address. They do not need to install anything but BIForge.",
    ],
    listsData: false,
    buttons: [
      { id: "host", label: "Turn on Host from this PC", primary: true, action: { kind: "openHost" } },
      { id: "download", label: "Download biforge-server.exe", action: { kind: "notImplemented", phase: "O8" } },
      { id: "how", label: "How it works", action: { kind: "reveal" } },
      { id: "continue", label: "Continue", action: { kind: "continue" } },
    ],
  },
  {
    id: "backend-connect",
    title: "Connect to a shared workspace",
    paragraphs: ["Enter the server address your host gave you, or open the invite link they sent.", "Nothing needs to be installed."],
    listsData: false,
    buttons: [
      { id: "enter", label: "Enter server address", primary: true, action: { kind: "openJoin" } },
      { id: "link", label: "Open invite link", action: { kind: "openJoin" } },
    ],
  },
  {
    id: "scheduled-refresh",
    title: "Scheduled refresh",
    paragraphs: [
      "A refresh needs a computer that runs it. GitHub Actions (available for reports published with GitHub Pages) is a free robot in your public GitHub repository that reloads files copied into that repository: nothing on this PC has to stay on, but the whole source files go to GitHub.",
      "This PC: Windows Task Scheduler starts BIForge without a window at the time you choose. This PC must be on and you must be signed in; the sources are read where they are, with the credentials stored on this PC.",
      "A server you host (Host from this PC or biforge-server.exe): the server computer runs the refresh and must stay on. It reloads the source files copied to it, or files you put in the report's source folder on the server.",
      "Every refresh is retried after a failure, only one refresh of a report runs at a time, and the history says where each one ran. BIForge always tells you where the refresh will run and what must stay on.",
    ],
    listsData: false,
    buttons: [{ id: "setup", label: "Set up scheduled refresh", primary: true, action: { kind: "continue" } }],
  },
];

export function getGuide(id: string): Guide | undefined {
  return GUIDES.find((g) => g.id === id);
}

export function allGuides(): Guide[] {
  return GUIDES;
}

export function guideForAdapter(adapterId: string): Guide | undefined {
  const id = GUIDE_FOR_ADAPTER[adapterId];
  return id ? getGuide(id) : undefined;
}

export const guideHiddenKey = (guideId: string) => `publish.guide.${guideId}.hidden`;

/** The provider's free-tier limits shown in the pop-up: taken from the adapter so they cannot drift from the dialog. */
export function freeTierLines(guide: Guide, adapters: AdapterInfo[]): string[] {
  const ids = Object.entries(GUIDE_FOR_ADAPTER).filter(([, g]) => g === guide.id).map(([a]) => a);
  const lines = adapters.filter((a) => ids.includes(a.id)).flatMap((a) => a.freeTier);
  return [...new Set(lines)];
}
