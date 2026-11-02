export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function filename(title: string) { return title.replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 100) || "meeting"; }
