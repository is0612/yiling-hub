import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeStickerImage } from "../server/utils/sticker-image";
import { stickerRootDir } from "../server/utils/stickers";

/**
 * 把库里已有的贴图批量压到宽 240（高度等比）。
 *
 * 为什么需要：宽 240 的规则是新加的，之前存进去的图还是原始像素 ——
 * 实测这个库最宽的一张 1500px，发到 QQ 就是一张占满聊天窗的巨图。
 * 新图在「上传 / 收图」时就缩好了，这个脚本只补历史数据。
 *
 * 两件必须做的事：
 *   1. **原件先备份** 到 `.data/sticker-originals/<角色>/<文件名>`，再覆盖。
 *      缩图是有损的，万一缩错了（比如动图掉帧），没有备份就真找不回来了。
 *   2. 覆盖后同步 `sizeBytes`，否则页面上的文件大小是骗人的。
 *
 * 用法：
 *   yarn stickers:normalize            # 真跑
 *   yarn stickers:normalize --dry      # 只看会动哪些，不写盘
 */

const dryRun = process.argv.includes("--dry");

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const root = stickerRootDir();
const backupRoot = path.join(process.cwd(), ".data", "sticker-originals");

const { getPrisma } = await import("../server/utils/prisma");
const prisma = getPrisma();

let scanned = 0;
let skipped = 0;
let resized = 0;
let failed = 0;
let savedBytes = 0;

const characterDirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
for (const entry of characterDirs) {
  if (!entry.isDirectory()) continue;
  const characterId = entry.name;
  const dir = path.join(root, characterId);
  const files = await fs.readdir(dir).catch(() => [] as string[]);

  for (const fileName of files) {
    const extension = path.extname(fileName).slice(1).toLowerCase();
    const mimeType = MIME_BY_EXT[extension];
    if (!mimeType) continue;
    scanned += 1;

    const filePath = path.join(dir, fileName);
    const buffer = await fs.readFile(filePath).catch(() => null);
    if (!buffer) continue;

    const normalized = await normalizeStickerImage(buffer, mimeType);
    if (!normalized) {
      failed += 1;
      console.log(`  解不开，跳过：${fileName}`);
      continue;
    }
    if (!normalized.resized) {
      skipped += 1;
      continue;
    }

    const before = buffer.length;
    const after = normalized.buffer.length;
    savedBytes += Math.max(0, before - after);
    // 动图的 height 是所有帧叠起来的总高，直接打出来会像「500×17000 的长截图」——
    // 按帧写清楚，不然看日志的人会以为库里存了一堆长图。
    const size = (width: number, height: number, pages: number) =>
      pages > 1 ? `${width}×${height} ×${pages}帧（每帧 ${width}×${Math.round(height / pages)}）` : `${width}×${height}`;
    console.log(
      `  ${dryRun ? "[dry] " : ""}${characterId.slice(0, 8)}/${fileName.slice(0, 8)}  ` +
        `${size(normalized.sourceWidth, normalized.sourceHeight, normalized.pages)} → ` +
        `${size(normalized.width, normalized.height, normalized.pages)}  ` +
        `${Math.round(before / 1024)}KB → ${Math.round(after / 1024)}KB`,
    );

    if (dryRun) {
      resized += 1;
      continue;
    }

    // 备份原件（同一个文件只备份一次：脚本重复跑不会用缩过的图覆盖最初的备份）。
    const backupDir = path.join(backupRoot, characterId);
    const backupPath = path.join(backupDir, fileName);
    const backupExists = await fs
      .stat(backupPath)
      .then(() => true)
      .catch(() => false);
    if (!backupExists) {
      await fs.mkdir(backupDir, { recursive: true });
      await fs.writeFile(backupPath, buffer);
    }

    await fs.writeFile(filePath, normalized.buffer);
    await prisma.characterSticker.updateMany({ where: { fileName }, data: { sizeBytes: after } });
    resized += 1;
  }
}

console.log(
  `\n共扫 ${scanned} 张：缩小 ${resized} 张，本来就够窄 ${skipped} 张，解不开 ${failed} 张` +
    (savedBytes ? `，省下 ${(savedBytes / 1024 / 1024).toFixed(1)}MB` : "") +
    (dryRun ? "（dry-run，没有写盘）" : ""),
);
if (!dryRun && resized) console.log(`原件已备份到 ${backupRoot}`);
