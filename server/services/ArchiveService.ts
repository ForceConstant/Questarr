import node7z from "node-7z";
const { extractFull } = node7z;
import pathTo7zip from "7zip-bin";
import fs from "fs-extra";
import path from "node:path";
import { logger } from "../logger.js";

const sevenZipPath = pathTo7zip.path7za;

/**
 * Progress event emitted during extraction.
 * - `type: "progress"` — percentage update (only when 7zip -bsp1 progress flag is active)
 * - `type: "file"` — a file has been extracted
 */
export type ExtractProgressEvent =
  { type: "progress"; percent: number; file?: string } | { type: "file"; file: string };

export interface ExtractOptions {
  /**
   * Callback invoked during extraction with progress/file events.
   * Use this to track progress for large archives.
   */
  onProgress?: (event: ExtractProgressEvent) => void;
  /**
   * Maximum milliseconds to wait before killing the extraction process.
   * Default: 600_000 (10 minutes) — large .rar files can take a while.
   * Set to 0 to disable the timeout entirely.
   */
  timeoutMs?: number;
}

export class ArchiveService {
  /**
   * Extracts an archive to a specified output directory.
   * @param filePath Full path to the archive file.
   * @param outputDir Directory where contents should be extracted.
   * @param options Progress callback and timeout configuration.
   * @returns Paths of files reported as extracted by 7zip (constructed from event data).
   */
  async extract(
    filePath: string,
    outputDir: string,
    options: ExtractOptions = {}
  ): Promise<string[]> {
    logger.debug({ filePath, outputDir }, "Extracting archive");

    await fs.ensureDir(outputDir);

    const timeoutMs = options.timeoutMs ?? 600_000; // 10 minutes default
    const onProgress = options.onProgress;

    return new Promise((resolve, reject) => {
      const extractedFiles: string[] = [];

      const stream = extractFull(filePath, outputDir, {
        $bin: sevenZipPath,
        $progress: true,
        recursive: true,
      });

      let timeoutId: NodeJS.Timeout | undefined;
      let completed = false;

      const cleanup = () => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
      };

      // Hard timeout: if extraction hasn't finished by now, kill + reject.
      // Set timeoutMs to 0 to disable.
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          if (completed) return;
          completed = true;

          this.killExtraction(stream);
          cleanup();

          reject(new Error(`Extraction timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      stream.on("data", (data: { status: string; file?: string; percent?: number }) => {
        // Forward progress events to callback
        if (onProgress) {
          if (data.status === "progress" && typeof data.percent === "number") {
            onProgress({ type: "progress", percent: data.percent, file: data.file });
          } else if (data.status === "extracted" && data.file) {
            onProgress({ type: "file", file: data.file });
          }
        }

        // Collect extracted file paths
        if (data.status === "extracted" && data.file) {
          extractedFiles.push(path.join(outputDir, data.file));
        }
      });

      stream.on("end", () => {
        if (completed) return;
        completed = true;
        cleanup();

        logger.debug({ count: extractedFiles.length }, "Extraction complete");
        resolve(extractedFiles);
      });

      stream.on("error", (err: Error) => {
        if (completed) return;
        completed = true;
        cleanup();

        logger.error({ err }, "Extraction failed");
        reject(err);
      });
    });
  }

  /**
   * Kills the 7zip child process spawned by node-7z.
   * Attempts a process-group kill first (the process is spawned detached),
   * falling back to a direct child.kill() if that fails.
   */
  private killExtraction(stream: NodeJS.ReadableStream): void {
    const child = (
      stream as unknown as { _childProcess?: { pid: number; kill: (signal?: string) => void } }
    )._childProcess;

    if (!child) {
      logger.warn("No child process found on extraction stream — cannot kill");
      return;
    }

    try {
      // node-7z spawns with detached: true, so the child leads its own process
      // group. Killing the group (-pid) takes down spawned helpers like unrar.
      process.kill(-child.pid, "SIGKILL");
      logger.debug({ pid: child.pid }, "Killed extraction process group");
    } catch {
      // Fallback: kill just the child process itself.
      child.kill("SIGKILL");
      logger.debug({ pid: child.pid }, "Killed extraction child process");
    }
  }

  isArchive(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return [".zip", ".7z", ".rar", ".gz", ".tar", ".iso", ".bz2"].includes(ext);
  }
}
