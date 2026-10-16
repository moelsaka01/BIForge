/** M text literal (same escapes as the Rust `m_text`). */
export const m_text = (s: string): string =>
  `"${s.replace(/"/g, '""').replace(/\r/g, "#(cr)").replace(/\n/g, "#(lf)").replace(/\t/g, "#(tab)")}"`;
