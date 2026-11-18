export interface BuildPiDesktopResult {
  pluginDir: string;
  packagePath: string;
  fileName: string;
  byteLength: number;
  shasum: string;
  fileCount: number;
}

export function crc32(data: Uint8Array): number;
export function buildStoreZip(entries: Array<{ name: string; data: Uint8Array }>): Buffer;
export function buildPiDesktopPlugin(options?: { projectDir?: string; outDir?: string }): Promise<BuildPiDesktopResult>;
