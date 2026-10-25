import { requireAdminActor } from "../../../utils/auth";
import { BILI_CATALOG } from "../../../utils/channel-adapter/bili/catalog";

/**
 * 返回 B站命令目录（bili-cli 的 107 条命令），供 B站命令工作台前端渲染。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  return { groups: BILI_CATALOG };
});
