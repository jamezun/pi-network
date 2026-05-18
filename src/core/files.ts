// Pi Network — File transfer

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { getBridgeDir } from "./config";

export interface FilePayload {
  from: string;
  filename: string;
  remotePath: string;
  content: string; // base64
}

export function getFilesDir(taskId?: string): string {
  const base = join(getBridgeDir(), "files");
  if (taskId) return join(base, taskId);
  return base;
}

export async function saveReceivedFile(taskId: string, payload: FilePayload): Promise<string> {
  const dir = getFilesDir(taskId);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const dest = payload.remotePath || join(dir, payload.filename);
  if (!existsSync(dirname(dest))) await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(payload.content, "base64"));
  return dest;
}

export async function readFileForSend(path: string): Promise<FilePayload> {
  const content = await readFile(path);
  return {
    from: "",
    filename: basename(path),
    remotePath: path,
    content: content.toString("base64"),
  };
}
