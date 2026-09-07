# 迁移包采用单文件 .portibak（SQLite 副本 + migration_meta 元信息表）

换机迁移需要无损携带全部数据 + 元信息，在「单文件、零新依赖」与「zip 打包、可扩展」之间选择了前者：迁移包就是 better-sqlite3 `backup()` 产出的完整数据库副本（含未落盘 WAL 内容），元信息写入副本内一张 `migration_meta` 表，后缀 `.portibak` 与普通 `.db` 区分。拒绝的替代方案：zip 包（manifest.json + porti.db，需引入 zip 依赖、恢复前要解压）和平铺双文件（`.portibak` + 旁边 `.json`，用户拷贝时易丢失其一）。

**Consequences**: 迁移包可被任意 SQLite 工具直接打开查看；`migration_meta` 表随导入进入正式库（无害的额外表）；未来若迁移包需附带数据库之外的文件，须引入新格式并保持对旧格式的导入兼容。
