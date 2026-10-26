// The few Node.js APIs the end-to-end setup uses. The SDK has no Node.js
// types (it is built for browsers and Node), so they are declared here.

declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { readonly maxBuffer?: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): unknown;
}

declare module 'node:fs/promises' {
  export function mkdtemp(prefix: string): Promise<string>;
  export function rm(
    path: string,
    options: { readonly recursive: boolean; readonly force: boolean },
  ): Promise<void>;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
}

declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
  cwd(): string;
};
