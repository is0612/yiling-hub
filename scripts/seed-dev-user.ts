import "dotenv/config";
import { randomBytes, scryptSync } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const connectionString = process.env.DATABASE_URL;
const ownerId = process.env.DEV_OWNER_ID;
const username = process.env.DEV_OWNER_USERNAME || "local-dev";
const password = process.env.DEV_OWNER_PASSWORD;

if (!connectionString) throw new Error("缺少 DATABASE_URL，请先配置 .env。");
if (!ownerId) throw new Error("缺少 DEV_OWNER_ID，请先配置 .env。");
if (!password || password.startsWith("replace_with_") || password.length < 12) {
  throw new Error("请将 DEV_OWNER_PASSWORD 设置为至少 12 位的本地开发密码。");
}

const salt = randomBytes(16);
const passwordHash = `scrypt$${salt.toString("base64url")}$${scryptSync(password, salt, 64).toString("base64url")}`;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

try {
  const user = await prisma.user.upsert({
    where: { id: ownerId },
    create: {
      id: ownerId,
      username,
      passwordHash,
      displayName: "本地开发用户",
    },
    update: {
      username,
      passwordHash,
      displayName: "本地开发用户",
    },
    select: { id: true, username: true },
  });

  console.log(`本地开发用户已准备：${user.username} (${user.id})`);
  console.log("注意：当前 API 仅限 localhost + development 模式；登录认证将在后续阶段实现。");
} finally {
  await prisma.$disconnect();
}
