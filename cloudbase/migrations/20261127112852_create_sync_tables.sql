-- Project Labyrinth · bio-tracker 云同步表
-- 配对码方案（无账号）：sync_code 为 6 位码，作为数据隔离键。
-- 前端不直连本表，统一经云函数 bio-api 代理，避免越权读取他人配对数据。

CREATE TABLE health_sync (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sync_code     TEXT        NOT NULL,
  device_id     TEXT        NOT NULL,
  bucket        TEXT        NOT NULL,   -- water/sleep/diet/ex/steps/foods/settings/...
  rec_key       TEXT        NOT NULL,   -- 日期或条目 id
  payload       JSONB       NOT NULL,
  updated_at    BIGINT      NOT NULL,   -- 客户端毫秒时间戳，用于字段级 LWW
  deleted       BOOLEAN     NOT NULL DEFAULT false,  -- tombstone，防止合并时复活
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_health_sync_code_bucket ON health_sync (sync_code, bucket, rec_key);
CREATE INDEX idx_health_sync_updated ON health_sync (updated_at);

-- 配对码元数据：记录每个码的创建时间与最后活跃时间
CREATE TABLE sync_pairs (
  sync_code   TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 匿名配对场景下不做浏览器直连，故不授予 anon/authenticated 任何表权限；
-- 仅 service_role（云函数侧）通过管理凭据访问。RLS 开启但无策略 = 默认拒绝。
ALTER TABLE health_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_pairs  ENABLE ROW LEVEL SECURITY;

-- 回滚（手工执行）：
-- DROP TABLE IF EXISTS health_sync CASCADE;
-- DROP TABLE IF EXISTS sync_pairs CASCADE;
