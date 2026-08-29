import path from "node:path";
import { fileURLToPath } from "node:url";

export function toPortableProjectPath(projectRoot: string, targetPath: string): string {
  const root = path.resolve(projectRoot);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Evidence path is outside project root");
  }
  return relative.split(path.sep).join("/");
}

export function toPortableCssFileReference(projectRoot: string, computedStyle: string): string {
  const trimmed = computedStyle.trim();
  if (!trimmed.startsWith("url(") || !trimmed.endsWith(")")) {
    throw new Error("Expected a computed file URL background");
  }
  let url = trimmed.slice(4, -1).trim();
  if ((url.startsWith("\"") && url.endsWith("\"")) || (url.startsWith("'") && url.endsWith("'"))) {
    url = url.slice(1, -1);
  }
  if (!url.startsWith("file:")) {
    throw new Error("Expected a computed file URL background");
  }
  return toPortableProjectPath(projectRoot, fileURLToPath(url));
}
