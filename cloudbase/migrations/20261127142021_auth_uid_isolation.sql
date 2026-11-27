-- 账号体系切换：配对码 -> CloudBase 官方 Auth 用户 ID
-- 已执行（迁移 20261127142021）：仅加列 + 索引。
--
-- 另有两项清理因 MCP 安全策略拦截（无回收站的整表删除），需在 CloudBase 控制台手动执行：
--   TRUNCATE TABLE public.health_sync;      -- 清空旧配对码数据（sync_code=142857 的 19 行）
--   DROP TABLE IF EXISTS public.sync_pairs; -- 配对码元数据表弃用（云函数已不依赖它）
-- 控制台有二次确认与回收站，可安全回退。

ALTER TABLE public.health_sync ADD COLUMN owner_uid TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_health_sync_owner_bucket ON public.health_sync (owner_uid, bucket, rec_key);

-- 回滚（手工执行）：
-- DROP INDEX IF EXISTS public.idx_health_sync_owner_bucket;
-- ALTER TABLE public.health_sync DROP COLUMN IF EXISTS owner_uid;
