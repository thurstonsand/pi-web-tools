import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";

export interface Extractor {
  name: string;
  extractToMarkdown(htmlPath: string): Promise<string>;
}

// Trafilatura runs as a child process, which is loader-safe (no imports).
// This seam exists so defuddle can replace it once it clears work artifactory.
export function createTrafilaturaExtractor(): Extractor {
  return {
    name: "trafilatura",
    extractToMarkdown(htmlPath) {
      return new Promise((resolve, reject) => {
        const child = spawn("uvx", ["trafilatura", "--markdown", "--formatting"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("error", (error: NodeJS.ErrnoException) => {
          reject(
            error.code === "ENOENT"
              ? new Error("uvx not found; trafilatura extraction requires uv to be installed")
              : error,
          );
        });
        child.on("close", (code) => {
          if (code === 0) {
            resolve(Buffer.concat(stdout).toString("utf8"));
            return;
          }
          const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 500);
          reject(new Error(`trafilatura exited with code ${code}${detail ? `: ${detail}` : ""}`));
        });

        const input = createReadStream(htmlPath);
        input.on("error", (error) => {
          child.kill();
          reject(error);
        });
        input.pipe(child.stdin);
      });
    },
  };
}
