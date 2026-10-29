import { createContext } from "react";

export interface FileAccess {
  /** Opens the file viewer at a path from the chat (absolute, ~ or relative to `cwd`). */
  open: (path: string) => void;
  /** The chat's folder: relative paths in replies resolve against it. */
  cwd: string | null;
}

export const FileContext = createContext<FileAccess | null>(null);
