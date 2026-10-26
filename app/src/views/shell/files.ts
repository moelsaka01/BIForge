/** Browser-side file access for the few controls that need it (theme import and export). */
export interface FileUi {
  /** Lets the user pick a text file; resolves to its text, or null when they cancel. */
  pickText(accept: string): Promise<string | null>;
  /** Hands a text file to the user (a download). */
  save(name: string, text: string, mime?: string): void;
  /** Hands a binary file (a picture) to the user. */
  saveBlob?(name: string, blob: Blob): void;
}

export const browserFiles: FileUi = {
  pickText(accept) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.onchange = async () => resolve((await input.files?.[0]?.text()) ?? null);
      input.addEventListener("cancel", () => resolve(null));
      input.click();
    });
  },
  save(name, text, mime = "application/json") {
    browserFiles.saveBlob!(name, new Blob([text], { type: mime }));
  },
  saveBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  },
};
