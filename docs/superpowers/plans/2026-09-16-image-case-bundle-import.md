# 带原型图用例包（casebook v1）导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用严格单文件契约 `casebook.json + assets/` 导入「用例 + 原型图」，执行页按用例展示目标核对图、定位辅助图、核图重点和「不该出现」清单；导入页直接提供两份给 AI 的提示词（文本用例一份、带图用例包一份），提示词里内嵌完整 schema。

**Architecture:** 上传包是 ZIP，根目录只有 `casebook.json` 和 `assets/`，**图片文件名去扩展名就是 asset key**，用例只写一次引用，没有第二份 manifest 可漂移。格式按 `backend/app/schemas/casebook.schema.json` 走**严格模式**：未知字段、类型不符、枚举越界、三处集合不一致一律 422 作废，不做类型转换、不做默认值兜底、不兼容旧结构。预览复用现有 `import_tickets`（ZIP 存 `original_file`，元数据存 `parsed`）；确认时写入 `case_reference_assets`（按组去重，一张图一行）+ `case_reference_links`（用例 → 图，带 role/caption/focus）+ `groups`/`group_cases`，图片字节落在持久化卷的 `reference/` 子目录。图片二进制不进 JSONB、不进列表接口，字节由 `/api/case-reference-assets/{id}` 鉴权下发。两份提示词正文放 `backend/app/prompts/`（随镜像发布），由 `GET /api/ai-prompts` 提供给导入页；`docs/` 保留同名文件，用测试锁住「docs ↔ 镜像副本 ↔ schema」三方一致。

**Tech Stack:** FastAPI、SQLAlchemy、Alembic、PostgreSQL JSONB、Pillow、Python `zipfile`、React、TypeScript、Vitest、pytest。不新增第三方依赖。

---

## 前置条件

- 后端虚拟环境已存在：`backend/.venv`（`.venv/bin/python`、`.venv/bin/pytest`、`.venv/bin/alembic`）。
- 本机没有 `uv` 命令，本计划不新增 Python 依赖；如果需要装包，用 `.venv/bin/python -m pip install <name>`。
- 后端集成测试需要一个本地 PostgreSQL，端口与 CI 一致：

```bash
docker run --rm -d --name testdeck-test-db \
  -e POSTGRES_USER=testdeck -e POSTGRES_PASSWORD=testdeck -e POSTGRES_DB=testdeck_test \
  -p 5433:5432 postgres:17-alpine
```

- 每个后端测试命令都必须带 `TEST_DATABASE_URL`，否则 `backend/tests/conftest.py` 直接 `pytest.fail`：

```bash
TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test
```

- 前端在 `frontend/` 下用 `npx vitest run <文件>` 跑单测；`npm run build` 会跑 `tsc -b`，新增必填字段要同步改测试夹具。
- 不要提交用例目录、生成的 ZIP、`test-results/` 或任何 `.env`；验收包放 `/tmp`。
- 工作区里可能同时有别人的改动；每个任务的 `git add` 只加本任务列出的文件，不要用 `git add -A`。

## 输入包契约：casebook v1（严格模式，唯一认可格式）

```text
odyssey-casebook.zip
├── casebook.json
└── assets/
    ├── sale-stage-selling.png
    ├── sale-confirm-modal.png
    └── sale-24h-countdown.png
```

### 规范文件与一致性

机器可读规范：`backend/app/schemas/casebook.schema.json`（本计划 Task 6 创建）。三处引用同一份文本，并用测试锁死：

1. `backend/app/schemas/casebook.schema.json` —— 唯一真源；
2. `docs/CASEBOOK-FORMAT.md` 与 `docs/AI-CASEBOOK-PROMPT.md` 里的 `<!-- casebook-schema:start -->` / `<!-- casebook-schema:end -->` 区块；
3. 运行时提示词 `backend/app/prompts/ai-casebook.md`（与 docs 逐字节相同）。

### 完整 schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://testdeck.local/schemas/casebook.schema.json",
  "title": "TestDeck casebook v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["casebook", "doc", "assets", "cases"],
  "properties": {
    "casebook": { "const": "1.0" },
    "doc": {
      "type": "object",
      "additionalProperties": false,
      "required": ["title", "prototype"],
      "properties": {
        "title": { "type": "string", "minLength": 1 },
        "prototype": {
          "type": "object",
          "additionalProperties": false,
          "required": ["version"],
          "properties": {
            "version": { "type": "string", "minLength": 1 },
            "source": { "type": "string", "minLength": 1 },
            "exported_at": { "type": "string", "minLength": 1 }
          }
        }
      }
    },
    "assets": {
      "type": "object",
      "minProperties": 1,
      "propertyNames": { "pattern": "^[a-z0-9][a-z0-9-]*$" },
      "additionalProperties": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "type"],
        "properties": {
          "name": { "type": "string", "minLength": 1 },
          "type": { "enum": ["page", "modal", "state", "flow"] },
          "screen": { "type": "string", "minLength": 1 },
          "state": { "type": "string", "minLength": 1 }
        }
      }
    },
    "cases": {
      "type": "array",
      "minItems": 1,
      "maxItems": 5000,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["code", "title", "steps", "expected", "visual"],
        "properties": {
          "code": {
            "type": "string",
            "pattern": "^[A-Za-z][A-Za-z0-9]*-[0-9]+(-[A-Za-z0-9]+)*$"
          },
          "title": { "type": "string", "minLength": 1, "maxLength": 120 },
          "position": { "type": "integer", "minimum": 1 },
          "module": { "type": "string", "minLength": 1 },
          "layer": { "enum": ["Smoke", "Core", "Regression"] },
          "priority": { "enum": ["P0", "P1", "P2"] },
          "preconditions": { "type": "string", "minLength": 1 },
          "test_data": { "type": "string", "minLength": 1 },
          "steps": {
            "type": "array",
            "minItems": 1,
            "items": { "type": "string", "minLength": 1 }
          },
          "expected": {
            "type": "array",
            "minItems": 1,
            "items": { "type": "string", "minLength": 1 }
          },
          "expect_absent": {
            "type": "array",
            "items": { "type": "string", "minLength": 1 }
          },
          "visual": {
            "type": "object",
            "additionalProperties": false,
            "required": ["check", "references"],
            "properties": {
              "check": {
                "enum": ["text_and_visual", "visual_only", "not_verifiable"]
              },
              "note": { "type": "string", "minLength": 1 },
              "references": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["asset", "role"],
                  "properties": {
                    "asset": {
                      "type": "string",
                      "pattern": "^[a-z0-9][a-z0-9-]*$"
                    },
                    "role": { "enum": ["expected", "locator"] },
                    "caption": { "type": "string", "minLength": 1 },
                    "focus": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["label"],
                        "properties": {
                          "label": { "type": "string", "minLength": 1 },
                          "note": { "type": "string", "minLength": 1 },
                          "box": {
                            "type": "array",
                            "minItems": 4,
                            "maxItems": 4,
                            "items": {
                              "type": "number",
                              "minimum": 0,
                              "maximum": 1
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            "allOf": [
              {
                "if": {
                  "properties": {
                    "check": { "enum": ["text_and_visual", "visual_only"] }
                  },
                  "required": ["check"]
                },
                "then": { "properties": { "references": { "minItems": 1 } } }
              },
              {
                "if": {
                  "properties": { "check": { "const": "not_verifiable" } },
                  "required": ["check"]
                },
                "then": { "required": ["note"] }
              }
            ]
          }
        }
      }
    }
  }
}
```

### 合法样例（两个用例共用一张图）

```json
{
  "casebook": "1.0",
  "doc": {
    "title": "Odyssey 节点发售回归",
    "prototype": {
      "version": "v2.0",
      "source": "https://www.figma.com/file/xxx",
      "exported_at": "2026-09-16"
    }
  },
  "assets": {
    "sale-stage-selling": {
      "name": "节点发售 · 阶段1 发售中",
      "type": "page",
      "screen": "节点发售",
      "state": "发售中"
    },
    "sale-confirm-modal": {
      "name": "购买确认弹框",
      "type": "modal",
      "screen": "节点发售",
      "state": "确认购买"
    },
    "sale-24h-countdown": {
      "name": "最后 24 小时红色倒计时",
      "type": "state",
      "screen": "节点发售",
      "state": "最后 24 小时"
    }
  },
  "cases": [
    {
      "code": "C-05",
      "position": 1,
      "module": "二、节点认购与期次",
      "title": "认购主流程-准确",
      "preconditions": "期次发售中、余额充足",
      "steps": ["选 A 档 ×1", "选 BOT Chain", "点确认购买"],
      "expected": ["阶段信息条: 三行文案与原型一致", "费用明细: 实付 = 原价 × 份数"],
      "expect_absent": ["已售罄"],
      "visual": {
        "check": "text_and_visual",
        "references": [
          { "asset": "sale-stage-selling", "role": "expected", "caption": "默认发售态" },
          {
            "asset": "sale-confirm-modal",
            "role": "expected",
            "focus": [
              {
                "label": "确认按钮",
                "note": "文案应为「确认购买」，不是「确定」",
                "box": [0.62, 0.78, 0.3, 0.08]
              }
            ]
          }
        ]
      }
    },
    {
      "code": "C-11",
      "title": "期次信息条与倒计时-准确",
      "preconditions": "发售中，可调系统时间",
      "steps": ["进入最后 24 小时", "观察倒计时"],
      "expected": ["倒计时: 切换为红色秒级", "跨页刷新: 剩余时间连续"],
      "visual": {
        "check": "not_verifiable",
        "note": "红色倒计时原型默认不展示，需要演示开关 toggleStageLastDay() 触发后再比对",
        "references": []
      }
    }
  ]
}
```

注意 C-11 的形状：`check = not_verifiable` 时 `references` 允许为空，但 `note` 必填；其它两种 `check` 时 `references` 至少一条。

### 严格校验清单

任一不满足 → 422 作废，`detail` 给出 JSON 路径（如 `cases[3].visual.references[0].role`）或文件名：

- 每个对象 `additionalProperties: false`：出现 schema 之外的字段（`slices`、`manifest`、拼错的 `refferences`）直接拒绝。
- 不做类型转换：`steps`/`expected` 必须是字符串数组，写成字符串失败；`position` 必须是整数；`box` 必须是 4 个 0–1 数字。
- 枚举精确匹配（大小写不宽容）：`role`、`type`、`check`、`priority`、`layer`。
- 三处集合必须完全一致：`assets/` 下的文件名（去扩展名）、`assets` 对象的 key、被 `references[].asset` 引用到的 key。多一张没被引用、少一张被引用、引用不存在的 key，全部拒绝。
- 用例 `code` 必须匹配 `<字母/数字>-<数字>` 且包内唯一；给了 `position` 就必须包内唯一；用例数 1–5000。
- ZIP 内 `casebook.json` 恰好一份；图片只允许 PNG / JPEG / WebP；ZIP ≤ 100 MB，解压后 ≤ 250 MB，单张图 ≤ 20 MB。

### 为什么这样定

- **文件名即 key**：旧格式要 `slices: ["s05"]` 再去 `manifest.json` 查 `shots/app/s05.png`，两处同步是 AI 生成的主要失败源；现在只有一处。
- **严格优于兜底**：AI 输出错了就整包拒绝并指出路径，人拿到明确错误去改提示词；宽容解析只会把脏数据带进库。
- **图片按组去重**：Odyssey 实测 67 条用例、182 次引用、99 张唯一图，同一张图会被多条用例引用，因此拆「asset（文件）」+「link（用例→图）」两表。
- **`role` 区分目标图与辅助图**，**`focus` / `expect_absent`** 把原先写在 `protoNote` 散文里的「看这里」「不该出现 XXX」变成结构化清单。
- **图片始终是文件**：JSON 里只有 key，没有 Base64，也不联网抓图。

AI 生成纪律（写进提示词）：先列 `assets/` 真实文件名再写 JSON；图片由人从设计稿导出，AI 不编造、不抓取；原型覆盖不了的断言标 `not_verifiable` 并写 `note`。

## 文件边界

- 数据模型与迁移：`backend/app/models.py`、`backend/alembic/versions/0011_case_reference_assets.py`
- 格式解析：`backend/app/importers/casebook.py`、`backend/app/importers/schema.py`、`backend/app/schemas/casebook.schema.json`
- 导入流程：`backend/app/groups.py`
- 参考图读取：`backend/app/case_assets.py`、`backend/app/main.py`
- AI 提示词：`backend/app/prompts/ai-cases.md`、`backend/app/prompts/ai-casebook.md`、`backend/app/prompts.py`
- 报告：`backend/app/reports.py`
- 前端：`frontend/src/api.ts`、`frontend/src/views/Import.tsx`、`frontend/src/App.tsx`、`frontend/src/components/AiPromptPanel.tsx`、`frontend/src/components/ReferenceGallery.tsx`、`frontend/src/components/CaseDetail.tsx`、`frontend/src/views/Execution.tsx`、`frontend/src/views/Groups.tsx`、`frontend/src/styles.css`
- 后端测试：`backend/tests/test_casebook.py`、`backend/tests/test_bundle_import_api.py`、`backend/tests/test_case_assets.py`、`backend/tests/test_ai_prompts.py`、`backend/tests/test_migrations.py`、`backend/tests/test_reports.py`
- 前端测试：`frontend/src/components/AiPromptPanel.test.tsx`、`frontend/src/components/ReferenceGallery.test.tsx`、`frontend/src/views/Import.test.tsx`、`frontend/src/views/Execution.test.tsx`、`frontend/src/views/Groups.test.tsx`
- 文档：`docs/CASEBOOK-FORMAT.md`、`docs/AI-CASEBOOK-PROMPT.md`、`docs/AI-CASE-PROMPT.md`、`docs/IMPORT-FORMAT.md`、`docs/superpowers/plans/README.md`

---

### Task 1: 参考图数据模型与数据库迁移

**Files:**
- Modify: `backend/app/models.py`
- Create: `backend/alembic/versions/0011_case_reference_assets.py`
- Test: `backend/tests/test_migrations.py`

- [ ] **Step 1: 写迁移失败测试**

`backend/tests/test_migrations.py`：`EXPECTED_TABLES` 加入 `"case_reference_assets"` 和 `"case_reference_links"`；两处硬编码的 head revision（第 36 行、第 162 行）由 `"0010_reconcile_marks"` 改成 `"0011_case_reference_assets"`；追加：

```python
def test_reference_asset_tables_are_created(migrated_database):
    with migrated_database.connect() as connection:
        assets = {
            column["name"]
            for column in inspect(connection).get_columns("case_reference_assets")
        }
        assert assets == {
            "id",
            "group_id",
            "asset_key",
            "name",
            "storage_key",
            "mime",
            "size_bytes",
            "width",
            "height",
            "asset_type",
            "screen",
            "state",
            "source_path",
            "prototype_version",
            "created_at",
        }
        links = {
            column["name"]
            for column in inspect(connection).get_columns("case_reference_links")
        }
        assert links == {
            "id",
            "group_case_id",
            "asset_id",
            "role",
            "caption",
            "focus",
            "sort_order",
            "created_at",
        }
        assert "uq_case_reference_asset_key" in {
            constraint["name"]
            for constraint in inspect(connection).get_unique_constraints(
                "case_reference_assets"
            )
        }
        case_columns = {
            column["name"]
            for column in inspect(connection).get_columns("group_cases")
        }
        assert {"prototype_note", "expect_absent", "visual_check"} <= case_columns
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test \
  .venv/bin/python -m pytest tests/test_migrations.py -q
```

预期：FAIL，两张新表不存在，head revision 仍是 `0010_reconcile_marks`。

- [ ] **Step 3: 实现模型**

`backend/app/models.py` 顶部 import 补 `text`：

```python
from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
```

`GroupCase`：类级约束加一条枚举校验，字段区在 `expected` 之后加三列，关系区在 `attempts` 之前加 reference_links：

```python
    __table_args__ = (
        UniqueConstraint("group_id", "code", name="uq_group_case_code"),
        UniqueConstraint("group_id", "position", name="uq_group_case_position"),
        CheckConstraint(
            "visual_check IN ('text_and_visual', 'visual_only', 'not_verifiable')",
            name="ck_group_cases_visual_check",
        ),
    )
```

```python
    expect_absent: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    visual_check: Mapped[str] = mapped_column(
        String, nullable=False, default="text_and_visual", server_default="text_and_visual"
    )
    prototype_note: Mapped[str | None] = mapped_column(Text)
    raw: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)

    group: Mapped[Group] = relationship(back_populates="cases")
    reference_links: Mapped[list[CaseReferenceLink]] = relationship(
        back_populates="group_case",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="CaseReferenceLink.sort_order",
    )
```

`Group` 增加：

```python
    reference_assets: Mapped[list[CaseReferenceAsset]] = relationship(
        back_populates="group", cascade="all, delete-orphan", passive_deletes=True
    )
```

在 `Screenshot` 之后新增：

```python
class CaseReferenceAsset(Base):
    """One prototype image inside one test group.

    The file is stored once per group and shared by every case that checks it,
    so re-exporting a design frame replaces a single file.
    """

    __tablename__ = "case_reference_assets"
    __table_args__ = (
        UniqueConstraint(
            "group_id", "asset_key", name="uq_case_reference_asset_key"
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), nullable=False
    )
    asset_key: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    storage_key: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    mime: Mapped[str] = mapped_column(String, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    asset_type: Mapped[str] = mapped_column(
        String, nullable=False, default="page", server_default="page"
    )
    screen: Mapped[str | None] = mapped_column(String)
    state: Mapped[str | None] = mapped_column(String)
    source_path: Mapped[str] = mapped_column(String, nullable=False)
    prototype_version: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    group: Mapped[Group] = relationship(back_populates="reference_assets")
    links: Mapped[list[CaseReferenceLink]] = relationship(
        back_populates="asset", cascade="all, delete-orphan", passive_deletes=True
    )


class CaseReferenceLink(Base):
    """One case pointing at one asset, with the reason it is checked."""

    __tablename__ = "case_reference_links"
    __table_args__ = (
        UniqueConstraint("group_case_id", "asset_id", name="uq_case_reference_link"),
        CheckConstraint(
            "role IN ('expected', 'locator')", name="ck_case_reference_links_role"
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    group_case_id: Mapped[UUID] = mapped_column(
        ForeignKey("group_cases.id", ondelete="CASCADE"), nullable=False
    )
    asset_id: Mapped[UUID] = mapped_column(
        ForeignKey("case_reference_assets.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(
        String, nullable=False, default="expected", server_default="expected"
    )
    caption: Mapped[str | None] = mapped_column(Text)
    focus: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    group_case: Mapped[GroupCase] = relationship(back_populates="reference_links")
    asset: Mapped[CaseReferenceAsset] = relationship(back_populates="links")
```

- [ ] **Step 4: 实现迁移**

新建 `backend/alembic/versions/0011_case_reference_assets.py`：

```python
"""Attach prototype reference images and visual checks to group cases.

Revision ID: 0011_case_reference_assets
Revises: 0010_reconcile_marks
Create Date: 2026-09-16
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0011_case_reference_assets"
down_revision: str | None = "0010_reconcile_marks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "group_cases",
        sa.Column(
            "expect_absent",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "group_cases",
        sa.Column(
            "visual_check",
            sa.String(),
            server_default="text_and_visual",
            nullable=False,
        ),
    )
    op.add_column("group_cases", sa.Column("prototype_note", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_group_cases_visual_check",
        "group_cases",
        "visual_check IN ('text_and_visual', 'visual_only', 'not_verifiable')",
    )
    op.create_table(
        "case_reference_assets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("asset_key", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("storage_key", sa.String(), nullable=False),
        sa.Column("mime", sa.String(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("asset_type", sa.String(), nullable=False, server_default="page"),
        sa.Column("screen", sa.String(), nullable=True),
        sa.Column("state", sa.String(), nullable=True),
        sa.Column("source_path", sa.String(), nullable=False),
        sa.Column("prototype_version", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("storage_key"),
        sa.UniqueConstraint("group_id", "asset_key", name="uq_case_reference_asset_key"),
    )
    op.create_table(
        "case_reference_links",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("group_case_id", sa.Uuid(), nullable=False),
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(), nullable=False, server_default="expected"),
        sa.Column("caption", sa.Text(), nullable=True),
        sa.Column(
            "focus",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "role IN ('expected', 'locator')", name="ck_case_reference_links_role"
        ),
        sa.ForeignKeyConstraint(
            ["group_case_id"], ["group_cases.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["asset_id"], ["case_reference_assets.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "group_case_id", "asset_id", name="uq_case_reference_link"
        ),
    )


def downgrade() -> None:
    op.drop_table("case_reference_links")
    op.drop_table("case_reference_assets")
    op.drop_constraint("ck_group_cases_visual_check", "group_cases")
    op.drop_column("group_cases", "prototype_note")
    op.drop_column("group_cases", "visual_check")
    op.drop_column("group_cases", "expect_absent")
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test \
  .venv/bin/python -m pytest tests/test_migrations.py -q
```

预期：PASS（含既有的「空 schema 连续升级两次」用例）。

- [ ] **Step 6: 提交**

```bash
git add backend/app/models.py backend/alembic/versions/0011_case_reference_assets.py backend/tests/test_migrations.py
git commit -m "feat: add case reference asset and link storage"
```

---

### Task 2: casebook v1 严格解析（schema 形状 + 跨文件一致性）

**Files:**
- Create: `backend/app/importers/casebook.py`
- Create: `backend/tests/casebook_fixture.py`
- Create: `backend/tests/test_casebook.py`
- Modify: `backend/app/importers/schema.py`

- [ ] **Step 1: 写测试夹具**

新建 `backend/tests/casebook_fixture.py`：

```python
"""Strict-mode casebook fixtures shared by the import tests."""

import json
import zipfile
from io import BytesIO
from typing import Any

from PIL import Image


def png_bytes(width: int = 4, height: int = 6) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (width, height), (12, 34, 56)).save(buffer, format="PNG")
    return buffer.getvalue()


def valid_case(**overrides: Any) -> dict[str, Any]:
    """A minimal case that passes strict validation; override one field per test."""

    case: dict[str, Any] = {
        "code": "C-05",
        "title": "认购主流程-准确",
        "steps": ["选 A 档 ×1"],
        "expected": ["确认按钮: 显示「确认购买」"],
        "visual": {
            "check": "not_verifiable",
            "note": "原型未覆盖该断言",
            "references": [],
        },
    }
    case.update(overrides)
    return case


def casebook(
    *,
    cases: list[dict[str, Any]] | None = None,
    assets: dict[str, Any] | None = None,
    prototype: dict[str, Any] | None = None,
    title: str = "Odyssey 节点发售回归",
) -> dict[str, Any]:
    return {
        "casebook": "1.0",
        "doc": {
            "title": title,
            "prototype": prototype
            if prototype is not None
            else {
                "version": "v2.0",
                "source": "https://www.figma.com/file/xxx",
                "exported_at": "2026-09-16",
            },
        },
        "assets": assets
        if assets is not None
        else {
            "sale-stage-selling": {
                "name": "节点发售 · 阶段1 发售中",
                "type": "page",
                "screen": "节点发售",
                "state": "发售中",
            },
            "sale-confirm-modal": {
                "name": "购买确认弹框",
                "type": "modal",
                "screen": "节点发售",
                "state": "确认购买",
            },
        },
        "cases": cases
        if cases is not None
        else [
            {
                "code": "C-05",
                "position": 1,
                "module": "二、节点认购与期次",
                "title": "认购主流程-准确",
                "preconditions": "期次发售中、余额充足",
                "steps": ["选 A 档 ×1", "选 BOT Chain", "点确认购买"],
                "expected": [
                    "阶段信息条: 三行文案",
                    "费用明细: 实付 = 原价 × 份数",
                ],
                "expect_absent": ["已售罄"],
                "visual": {
                    "check": "text_and_visual",
                    "references": [
                        {
                            "asset": "sale-stage-selling",
                            "role": "expected",
                            "caption": "默认发售态",
                        },
                        {
                            "asset": "sale-confirm-modal",
                            "role": "expected",
                            "focus": [
                                {
                                    "label": "确认按钮",
                                    "note": "文案应为「确认购买」",
                                    "box": [0.62, 0.78, 0.3, 0.08],
                                }
                            ],
                        },
                    ],
                },
            },
            {
                "code": "C-11",
                "title": "期次信息条与倒计时-准确",
                "steps": ["进入最后 24 小时", "观察倒计时"],
                "expected": ["倒计时: 切换为红色秒级"],
                "visual": {
                    "check": "not_verifiable",
                    "note": "红色倒计时原型默认不展示，需要演示开关触发",
                    "references": [
                        {"asset": "sale-stage-selling", "role": "locator"}
                    ],
                },
            },
        ],
    }


def casebook_zip(
    *,
    book: dict[str, Any] | None = None,
    images: dict[str, bytes] | None = None,
    prefix: str = "",
) -> bytes:
    document = book if book is not None else casebook()
    images = images if images is not None else {
        "sale-stage-selling.png": png_bytes(),
        "sale-confirm-modal.png": png_bytes(),
    }

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            f"{prefix}casebook.json", json.dumps(document, ensure_ascii=False)
        )
        for filename, content in images.items():
            archive.writestr(f"{prefix}assets/{filename}", content)
    return buffer.getvalue()
```

---

- [ ] **Step 2: 写严格校验失败测试**

新建 `backend/tests/test_casebook.py`：

```python
import json
import zipfile
from io import BytesIO

import pytest
from PIL import Image

from app.importers.casebook import parse_casebook
from app.importers.schema import ImportErrorDetail
from tests.casebook_fixture import casebook, casebook_zip, png_bytes, valid_case


def test_casebook_loads_cases_assets_and_visual_checks():
    document = parse_casebook(casebook_zip())

    assert document.title == "Odyssey 节点发售回归"
    assert document.prototype_version == "v2.0"
    # Two cases reference three slots but only two unique images.
    assert sorted(document.assets) == ["sale-confirm-modal", "sale-stage-selling"]
    assert [case.code for case in document.cases] == ["C-05", "C-11"]

    first = document.cases[0]
    assert first.position == 1
    assert first.module == "二、节点认购与期次"
    assert first.steps == "选 A 档 ×1\n选 BOT Chain\n点确认购买"
    assert first.expected == "阶段信息条: 三行文案\n费用明细: 实付 = 原价 × 份数"
    assert first.expect_absent == ("已售罄",)
    assert first.visual_check == "text_and_visual"
    assert first.prototype_note is None
    assert [reference.asset_key for reference in first.references] == [
        "sale-stage-selling",
        "sale-confirm-modal",
    ]
    assert first.references[0].caption == "默认发售态"
    assert first.references[1].focus[0].label == "确认按钮"
    assert first.references[1].focus[0].box == (0.62, 0.78, 0.3, 0.08)

    second = document.cases[1]
    assert second.visual_check == "not_verifiable"
    assert second.prototype_note == "红色倒计时原型默认不展示，需要演示开关触发"
    assert second.references[0].role == "locator"
    assert second.expect_absent == ()

    asset = document.assets["sale-stage-selling"]
    assert asset.name == "节点发售 · 阶段1 发售中"
    assert asset.asset_type == "page"
    assert asset.screen == "节点发售"
    assert (asset.width, asset.height) == (4, 6)
    assert asset.mime == "image/png"
    assert asset.content == png_bytes()
    assert asset.prototype_version == "v2.0"


def test_unknown_document_fields_are_rejected():
    document = casebook()
    document["slices"] = ["s05"]

    with pytest.raises(ImportErrorDetail, match=r"casebook\.json: unknown field"):
        parse_casebook(casebook_zip(book=document))


def test_unknown_case_fields_are_rejected():
    broken = casebook(cases=[valid_case(refferences=[])])

    with pytest.raises(ImportErrorDetail, match=r"cases\[0\]: unknown field.*refferences"):
        parse_casebook(casebook_zip(book=broken))


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"steps": "选 A 档 ×1"}, r"cases\[0\]\.steps: must be an array"),
        ({"position": "1"}, r"cases\[0\]\.position: must be an integer"),
        ({"priority": "p0"}, r"cases\[0\]\.priority: expected one of P0\|P1\|P2"),
        ({"title": ""}, r"cases\[0\]\.title: must not be empty"),
    ],
)
def test_types_and_enums_are_not_coerced(overrides, message):
    broken = casebook(cases=[valid_case(**overrides)])

    with pytest.raises(ImportErrorDetail, match=message):
        parse_casebook(casebook_zip(book=broken))


def test_reference_role_is_strict():
    case = valid_case(
        visual={
            "check": "visual_only",
            "references": [{"asset": "sale-stage-selling", "role": "Expected"}],
        }
    )

    with pytest.raises(ImportErrorDetail, match=r"references\[0\]\.role"):
        parse_casebook(casebook_zip(book=casebook(cases=[case])))


def test_checks_require_the_right_reference_shape():
    without_note = valid_case(visual={"check": "not_verifiable", "references": []})
    with pytest.raises(ImportErrorDetail, match=r"visual\.note: required"):
        parse_casebook(casebook_zip(book=casebook(cases=[without_note])))

    no_images = valid_case(visual={"check": "text_and_visual", "references": []})
    with pytest.raises(ImportErrorDetail, match=r"references: needs at least one image"):
        parse_casebook(casebook_zip(book=casebook(cases=[no_images])))


def test_every_image_and_registry_entry_must_be_referenced():
    referenced = valid_case(
        visual={
            "check": "visual_only",
            "references": [{"asset": "sale-stage-selling", "role": "expected"}],
        }
    )
    unused_image = casebook_zip(
        book=casebook(
            cases=[referenced],
            assets={"sale-stage-selling": {"name": "节点发售", "type": "page"}},
        ),
        images={
            "sale-stage-selling.png": png_bytes(),
            "orphan-export.png": png_bytes(),
        },
    )
    with pytest.raises(ImportErrorDetail, match=r"never referenced: orphan-export"):
        parse_casebook(unused_image)

    unused_registry = casebook_zip(
        book=casebook(
            cases=[referenced],
            assets={
                "sale-stage-selling": {"name": "节点发售", "type": "page"},
                "sale-confirm-modal": {"name": "确认弹框", "type": "modal"},
            },
        ),
        images={
            "sale-stage-selling.png": png_bytes(),
            "sale-confirm-modal.png": png_bytes(),
        },
    )
    with pytest.raises(ImportErrorDetail, match=r"registry entries never referenced"):
        parse_casebook(unused_registry)


def test_unknown_asset_and_duplicate_reference_are_rejected():
    unknown = valid_case(
        visual={
            "check": "visual_only",
            "references": [{"asset": "not-exported", "role": "expected"}],
        }
    )
    with pytest.raises(ImportErrorDetail, match=r"unknown asset 'not-exported'"):
        parse_casebook(casebook_zip(book=casebook(cases=[unknown])))

    duplicated = valid_case(
        visual={
            "check": "visual_only",
            "references": [
                {"asset": "sale-stage-selling", "role": "expected"},
                {"asset": "sale-stage-selling", "role": "expected"},
            ],
        }
    )
    with pytest.raises(
        ImportErrorDetail, match=r"duplicate reference to sale-stage-selling"
    ):
        parse_casebook(casebook_zip(book=casebook(cases=[duplicated])))


def test_duplicate_codes_and_positions_are_rejected():
    duplicate_code = casebook(cases=[valid_case(), valid_case(title="另一条")])
    with pytest.raises(ImportErrorDetail, match=r"duplicate code C-05"):
        parse_casebook(casebook_zip(book=duplicate_code))

    duplicate_position = casebook(
        cases=[valid_case(), valid_case(code="C-06", position=1)]
    )
    with pytest.raises(ImportErrorDetail, match=r"duplicate position 1"):
        parse_casebook(casebook_zip(book=duplicate_position))


def test_invalid_codes_and_filenames_are_rejected():
    bad_code = valid_case(code="登录-001")
    with pytest.raises(ImportErrorDetail, match=r"must look like <MODULE>-<number>"):
        parse_casebook(casebook_zip(book=casebook(cases=[bad_code])))

    bad_filename = casebook_zip(
        book=casebook(
            cases=[valid_case()],
            assets={"Sale-Stage": {"name": "x", "type": "page"}},
        ),
        images={"Sale-Stage.png": png_bytes()},
    )
    with pytest.raises(ImportErrorDetail, match="kebab-case"):
        parse_casebook(bad_filename)


def test_version_and_archive_guardrails():
    wrong_version = casebook()
    wrong_version["casebook"] = "2.0"
    with pytest.raises(ImportErrorDetail, match="Unsupported casebook version"):
        parse_casebook(casebook_zip(book=wrong_version))

    without_book = BytesIO()
    with zipfile.ZipFile(without_book, "w") as archive:
        archive.writestr("assets/sale-stage-selling.png", png_bytes())
    with pytest.raises(ImportErrorDetail, match="casebook.json"):
        parse_casebook(without_book.getvalue())

    with pytest.raises(ImportErrorDetail, match="not a readable ZIP"):
        parse_casebook(b"not a zip")

    with pytest.raises(ImportErrorDetail, match="must be a JSON object"):
        parse_casebook(casebook_zip(book=[1, 2]))

    buffer = BytesIO()
    Image.new("RGB", (4, 4), (0, 0, 255)).save(buffer, format="GIF")
    gif = casebook_zip(
        images={
            "sale-stage-selling.png": buffer.getvalue(),
            "sale-confirm-modal.png": png_bytes(),
        }
    )
    with pytest.raises(ImportErrorDetail, match="unsupported format"):
        parse_casebook(gif)


def test_path_traversal_entries_are_rejected():
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "casebook.json", json.dumps(casebook(), ensure_ascii=False)
        )
        archive.writestr("assets/sale-stage-selling.png", png_bytes())
        archive.writestr("../escape.png", png_bytes())

    with pytest.raises(ImportErrorDetail, match="not a safe path"):
        parse_casebook(buffer.getvalue())
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test \
  .venv/bin/python -m pytest tests/test_casebook.py -q
```

预期：FAIL，`app.importers.casebook` 不存在。

- [ ] **Step 4: 实现严格解析器**

新建 `backend/app/importers/casebook.py`。分三层：**形状校验**（字段集 / 必填 / 类型 / 枚举，逐条对应 schema）→ **跨文件一致性**（图片文件、`assets` key、被引用 key 三个集合必须相等）→ **图片解码**（Pillow 校验真实格式与尺寸）。所有错误都带 JSON 路径。

```python
"""Parse a casebook v1 bundle in strict mode: reject, never coerce.

    casebook.json
    assets/sale-stage-selling.png

The image file name without its extension *is* the asset key, so a case names
an asset exactly once. Anything that does not match
``backend/app/schemas/casebook.schema.json`` is rejected with the JSON path that
failed, because the AI prompt embeds that same schema.
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
import json
from pathlib import PurePosixPath
import re
from typing import Any
import zipfile

from PIL import Image, UnidentifiedImageError

from .schema import ImportErrorDetail, MAX_CASES, decode_utf8


CASEBOOK_VERSION = "1.0"
MAX_BUNDLE_BYTES = 100 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024
MAX_ASSET_BYTES = 20 * 1024 * 1024
ASSET_KEY = re.compile(r"^[a-z0-9][a-z0-9-]*$")
CASE_CODE = re.compile(r"^[A-Za-z][A-Za-z0-9]*-[0-9]+(-[A-Za-z0-9]+)*$")
ASSET_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")
ASSET_TYPES = ("page", "modal", "state", "flow")
ROLES = ("expected", "locator")
CHECKS = ("text_and_visual", "visual_only", "not_verifiable")
LAYERS = ("Smoke", "Core", "Regression")
PRIORITIES = ("P0", "P1", "P2")
PILLOW_MIME = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
FORMAT_SUFFIX = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}

# Mirrors the schema: every object is closed and lists its required keys.
FIELDS: dict[str, frozenset[str]] = {
    "casebook.json": frozenset({"casebook", "doc", "assets", "cases"}),
    "doc": frozenset({"title", "prototype"}),
    "doc.prototype": frozenset({"version", "source", "exported_at"}),
    "assets.<key>": frozenset({"name", "type", "screen", "state"}),
    "cases[]": frozenset(
        {
            "code",
            "title",
            "position",
            "module",
            "layer",
            "priority",
            "preconditions",
            "test_data",
            "steps",
            "expected",
            "expect_absent",
            "visual",
        }
    ),
    "cases[].visual": frozenset({"check", "note", "references"}),
    "cases[].visual.references[]": frozenset({"asset", "role", "caption", "focus"}),
    "focus[]": frozenset({"label", "note", "box"}),
}
REQUIRED: dict[str, tuple[str, ...]] = {
    "casebook.json": ("casebook", "doc", "assets", "cases"),
    "doc": ("title", "prototype"),
    "doc.prototype": ("version",),
    "assets.<key>": ("name", "type"),
    "cases[]": ("code", "title", "steps", "expected", "visual"),
    "cases[].visual": ("check", "references"),
    "cases[].visual.references[]": ("asset", "role"),
    "focus[]": ("label",),
}


@dataclass(frozen=True, slots=True)
class BundleFocus:
    label: str
    note: str | None
    box: tuple[float, float, float, float] | None


@dataclass(frozen=True, slots=True)
class BundleAsset:
    asset_key: str
    name: str
    asset_type: str
    screen: str | None
    state: str | None
    source_path: str
    content: bytes
    mime: str
    width: int
    height: int
    prototype_version: str

    @property
    def suffix(self) -> str:
        return FORMAT_SUFFIX[self.mime]


@dataclass(frozen=True, slots=True)
class BundleReference:
    asset_key: str
    role: str
    caption: str | None
    focus: tuple[BundleFocus, ...]


@dataclass(frozen=True, slots=True)
class BundleCase:
    code: str
    position: int
    title: str
    module: str | None
    layer: str | None
    priority: str | None
    preconditions: str | None
    test_data: str | None
    steps: str
    expected: str
    expect_absent: tuple[str, ...]
    visual_check: str
    prototype_note: str | None
    raw: dict[str, Any]
    references: tuple[BundleReference, ...]


@dataclass(frozen=True, slots=True)
class CasebookDocument:
    title: str
    prototype_version: str
    assets: dict[str, BundleAsset]
    cases: tuple[BundleCase, ...]


def parse_casebook(content: bytes) -> CasebookDocument:
    if not content:
        raise ImportErrorDetail("The casebook bundle is empty")
    if len(content) > MAX_BUNDLE_BYTES:
        raise ImportErrorDetail("The casebook bundle exceeds the 100 MB limit")

    entries = _read_entries(content)
    document = _object(
        _read_json(entries, "casebook.json"), "casebook.json", "casebook.json"
    )
    if document["casebook"] != CASEBOOK_VERSION:
        raise ImportErrorDetail(
            f"Unsupported casebook version {document['casebook']!r}; "
            f"expected {CASEBOOK_VERSION!r}"
        )

    doc = _object(document["doc"], "doc", "doc")
    title = _text(doc["title"], "doc.title", maximum=200)
    prototype = _object(doc["prototype"], "doc.prototype", "doc.prototype")
    prototype_version = _text(
        prototype["version"], "doc.prototype.version", maximum=60
    )
    if "source" in prototype:
        _text(prototype["source"], "doc.prototype.source")
    if "exported_at" in prototype:
        _text(prototype["exported_at"], "doc.prototype.exported_at")

    files = _image_files(entries)
    registry = _asset_registry(document["assets"])

    listed = document["cases"]
    if not isinstance(listed, list) or not listed:
        raise ImportErrorDetail("cases: must be a non-empty array")
    if len(listed) > MAX_CASES:
        raise ImportErrorDetail(f"cases: contains more than {MAX_CASES} cases")

    codes: set[str] = set()
    positions: set[int] = set()
    cases: list[BundleCase] = []
    for index, raw_case in enumerate(listed):
        path = f"cases[{index}]"
        entry = _object(raw_case, path, "cases[]")
        code = _text(entry["code"], f"{path}.code")
        if not CASE_CODE.fullmatch(code):
            raise ImportErrorDetail(f"{path}.code: must look like <MODULE>-<number>")
        if code.casefold() in codes:
            raise ImportErrorDetail(f"{path}.code: duplicate code {code}")
        codes.add(code.casefold())

        case_title = _text(entry["title"], f"{path}.title", maximum=120)
        steps = _string_list(entry["steps"], f"{path}.steps", minimum=1)
        expected = _string_list(entry["expected"], f"{path}.expected", minimum=1)
        expect_absent = _string_list(
            entry.get("expect_absent", []), f"{path}.expect_absent"
        )

        position = (
            index + 1
            if entry.get("position") is None
            else _integer(entry["position"], f"{path}.position")
        )
        if position in positions:
            raise ImportErrorDetail(f"{path}.position: duplicate position {position}")
        positions.add(position)

        visual = _object(entry["visual"], f"{path}.visual", "cases[].visual")
        check = _enum(visual["check"], f"{path}.visual.check", CHECKS)
        note = (
            _text(visual["note"], f"{path}.visual.note") if "note" in visual else None
        )
        references = _references(
            visual["references"], f"{path}.visual.references", files
        )
        if check != "not_verifiable" and not references:
            raise ImportErrorDetail(
                f"{path}.visual.references: needs at least one image when "
                f"check is {check!r}"
            )
        if check == "not_verifiable" and note is None:
            raise ImportErrorDetail(
                f"{path}.visual.note: required when check is 'not_verifiable'"
            )

        cases.append(
            BundleCase(
                code=code,
                position=position,
                title=case_title,
                module=_optional(entry, "module", f"{path}.module"),
                layer=_optional_enum(entry, "layer", f"{path}.layer", LAYERS),
                priority=_optional_enum(
                    entry, "priority", f"{path}.priority", PRIORITIES
                ),
                preconditions=_optional(entry, "preconditions", f"{path}.preconditions"),
                test_data=_optional(entry, "test_data", f"{path}.test_data"),
                steps="\n".join(steps),
                expected="\n".join(expected),
                expect_absent=tuple(expect_absent),
                visual_check=check,
                prototype_note=note,
                raw=dict(entry),
                references=references,
            )
        )

    referenced = {
        reference.asset_key for case in cases for reference in case.references
    }
    unused_images = sorted(set(files) - referenced)
    if unused_images:
        raise ImportErrorDetail(
            f"assets: image(s) never referenced: {', '.join(unused_images)}"
        )
    missing_registry = sorted(referenced - set(registry))
    if missing_registry:
        raise ImportErrorDetail(
            f"assets: missing registry entry for {', '.join(missing_registry)}"
        )
    unused_registry = sorted(set(registry) - referenced)
    if unused_registry:
        raise ImportErrorDetail(
            f"assets: registry entries never referenced: {', '.join(unused_registry)}"
        )

    assets = {
        key: _load_asset(key, entries, files[key], registry[key], prototype_version)
        for key in sorted(referenced)
    }
    return CasebookDocument(
        title=title,
        prototype_version=prototype_version,
        assets=assets,
        cases=tuple(cases),
    )


def _object(value: Any, path: str, kind: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ImportErrorDetail(f"{path}: must be an object")
    unknown = sorted(set(value) - FIELDS[kind])
    if unknown:
        raise ImportErrorDetail(f"{path}: unknown field(s) {', '.join(unknown)}")
    for name in REQUIRED[kind]:
        if name not in value:
            raise ImportErrorDetail(f"{path}: missing required field {name!r}")
    return value


def _text(value: Any, path: str, *, maximum: int | None = None) -> str:
    if not isinstance(value, str):
        raise ImportErrorDetail(f"{path}: must be a string")
    text = value.strip()
    if not text:
        raise ImportErrorDetail(f"{path}: must not be empty")
    if maximum is not None and len(text) > maximum:
        raise ImportErrorDetail(f"{path}: must be at most {maximum} characters")
    return text


def _optional(entry: dict[str, Any], name: str, path: str) -> str | None:
    return _text(entry[name], path) if name in entry else None


def _enum(value: Any, path: str, allowed: tuple[str, ...]) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise ImportErrorDetail(
            f"{path}: expected one of {'|'.join(allowed)}, got {value!r}"
        )
    return value


def _optional_enum(
    entry: dict[str, Any], name: str, path: str, allowed: tuple[str, ...]
) -> str | None:
    return _enum(entry[name], path, allowed) if name in entry else None


def _string_list(value: Any, path: str, *, minimum: int = 0) -> list[str]:
    if not isinstance(value, list):
        raise ImportErrorDetail(f"{path}: must be an array of strings")
    if len(value) < minimum:
        raise ImportErrorDetail(f"{path}: needs at least {minimum} item(s)")
    return [_text(item, f"{path}[{index}]") for index, item in enumerate(value)]


def _integer(value: Any, path: str, *, minimum: int = 1) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ImportErrorDetail(f"{path}: must be an integer >= {minimum}")
    return value


def _number(value: Any, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ImportErrorDetail(f"{path}: must be a number")
    number = float(value)
    if number < 0 or number > 1:
        raise ImportErrorDetail(f"{path}: must be normalised between 0 and 1")
    return number


def _references(
    value: Any, path: str, files: dict[str, str]
) -> tuple[BundleReference, ...]:
    if not isinstance(value, list):
        raise ImportErrorDetail(f"{path}: must be an array")
    references: list[BundleReference] = []
    seen: set[str] = set()
    for index, raw in enumerate(value):
        item_path = f"{path}[{index}]"
        entry = _object(raw, item_path, "cases[].visual.references[]")
        key = _text(entry["asset"], f"{item_path}.asset")
        if not ASSET_KEY.fullmatch(key):
            raise ImportErrorDetail(
                f"{item_path}.asset: key must be kebab-case (^[a-z0-9][a-z0-9-]*$)"
            )
        if key not in files:
            raise ImportErrorDetail(f"{item_path}.asset: unknown asset {key!r}")
        if key in seen:
            raise ImportErrorDetail(f"{item_path}.asset: duplicate reference to {key}")
        seen.add(key)
        references.append(
            BundleReference(
                asset_key=key,
                role=_enum(entry["role"], f"{item_path}.role", ROLES),
                caption=(
                    _text(entry["caption"], f"{item_path}.caption")
                    if "caption" in entry
                    else None
                ),
                focus=_focus(entry.get("focus"), f"{item_path}.focus"),
            )
        )
    return tuple(references)


def _focus(value: Any, path: str) -> tuple[BundleFocus, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise ImportErrorDetail(f"{path}: must be an array")
    result: list[BundleFocus] = []
    for index, raw in enumerate(value):
        item_path = f"{path}[{index}]"
        entry = _object(raw, item_path, "focus[]")
        box_value = entry.get("box")
        box: tuple[float, float, float, float] | None = None
        if box_value is not None:
            if not isinstance(box_value, list) or len(box_value) != 4:
                raise ImportErrorDetail(f"{item_path}.box: must be [x, y, w, h]")
            box = (
                _number(box_value[0], f"{item_path}.box[0]"),
                _number(box_value[1], f"{item_path}.box[1]"),
                _number(box_value[2], f"{item_path}.box[2]"),
                _number(box_value[3], f"{item_path}.box[3]"),
            )
        result.append(
            BundleFocus(
                label=_text(entry["label"], f"{item_path}.label"),
                note=(
                    _text(entry["note"], f"{item_path}.note")
                    if "note" in entry
                    else None
                ),
                box=box,
            )
        )
    return tuple(result)


def _read_entries(content: bytes) -> dict[str, bytes]:
    try:
        archive = zipfile.ZipFile(BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise ImportErrorDetail("The bundle is not a readable ZIP file") from exc

    entries: dict[str, bytes] = {}
    total = 0
    with archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            name = _normalize(info.filename)
            if name in entries:
                raise ImportErrorDetail(f"The bundle contains {name} twice")
            total += info.file_size
            if total > MAX_UNCOMPRESSED_BYTES:
                raise ImportErrorDetail("The bundle expands beyond the 250 MB limit")
            entries[name] = archive.read(info)
    if not entries:
        raise ImportErrorDetail("The bundle contains no files")
    return entries


def _normalize(name: str) -> str:
    candidate = name.replace("\\", "/").lstrip("/")
    path = PurePosixPath(candidate)
    if not candidate or path.is_absolute() or ".." in path.parts:
        raise ImportErrorDetail(f"The bundle entry {name!r} is not a safe path")
    if path.parts[0].endswith(":"):
        raise ImportErrorDetail(f"The bundle entry {name!r} is not a safe path")
    return path.as_posix()


def _read_json(entries: dict[str, bytes], filename: str) -> Any:
    matches = [name for name in entries if PurePosixPath(name).name == filename]
    if not matches:
        raise ImportErrorDetail(f"The bundle is missing {filename}")
    if len(matches) > 1:
        raise ImportErrorDetail(f"The bundle contains more than one {filename}")
    try:
        document = json.loads(decode_utf8(entries[matches[0]], bom=True))
    except json.JSONDecodeError as exc:
        raise ImportErrorDetail(f"{filename} is not valid JSON: {exc.msg}") from exc
    if not isinstance(document, dict):
        raise ImportErrorDetail(f"{filename} must be a JSON object")
    return document


def _image_files(entries: dict[str, bytes]) -> dict[str, str]:
    files: dict[str, str] = {}
    for name in entries:
        path = PurePosixPath(name)
        if path.parts[0] != "assets" or len(path.parts) < 2:
            continue
        if path.suffix.lower() not in ASSET_SUFFIXES:
            continue
        key = path.stem
        if not ASSET_KEY.fullmatch(key):
            raise ImportErrorDetail(
                f"The asset file {name} must be named <kebab-case-key>{path.suffix}"
            )
        if key in files:
            raise ImportErrorDetail(f"The bundle contains two files for asset {key!r}")
        files[key] = name
    if not files:
        raise ImportErrorDetail("The bundle contains no images under assets/")
    return files


def _asset_registry(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict) or not value:
        raise ImportErrorDetail("assets: must be a non-empty object")
    registry: dict[str, dict[str, Any]] = {}
    for key, entry in value.items():
        if not isinstance(key, str) or not ASSET_KEY.fullmatch(key):
            raise ImportErrorDetail(
                f"assets.{key}: key must be kebab-case (^[a-z0-9][a-z0-9-]*$)"
            )
        payload = _object(entry, f"assets.{key}", "assets.<key>")
        registry[key] = {
            "name": _text(payload["name"], f"assets.{key}.name"),
            "type": _enum(payload["type"], f"assets.{key}.type", ASSET_TYPES),
            "screen": _optional(payload, "screen", f"assets.{key}.screen"),
            "state": _optional(payload, "state", f"assets.{key}.state"),
        }
    return registry


def _load_asset(
    key: str,
    entries: dict[str, bytes],
    source_path: str,
    registry: dict[str, Any],
    prototype_version: str,
) -> BundleAsset:
    content = entries[source_path]
    if not content:
        raise ImportErrorDetail(f"Prototype image {source_path} is empty")
    if len(content) > MAX_ASSET_BYTES:
        raise ImportErrorDetail(f"Prototype image {source_path} exceeds the 20 MB limit")
    try:
        with Image.open(BytesIO(content)) as image:
            detected = image.format
            width, height = image.size
            image.verify()
    except (UnidentifiedImageError, OSError, ValueError):
        raise ImportErrorDetail(
            f"Prototype image {source_path} is not a readable image"
        ) from None
    mime = PILLOW_MIME.get(detected or "")
    if mime is None:
        raise ImportErrorDetail(
            f"Prototype image {source_path} uses an unsupported format"
        )
    return BundleAsset(
        asset_key=key,
        name=registry["name"],
        asset_type=registry["type"],
        screen=registry["screen"],
        state=registry["state"],
        source_path=source_path,
        content=content,
        mime=mime,
        width=width,
        height=height,
        prototype_version=prototype_version,
    )
```

同一步里给文本格式加原型备注支持（`backend/app/importers/schema.py`）：`ParsedCase` 增加 `prototype_note: str | None`，`FIELDS` 末尾加 `"prototype_note"`，`ALIASES` 增加 `"prototype_note": ("prototype_note", "protoNote", "原型备注", "核图提示")`，`normalize_record` 的 `return` 里补 `prototype_note=values["prototype_note"],`。`parse_file` 仍不认识 `.zip`，ZIP 由 Task 3 分流。

- [ ] **Step 5: 运行测试确认通过**

```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test \
  .venv/bin/python -m pytest tests/test_casebook.py tests/test_importers.py -q
```

预期：PASS（`test_importers.py` 是文本格式回归护栏）。

- [ ] **Step 6: 提交**

```bash
git add backend/app/importers/casebook.py backend/app/importers/schema.py \
  backend/tests/casebook_fixture.py backend/tests/test_casebook.py
git commit -m "feat: strictly parse casebook v1 bundles"
```

---

### Task 3: 导入预览与确认接口

**Files:**
- Create: `backend/app/case_assets.py`（本任务先放存储助手，路由在 Task 4）
- Modify: `backend/app/groups.py`
- Modify: `backend/tests/conftest.py`
- Create: `backend/tests/test_bundle_import_api.py`

- [ ] **Step 1: 写接口失败测试**

`backend/tests/conftest.py`：`upload_dir` fixture 要同时隔离参考图目录。把 `from app import screenshots` 改成 `from app import case_assets, screenshots`，fixture 改成：

```python
@pytest.fixture
def upload_dir(tmp_path, monkeypatch) -> Path:
    directory = tmp_path / "uploads"
    directory.mkdir()
    patched = replace(settings, upload_dir=str(directory))
    monkeypatch.setattr(screenshots, "settings", patched)
    monkeypatch.setattr(case_assets, "settings", patched)
    return directory
```

新建 `backend/app/case_assets.py`（本步只放助手，保证 import 可用）：

```python
from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException

from app.config import settings


# Reference images keep their own subdirectory so the flat, name-checked
# screenshot directory stays untouched.
REFERENCE_DIRECTORY = "reference"


def new_storage_key(suffix: str) -> str:
    return f"{uuid4().hex}{suffix}"


def reference_path(storage_key: str) -> Path:
    # Defend the stored key: a key with separators must never escape UPLOAD_DIR.
    if Path(storage_key).name != storage_key:
        raise HTTPException(status_code=404, detail="Reference image not found")
    return Path(settings.upload_dir) / REFERENCE_DIRECTORY / storage_key
```

新建 `backend/tests/test_bundle_import_api.py`：

```python
import json
from io import BytesIO
import zipfile

from sqlalchemy import select

from app.models import CaseReferenceAsset, CaseReferenceLink
from tests.casebook_fixture import casebook, casebook_zip, png_bytes


def preview(client, payload: bytes):
    return client.post(
        "/api/import/preview",
        files={"file": ("casebook.zip", payload, "application/zip")},
    )


def test_preview_reports_cases_assets_links_and_version(authenticated_client):
    response = preview(authenticated_client, casebook_zip())

    assert response.status_code == 200
    body = response.json()
    assert body["detected_format"] == "zip"
    assert body["count"] == 2
    # Two unique images, three slots: C-05 uses two, C-11 reuses one as locator.
    assert body["reference_asset_count"] == 2
    assert body["reference_link_count"] == 3
    assert body["prototype_version"] == "v2.0"
    assert body["title"] == "Odyssey 节点发售回归"
    first = body["cases"][0]
    assert first["code"] == "C-05"
    assert first["reference_asset_count"] == 2
    assert first["expect_absent"] == ["已售罄"]
    assert first["visual_check"] == "text_and_visual"
    # Preview never leaks binaries, storage keys or filesystem paths.
    assert "storage_key" not in json.dumps(body)
    assert "source_path" not in json.dumps(body)
    assert "content" not in json.dumps(body)


def test_confirm_dedupes_assets_and_writes_one_file_each(
    authenticated_client, upload_dir, db_session
):
    ticket = preview(authenticated_client, casebook_zip()).json()["ticket_id"]

    created = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": ticket, "name": "Odyssey v2.0"},
    )

    assert created.status_code == 201
    body = created.json()
    assert body["count"] == 2
    assert body["reference_asset_count"] == 2
    assert body["reference_link_count"] == 3

    assets = db_session.scalars(
        select(CaseReferenceAsset).order_by(CaseReferenceAsset.asset_key)
    ).all()
    links = db_session.scalars(select(CaseReferenceLink)).all()
    assert [asset.asset_key for asset in assets] == [
        "sale-confirm-modal",
        "sale-stage-selling",
    ]
    assert len(links) == 3
    assert {link.role for link in links} == {"expected", "locator"}
    assert all("/" not in asset.storage_key for asset in assets)
    assert all(asset.prototype_version == "v2.0" for asset in assets)
    assert sum(len(link.focus) for link in links) == 1

    written = sorted((upload_dir / "reference").iterdir())
    assert len(written) == 2
    assert sum(path.stat().st_size for path in written) == 2 * len(png_bytes())


def test_confirm_keeps_role_caption_and_focus(authenticated_client, db_session):
    ticket = preview(authenticated_client, casebook_zip()).json()["ticket_id"]
    authenticated_client.post(
        "/api/import/confirm", json={"ticket_id": ticket, "name": "Odyssey"}
    )

    captioned = db_session.scalars(
        select(CaseReferenceLink).where(CaseReferenceLink.caption.is_not(None))
    ).one()
    assert captioned.caption == "默认发售态"
    assert captioned.asset.asset_key == "sale-stage-selling"

    focused = next(
        link
        for link in db_session.scalars(select(CaseReferenceLink)).all()
        if link.focus
    )
    assert focused.focus[0]["label"] == "确认按钮"
    assert focused.focus[0]["box"] == [0.62, 0.78, 0.3, 0.08]


def test_casebook_import_rejects_invalid_input(authenticated_client, upload_dir):
    broken = preview(authenticated_client, b"not a zip")
    assert broken.status_code == 422
    assert "ZIP" in broken.json()["detail"]

    empty_zip = BytesIO()
    with zipfile.ZipFile(empty_zip, "w"):
        pass
    missing = preview(authenticated_client, empty_zip.getvalue())
    assert missing.status_code == 422
    assert "casebook.json" in missing.json()["detail"]
    assert not (upload_dir / "reference").exists()

    dangling = preview(
        authenticated_client,
        casebook_zip(
            book=casebook(
                cases=[
                    {
                        "code": "C-05",
                        "title": "认购",
                        "steps": ["点确认购买"],
                        "expected": ["按钮: 显示「确认购买」"],
                        "visual": {
                            "check": "visual_only",
                            "references": [
                                {"asset": "sale-confirm-modal", "role": "expected"}
                            ],
                        },
                    }
                ]
            ),
            images={"sale-stage-selling.png": png_bytes()},
        ),
    )
    assert dangling.status_code == 422
    assert "unknown asset 'sale-confirm-modal'" in dangling.json()["detail"]


def test_confirm_consumes_the_ticket_once(authenticated_client, upload_dir):
    ticket = preview(authenticated_client, casebook_zip()).json()["ticket_id"]
    first = authenticated_client.post(
        "/api/import/confirm", json={"ticket_id": ticket, "name": "Odyssey"}
    )
    second = authenticated_client.post(
        "/api/import/confirm", json={"ticket_id": ticket, "name": "Odyssey"}
    )

    assert first.status_code == 201
    assert second.status_code == 409


def test_text_import_path_is_unchanged(authenticated_client, csv_book):
    response = authenticated_client.post(
        "/api/import/preview",
        files={"file": ("0918.csv", csv_book, "text/csv")},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["detected_format"] == "csv"
    assert "reference_asset_count" not in body
    assert "reference_assets" not in json.dumps(body)
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test \
  .venv/bin/python -m pytest tests/test_bundle_import_api.py -q
```

预期：FAIL，ZIP 走到 `unsupported import format: .zip`。

- [ ] **Step 3: 实现预览流程**

`backend/app/groups.py` 顶部：

```python
from app.case_assets import new_storage_key, reference_path
from app.importers.casebook import (
    BundleFocus,
    CasebookDocument,
    MAX_BUNDLE_BYTES,
    parse_casebook,
)
from app.models import (
    CaseReferenceAsset,
    CaseReferenceLink,
    Group,
    GroupCase,
    ImportTicket,
)


TICKET_TTL = timedelta(minutes=30)
MAX_BUNDLE_SIZE = 100 * 1024 * 1024
```

`preview_import` 按后缀分流，文本分支保持原行为：

```python
@router.post("/import/preview")
async def preview_import(
    file: Annotated[UploadFile, File()],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, Any]:
    filename = file.filename or "upload"
    is_casebook = Path(filename).suffix.lower() == ".zip"
    limit = MAX_BUNDLE_SIZE if is_casebook else MAX_FILE_SIZE
    content = await file.read(limit + 1)
    if is_casebook:
        document = _parse_casebook_or_422(content)
        parsed = _casebook_ticket_payload(filename, document)
        preview = _casebook_preview_payload(document)
    else:
        text_cases = _parse_or_422(filename, content)
        parsed = {
            "source_name": filename,
            "cases": [asdict(case) for case in text_cases],
        }
        preview = {
            "count": len(text_cases),
            "cases": [_case_payload(case) for case in text_cases[:10]],
            "fields": sorted({str(key) for case in text_cases for key in case.raw}),
        }

    now = datetime.now(timezone.utc)
    file_sha256 = hashlib.sha256(content).hexdigest()
    duplicate = db.scalar(
        select(Group.id).where(Group.source_sha256 == file_sha256).limit(1)
    )

    db.execute(
        update(ImportTicket)
        .where(ImportTicket.expires_at <= now, ImportTicket.consumed_at.is_(None))
        .values(original_file=b"")
    )
    ticket = ImportTicket(
        file_sha256=file_sha256,
        original_file=content,
        parsed=parsed,
        expires_at=now + TICKET_TTL,
    )
    db.add(ticket)
    db.commit()
    db.refresh(ticket)

    return {
        "ticket_id": ticket.id,
        "detected_format": Path(filename).suffix.lower().lstrip("."),
        "errors": [],
        "warnings": ["This file was imported before"] if duplicate else [],
        **preview,
    }
```

```python
def _parse_casebook_or_422(content: bytes) -> CasebookDocument:
    try:
        return parse_casebook(content)
    except ImportErrorDetail as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _focus_payload(focus: BundleFocus) -> dict[str, Any]:
    return {
        "label": focus.label,
        "note": focus.note,
        "box": list(focus.box) if focus.box is not None else None,
    }


def _casebook_ticket_payload(
    filename: str, document: CasebookDocument
) -> dict[str, Any]:
    """Store metadata only; the image bytes stay inside original_file."""

    return {
        "source_name": filename,
        "casebook": True,
        "title": document.title,
        "prototype_version": document.prototype_version,
        "assets": [
            {
                "asset_key": asset.asset_key,
                "name": asset.name,
                "asset_type": asset.asset_type,
                "screen": asset.screen,
                "state": asset.state,
                "source_path": asset.source_path,
                "mime": asset.mime,
                "size_bytes": len(asset.content),
                "width": asset.width,
                "height": asset.height,
            }
            for asset in document.assets.values()
        ],
        "cases": [
            {
                "code": case.code,
                "position": case.position,
                "title": case.title,
                "module": case.module,
                "layer": case.layer,
                "priority": case.priority,
                "preconditions": case.preconditions,
                "test_data": case.test_data,
                "steps": case.steps,
                "expected": case.expected,
                "expect_absent": list(case.expect_absent),
                "visual_check": case.visual_check,
                "prototype_note": case.prototype_note,
                "raw": case.raw,
                "references": [
                    {
                        "asset_key": reference.asset_key,
                        "role": reference.role,
                        "caption": reference.caption,
                        "focus": [_focus_payload(item) for item in reference.focus],
                    }
                    for reference in case.references
                ],
            }
            for case in document.cases
        ],
    }


def _casebook_preview_payload(document: CasebookDocument) -> dict[str, Any]:
    return {
        "count": len(document.cases),
        "title": document.title,
        "prototype_version": document.prototype_version,
        "reference_asset_count": len(document.assets),
        "reference_link_count": sum(len(case.references) for case in document.cases),
        "fields": [
            "code",
            "title",
            "position",
            "module",
            "priority",
            "preconditions",
            "steps",
            "expected",
            "expect_absent",
            "visual_check",
        ],
        "cases": [
            {
                "code": case.code,
                "position": case.position,
                "title": case.title,
                "module": case.module,
                "layer": case.layer,
                "priority": case.priority,
                "preconditions": case.preconditions,
                "test_data": case.test_data,
                "steps": case.steps,
                "expected": case.expected,
                "expect_absent": list(case.expect_absent),
                "visual_check": case.visual_check,
                "reference_asset_count": len(case.references),
            }
            for case in document.cases[:10]
        ],
    }
```

- [ ] **Step 4: 实现确认流程**

```python
@router.post("/import/confirm", status_code=status.HTTP_201_CREATED)
def confirm_import(
    payload: ConfirmImport,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, Any]:
    ticket = db.scalar(
        select(ImportTicket)
        .where(ImportTicket.id == payload.ticket_id)
        .with_for_update()
    )
    if ticket is None:
        raise HTTPException(status_code=404, detail="Import ticket not found")
    if ticket.consumed_at is not None:
        raise HTTPException(status_code=409, detail="Import ticket was already consumed")

    now = datetime.now(timezone.utc)
    if ticket.expires_at <= now:
        ticket.original_file = b""
        db.commit()
        raise HTTPException(status_code=410, detail="Import ticket expired")

    source_name = str(ticket.parsed["source_name"])
    group_id = uuid4()
    written: list[Path] = []
    if ticket.parsed.get("casebook"):
        document = _parse_casebook_or_422(ticket.original_file)
        group_cases, written = _casebook_group_cases(document)
        asset_count = len(document.assets)
        link_count = sum(len(case.references) for case in document.cases)
    else:
        parsed_cases = _parse_or_422(
            source_name, ticket.original_file, payload.mapping or None
        )
        group_cases = [_group_case(case) for case in parsed_cases]
        asset_count = 0
        link_count = 0

    group = Group(
        id=group_id,
        short_code=_group_short_code(payload.name, group_id),
        name=payload.name,
        source_name=source_name,
        source_sha256=ticket.file_sha256,
        source_format=Path(source_name).suffix.lower().lstrip("."),
        source_version=ticket.file_sha256[:12],
        cases=group_cases,
    )
    ticket.consumed_at = now
    ticket.original_file = b""
    db.add(group)
    try:
        db.commit()
    except Exception:
        db.rollback()
        for path in written:
            path.unlink(missing_ok=True)
        raise
    db.refresh(group)
    return {
        "id": group.id,
        "count": len(group_cases),
        "reference_asset_count": asset_count,
        "reference_link_count": link_count,
    }


def _casebook_group_cases(
    document: CasebookDocument,
) -> tuple[list[GroupCase], list[Path]]:
    written: list[Path] = []
    assets: dict[str, CaseReferenceAsset] = {}
    try:
        for key, asset in document.assets.items():
            storage_key = new_storage_key(asset.suffix)
            target = reference_path(storage_key)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(asset.content)
            written.append(target)
            assets[key] = CaseReferenceAsset(
                asset_key=key,
                name=asset.name,
                storage_key=storage_key,
                mime=asset.mime,
                size_bytes=len(asset.content),
                width=asset.width,
                height=asset.height,
                asset_type=asset.asset_type,
                screen=asset.screen,
                state=asset.state,
                source_path=asset.source_path,
                prototype_version=asset.prototype_version,
            )
        group_cases = [
            GroupCase(
                code=case.code,
                position=case.position,
                title=case.title,
                module=case.module,
                layer=case.layer,
                priority=case.priority,
                preconditions=case.preconditions,
                test_data=case.test_data,
                steps=case.steps,
                expected=case.expected,
                expect_absent=list(case.expect_absent),
                visual_check=case.visual_check,
                prototype_note=case.prototype_note,
                raw=case.raw,
                reference_links=[
                    CaseReferenceLink(
                        asset=assets[reference.asset_key],
                        role=reference.role,
                        caption=reference.caption,
                        focus=[_focus_payload(item) for item in reference.focus],
                        sort_order=index,
                    )
                    for index, reference in enumerate(case.references)
                ],
            )
            for case in document.cases
        ]
    except OSError as exc:
        for path in written:
            path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=500, detail="Could not store the reference image"
        ) from exc
    return group_cases, written
```

文本分支的 `GroupCase` 补两个新列：

```python
def _group_case(case: ParsedCase) -> GroupCase:
    return GroupCase(
        **asdict(case),
        expect_absent=[],
        visual_check="text_and_visual",
    )
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test \
  .venv/bin/python -m pytest tests/test_bundle_import_api.py tests/test_groups_api.py tests/test_execution.py -q
```

预期：全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add backend/app/case_assets.py backend/app/groups.py backend/tests/conftest.py backend/tests/test_bundle_import_api.py
git commit -m "feat: import casebook bundles with reference images"
```

---

### Task 4: 参考图读取接口与用例载荷

**Files:**
- Modify: `backend/app/case_assets.py`
- Modify: `backend/app/main.py`
- Modify: `backend/app/groups.py`
- Create: `backend/tests/test_case_assets.py`

- [ ] **Step 1: 写接口失败测试**

新建 `backend/tests/test_case_assets.py`：

```python
from uuid import uuid4

from sqlalchemy import select

from app.models import CaseReferenceAsset
from tests.casebook_fixture import casebook_zip


def import_casebook(client) -> tuple[str, list[dict]]:
    preview = client.post(
        "/api/import/preview",
        files={"file": ("casebook.zip", casebook_zip(), "application/zip")},
    )
    created = client.post(
        "/api/import/confirm",
        json={"ticket_id": preview.json()["ticket_id"], "name": "Odyssey v2.0"},
    )
    group_id = created.json()["id"]
    return group_id, client.get(f"/api/groups/{group_id}/cases").json()


def test_case_list_returns_role_caption_and_focus(authenticated_client):
    _, cases = import_casebook(authenticated_client)

    first = cases[0]
    assert [asset["asset_key"] for asset in first["reference_assets"]] == [
        "sale-stage-selling",
        "sale-confirm-modal",
    ]
    assert first["reference_assets"][0]["role"] == "expected"
    assert first["reference_assets"][0]["caption"] == "默认发售态"
    assert first["reference_assets"][0]["name"] == "节点发售 · 阶段1 发售中"
    assert first["reference_assets"][0]["prototype_version"] == "v2.0"
    assert first["reference_assets"][1]["focus"][0]["label"] == "确认按钮"
    assert first["expect_absent"] == ["已售罄"]
    assert first["visual_check"] == "text_and_visual"
    assert first["prototype_note"] is None
    assert cases[1]["visual_check"] == "not_verifiable"
    assert cases[1]["prototype_note"] == "红色倒计时原型默认不展示，需要演示开关触发"
    assert cases[1]["reference_assets"][0]["role"] == "locator"
    # Neither the filesystem path nor the binary ever reaches the client.
    assert "storage_key" not in str(cases)
    assert "source_path" not in str(cases)


def test_two_cases_share_one_asset_row(authenticated_client):
    _, cases = import_casebook(authenticated_client)

    first_id = cases[0]["reference_assets"][0]["id"]
    second_id = cases[1]["reference_assets"][0]["id"]

    assert first_id == second_id


def test_reference_image_is_served_privately(
    authenticated_client, anonymous_client, upload_dir
):
    _, cases = import_casebook(authenticated_client)
    asset_id = cases[0]["reference_assets"][0]["id"]

    assert (
        anonymous_client.get(f"/api/case-reference-assets/{asset_id}").status_code == 401
    )

    image = authenticated_client.get(f"/api/case-reference-assets/{asset_id}")
    assert image.status_code == 200
    assert image.headers["content-type"] == "image/png"
    assert image.headers["cache-control"] == "private, no-store"
    assert image.content.startswith(b"\x89PNG")


def test_unknown_reference_image_is_404(authenticated_client):
    assert (
        authenticated_client.get(f"/api/case-reference-assets/{uuid4()}").status_code
        == 404
    )


def test_missing_file_for_a_known_asset_is_404(
    authenticated_client, db_session, upload_dir
):
    _, cases = import_casebook(authenticated_client)
    asset_id = cases[0]["reference_assets"][0]["id"]
    storage_key = db_session.scalar(
        select(CaseReferenceAsset.storage_key).where(CaseReferenceAsset.id == asset_id)
    )
    (upload_dir / "reference" / storage_key).unlink()

    assert (
        authenticated_client.get(f"/api/case-reference-assets/{asset_id}").status_code
        == 404
    )


def test_a_group_without_reference_images_lists_empty_assets(
    authenticated_client, imported_group
):
    cases = authenticated_client.get(f"/api/groups/{imported_group.id}/cases").json()

    assert cases[0]["reference_assets"] == []
    assert cases[0]["expect_absent"] == []
    assert cases[0]["visual_check"] == "text_and_visual"
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test \
  .venv/bin/python -m pytest tests/test_case_assets.py -q
```

预期：FAIL，用例载荷没有 `reference_assets`，图片路由 404。

- [ ] **Step 3: 补全参考图模块**

`backend/app/case_assets.py` 在助手之上加 `link_payload` 与读图路由：

```python
from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.config import settings
from app.db import get_db
from app.models import CaseReferenceAsset, CaseReferenceLink


# Reference images keep their own subdirectory so the flat, name-checked
# screenshot directory stays untouched.
REFERENCE_DIRECTORY = "reference"

router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])


def new_storage_key(suffix: str) -> str:
    return f"{uuid4().hex}{suffix}"


def reference_path(storage_key: str) -> Path:
    if Path(storage_key).name != storage_key:
        raise HTTPException(status_code=404, detail="Reference image not found")
    return Path(settings.upload_dir) / REFERENCE_DIRECTORY / storage_key


def link_payload(link: CaseReferenceLink) -> dict[str, Any]:
    """One case's view of one asset; the bytes are fetched by asset id."""

    asset = link.asset
    return {
        "id": asset.id,
        "link_id": link.id,
        "asset_key": asset.asset_key,
        "name": asset.name,
        "mime": asset.mime,
        "width": asset.width,
        "height": asset.height,
        "asset_type": asset.asset_type,
        "screen": asset.screen,
        "state": asset.state,
        "prototype_version": asset.prototype_version,
        "role": link.role,
        "caption": link.caption,
        "focus": link.focus,
    }


@router.get("/case-reference-assets/{asset_id}")
def read_reference_asset(
    asset_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> FileResponse:
    asset = db.get(CaseReferenceAsset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Reference image not found")
    path = reference_path(asset.storage_key)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Reference image not found")
    return FileResponse(
        path,
        media_type=asset.mime,
        headers={"Cache-Control": "private, no-store"},
    )
```

`backend/app/main.py` 注册：

```python
from app.case_assets import router as case_assets_router

app.include_router(case_assets_router)
```

- [ ] **Step 4: 用例列表返回参考图**

`backend/app/groups.py` 用两层 `selectinload` 一次带出「用例 → link → asset」：

```python
from sqlalchemy.orm import Session, selectinload

from app.case_assets import link_payload, new_storage_key, reference_path


@router.get("/groups/{group_id}/cases")
def list_group_cases(
    group_id: UUID, db: Annotated[Session, Depends(get_db)]
) -> list[dict[str, Any]]:
    if db.get(Group, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")
    cases = db.scalars(
        select(GroupCase)
        .where(GroupCase.group_id == group_id)
        .options(
            selectinload(GroupCase.reference_links).selectinload(
                CaseReferenceLink.asset
            )
        )
        .order_by(GroupCase.position)
    ).all()
    return [
        {
            "id": case.id,
            "code": case.code,
            "position": case.position,
            "title": case.title,
            "module": case.module,
            "layer": case.layer,
            "priority": case.priority,
            "preconditions": case.preconditions,
            "test_data": case.test_data,
            "steps": case.steps,
            "expected": case.expected,
            "expect_absent": case.expect_absent,
            "visual_check": case.visual_check,
            "prototype_note": case.prototype_note,
            "reference_assets": [link_payload(link) for link in case.reference_links],
        }
        for case in cases
    ]
```

模型关系上的 `order_by="CaseReferenceLink.sort_order"` 保证顺序与 `references` 一致。

- [ ] **Step 5: 运行测试确认通过**

```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test \
  .venv/bin/python -m pytest tests/test_case_assets.py tests/test_bundle_import_api.py tests/test_execution.py tests/test_lark_history.py -q
```

预期：PASS。

- [ ] **Step 6: 提交**

```bash
git add backend/app/case_assets.py backend/app/main.py backend/app/groups.py backend/tests/test_case_assets.py
git commit -m "feat: serve case reference images"
```

---

### Task 5: 前端类型、导入页与测试夹具

**Files:**
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/views/Import.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/views/Import.test.tsx`
- Modify: `frontend/src/views/Execution.test.tsx`
- Modify: `frontend/src/views/Groups.test.tsx`

- [ ] **Step 1: 写导入页失败测试**

`frontend/src/views/Import.test.tsx` 追加：

```tsx
it("shows casebook totals for a casebook zip", async () => {
  const previewSpy = vi.fn().mockResolvedValue({
    ticket_id: "casebook-ticket",
    detected_format: "zip",
    count: 67,
    title: "Odyssey 节点发售回归",
    reference_asset_count: 99,
    reference_link_count: 182,
    prototype_version: "v2.0",
    cases: [
      {
        code: "C-05",
        position: 1,
        title: "认购主流程-准确",
        module: "二、节点认购与期次",
        priority: null,
        expect_absent: ["已售罄"],
        visual_check: "text_and_visual",
        reference_asset_count: 2
      }
    ],
    fields: ["code", "title"],
    errors: [],
    warnings: []
  });
  render(<ImportView preview={previewSpy} confirm={vi.fn()} onImported={vi.fn()} />);

  await userEvent.upload(
    screen.getByLabelText("选择用例文件"),
    new File(["PK"], "odyssey-casebook.zip", { type: "application/zip" })
  );

  expect(await screen.findByText(/原型图 99 张/)).toBeVisible();
  expect(screen.getByText(/引用 182 处/)).toBeVisible();
  expect(screen.getByText(/原型版本 v2\.0/)).toBeVisible();
  expect(screen.getByText("原型图 2 张")).toBeVisible();
});
```

这些断言都落在**同一个元素的直接文本**上，所以下面的摘要尾巴要渲染成一个 `<span>`，不要把「用例包 / 原型图 / 引用 / 版本」拆成多个元素。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd frontend && npx vitest run src/views/Import.test.tsx
```

预期：FAIL，找不到「原型图 99 张」。

- [ ] **Step 3: 扩展类型与客户端**

`frontend/src/api.ts`：

```typescript
export type PreviewCase = {
  code: string;
  position: number;
  title: string;
  module: string | null;
  priority: string | null;
  expect_absent?: string[];
  visual_check?: string;
  reference_asset_count?: number;
};

export type ImportPreview = {
  ticket_id: string;
  detected_format: string;
  count: number;
  cases: PreviewCase[];
  fields: string[];
  errors: string[];
  warnings: string[];
  title?: string | null;
  reference_asset_count?: number;
  reference_link_count?: number;
  prototype_version?: string | null;
};

export type ReferenceFocus = {
  label: string;
  note: string | null;
  box: [number, number, number, number] | null;
};

export type ReferenceAsset = {
  id: string;
  link_id: string;
  asset_key: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  asset_type: string;
  screen: string | null;
  state: string | null;
  prototype_version: string | null;
  role: "expected" | "locator";
  caption: string | null;
  focus: ReferenceFocus[];
};

export type GroupCase = PreviewCase & {
  id: string;
  layer: string | null;
  preconditions: string | null;
  test_data: string | null;
  steps: string | null;
  expected: string | null;
  expect_absent: string[];
  visual_check: string;
  prototype_note: string | null;
  reference_assets: ReferenceAsset[];
};
```

`api` 对象里加：

```typescript
  referenceAssetUrl: (assetId: string) => `/api/case-reference-assets/${assetId}`,
```

- [ ] **Step 4: 更新导入页**

`frontend/src/views/Import.tsx` 四处改动：

```tsx
        <input ref={inputRef} className="visually-hidden" aria-label="选择用例文件" type="file" multiple accept=".md,.markdown,.csv,.json,.zip" onChange={chooseFiles} />
```

```tsx
          <Upload size={24} /><span>选择用例文件</span><small>MD / CSV / JSON / 带图用例包 ZIP</small>
```

```tsx
      name: file.name.replace(/\.(md|markdown|csv|json|zip)$/i, ""),
```

```tsx
                  <div className="preview-summary">
                    <span>{item.preview.detected_format.toUpperCase()}</span>
                    <strong>{item.preview.count}</strong>
                    <span>条用例</span>
                    {item.preview.reference_asset_count ? (
                      <span className="preview-casebook">
                        {` · 原型图 ${item.preview.reference_asset_count} 张`}
                        {item.preview.reference_link_count
                          ? ` · 引用 ${item.preview.reference_link_count} 处`
                          : ""}
                        {item.preview.prototype_version
                          ? ` · 原型版本 ${item.preview.prototype_version}`
                          : ""}
                      </span>
                    ) : null}
                  </div>
```

预览表格加一列：

```tsx
                    <table><thead><tr><th>编号</th><th>标题</th><th>模块</th><th>原型</th></tr></thead>
                      <tbody>{item.preview.cases.slice(0, 4).map((testCase) => <tr key={testCase.code}><td>{testCase.code}</td><td>{testCase.title}</td><td>{testCase.module ?? "-"}</td><td>{testCase.reference_asset_count ? `原型图 ${testCase.reference_asset_count} 张` : "-"}</td></tr>)}</tbody>
                    </table>
```

`frontend/src/App.tsx` 传参考图 URL（Task 7 使用）：

```tsx
            referenceAssetUrl={api.referenceAssetUrl}
```

- [ ] **Step 5: 同步测试夹具**

`frontend/src/views/Execution.test.tsx` 的 `testCase()` 补：

```tsx
    expected,
    expect_absent: [],
    visual_check: "text_and_visual",
    prototype_note: null,
    reference_assets: []
  };
```

`frontend/src/views/Groups.test.tsx` 两处字面量补 `expect_absent: [], visual_check: "text_and_visual", prototype_note: null, reference_assets: []`：

```tsx
  second.resolve([{ id: "b1", code: "B-1", position: 1, title: "Second group case", module: null, layer: null, priority: null, preconditions: null, test_data: null, steps: null, expected: null, expect_absent: [], visual_check: "text_and_visual", prototype_note: null, reference_assets: [] }]);
```

- [ ] **Step 6: 运行测试确认通过**

```bash
cd frontend && npx vitest run src/views/Import.test.tsx src/views/Groups.test.tsx src/views/Execution.test.tsx
cd frontend && npm run build
```

预期：PASS，构建成功。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/api.ts frontend/src/views/Import.tsx frontend/src/App.tsx \
  frontend/src/views/Import.test.tsx frontend/src/views/Execution.test.tsx frontend/src/views/Groups.test.tsx
git commit -m "feat: preview casebook bundles in the import page"
```

---

### Task 6: schema 文件、两份 AI 提示词与导入页入口

**Files:**
- Create: `backend/app/schemas/casebook.schema.json`
- Create: `backend/app/prompts/ai-casebook.md`
- Create: `backend/app/prompts/ai-cases.md`
- Create: `backend/app/prompts.py`
- Create: `docs/AI-CASEBOOK-PROMPT.md`
- Modify: `backend/app/main.py`
- Create: `backend/tests/test_ai_prompts.py`
- Create: `frontend/src/components/AiPromptPanel.tsx`
- Create: `frontend/src/components/AiPromptPanel.test.tsx`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/views/Import.tsx`

- [ ] **Step 1: 建 schema 文件**

新建 `backend/app/schemas/casebook.schema.json`，内容就是本计划开头「完整 schema」那一节，逐字节一致：

```bash
mkdir -p backend/app/schemas backend/app/prompts
```

（JSON 内容从计划顶部的「完整 schema」代码块复制过去；下一步的提示词会内嵌同一份，测试会强制两者相等。）

- [ ] **Step 2: 写带图提示词（schema 内嵌）**

新建 `docs/AI-CASEBOOK-PROMPT.md`，内容如下；其中 `<!-- casebook-schema:start -->` 与 `<!-- casebook-schema:end -->` 之间必须粘入 `backend/app/schemas/casebook.schema.json` 的完整内容：

```markdown
# AI 生成「用例 + 原型图」用例包 · 提示词（TestDeck 可直接导入）

用法：

1. 先从设计稿按帧导出图片到 `assets/`，文件名用业务语义 kebab-case，例如 `sale-stage-selling.png`、`sale-confirm-modal.png`。
2. 把下面「第一部分」整段复制给 AI，在 `【需求】` 贴 PRD，在 `【已有用例】` 贴你手上的用例（CSV / Markdown / 表格粘贴都行），在 `【图片清单】` 贴 `assets/` 的真实文件名。
3. 让 AI 只输出一个 `casebook.json`；把它和 `assets/` 一起打包成 ZIP，在系统「导入」页上传。
4. 导入端是**严格校验**：任何字段、类型、枚举、引用不一致都会整包拒绝并指出 JSON 路径。不要试图让它宽容，改到通过为止。

---

## 第一部分：提示词（整段复制）

你是一名资深测试工程师。请把我提供的需求和我已有的用例，改写成可以直接导入测试管理系统的 `casebook.json`。

**硬性要求**

1. 只输出一个 JSON 对象本身：不要解释、不要前言、不要 Markdown 代码块围栏。
2. 严格符合下面的 JSON Schema，`additionalProperties` 全部为 false：schema 之外的字段一律不要输出，包括 `slices`、`manifest`、注释字段。
3. 顶层四个键必须齐全：`casebook`（固定字符串 `"1.0"`）、`doc`、`assets`、`cases`。
4. `doc.title` 与 `doc.prototype.version` 必填。
5. `assets` 的 key 必须匹配 `^[a-z0-9][a-z0-9-]*$`，并且**只能**来自我提供的图片清单（文件名去掉扩展名）；每个 key 必须有 `name` 和 `type`。
6. `cases[].code` 格式 `<模块英文大写>-<数字>`（如 `C-05`、`B-012`），包内唯一。
7. `steps` 和 `expected` 必须是字符串数组，每个元素一行，不要写「1. 」这类序号。
8. `expected` 每条写成 `校验位置: 期望现象`；不要写「符合预期」「正常」。
9. 需求里要求「页面上不应出现某内容」时，写进 `expect_absent` 字符串数组。
10. `visual.check` 取 `text_and_visual` / `visual_only` / `not_verifiable`：
    - 前两者：`references` 至少一条，`role` 取 `expected`（这张图就是要核对的画面）或 `locator`（只是帮我找到入口）。
    - `not_verifiable`：必须写 `visual.note` 说明为什么原型覆盖不了，`references` 可以为空。
11. 每条用例的 `references[].asset` 必须是我图片清单里的 key；同一条用例不允许重复引用同一张图。
12. 只有图上确实能指出具体位置时才写 `focus`：`{ "label": "确认按钮", "note": "文案应为「确认购买」", "box": [x, y, w, h] }`，坐标 0–1 归一化；写不出坐标就只留 `label`（`note` 可选）。
13. 三处集合必须完全一致：`assets/` 文件、`assets` 对象 key、被 `references` 引用到的 key。不要导出没有被任何用例引用的图片。
14. 不要输出 Base64，不要输出图片二进制，不要联网抓图。

**JSON Schema（必须逐条满足）**

<!-- casebook-schema:start -->

（这两行标记之间放一个 json 代码块，内容为 casebook.schema.json 的完整 JSON；测试会用正则
`<!-- casebook-schema:start -->\s*```json\s*(.*?)\s*```\s*<!-- casebook-schema:end -->`
抽取并比对，所以代码块语言必须写成 json，标记必须独占一行。）

<!-- casebook-schema:end -->

**输出前自检（逐条核对，不满足就改）**

1. 只输出了一个 JSON 对象，没有代码块围栏和解释文字？
2. 每个对象里都没有 schema 之外的字段？
3. 所有 `references[].asset` 都在图片清单里？清单里的图片都被引用了？
4. 每条用例的 `code` 唯一、`title` 非空、`steps`/`expected` 是字符串数组？
5. 所有 `not_verifiable` 都带了 `visual.note`，其它 check 都至少有一条 `references`？
6. `box` 是否都是 0–1 之间的 4 个数字？
7. `expect_absent` 只放了明确要求「不应出现」的内容？

【需求】
（在这里粘贴 PRD / 页面说明）

【已有用例】
（在这里粘贴你手上的用例）

【图片清单】
（在这里粘贴 assets 目录里的真实文件名，一行一个）

---

## 第二部分：格式速查（人工维护，AI 不需要看到）

完整说明见 [CASEBOOK-FORMAT.md](CASEBOOK-FORMAT.md)。要点：

- 包结构只有一个 JSON 加一棵图片树：`casebook.json` + `assets/<key>.<png|jpg|jpeg|webp>`；**文件名就是 key**。
- 图片按组去重：同一张图被多条用例引用时只存一份，用例侧保留 role / caption / focus。
- ZIP ≤ 100 MB，解压后 ≤ 250 MB，单张图 ≤ 20 MB，用例 1–5000 条。
- 校验是严格模式：字段、类型、枚举、三处集合任一不符都会 422 作废。
- 图片由人从设计稿导出，AI 只写 JSON。

## 第三部分：常见错误写法

| 写法 | 结果 |
| --- | --- |
| 顶层多写 `"slices": [...]` | `casebook.json: unknown field(s) slices` |
| 用例里写 `"steps": "1. 打开页面"` | `cases[0].steps: must be an array of strings` |
| `"role": "Expected"` | `references[0].role: expected one of expected\|locator` |
| 引用清单里没有的图片 | `references[0].asset: unknown asset 'xxx'` |
| 导出了图但没有用例引用 | `assets: image(s) never referenced: xxx` |
| `not_verifiable` 不写 note | `visual.note: required when check is 'not_verifiable'` |
| `box` 写成 `[62, 78, 30, 8]` | `box[0]: must be normalised between 0 and 1` |
| 中文编号 `登录-001` | `cases[0].code: must look like <MODULE>-<number>` |
```

- [ ] **Step 3: 同步镜像内的提示词**

```bash
cp docs/AI-CASEBOOK-PROMPT.md backend/app/prompts/ai-casebook.md
cp docs/AI-CASE-PROMPT.md backend/app/prompts/ai-cases.md
```

`backend/Dockerfile` 是 `COPY app ./app`，所以 `backend/app/prompts/*.md` 与 `backend/app/schemas/*.json` 随镜像发布；前端镜像看不到 `docs/`，这正是提示词要在后端再存一份、并用测试锁一致性的原因。

- [ ] **Step 4: 写后端失败测试**

新建 `backend/tests/test_ai_prompts.py`：

```python
import json
from pathlib import Path
import re

import pytest

from app.prompts import PROMPTS


BACKEND = Path(__file__).parents[1]
SCHEMA = BACKEND / "app" / "schemas" / "casebook.schema.json"
SCHEMA_BLOCK = re.compile(
    r"<!-- casebook-schema:start -->\s*```json\s*(?P<schema>.*?)\s*```\s*"
    r"<!-- casebook-schema:end -->",
    re.DOTALL,
)


def test_prompts_endpoint_serves_both_documents(authenticated_client):
    response = authenticated_client.get("/api/ai-prompts")

    assert response.status_code == 200
    prompts = response.json()
    assert [prompt["id"] for prompt in prompts] == ["cases", "casebook"]
    for prompt in prompts:
        assert prompt["title"]
        assert prompt["summary"]
        assert prompt["filename"].endswith(".md")
        assert len(prompt["markdown"]) > 500
        assert "【需求】" in prompt["markdown"]


def test_prompts_endpoint_requires_a_session(client):
    assert client.get("/api/ai-prompts").status_code == 401


def test_shipped_prompts_match_the_docs():
    docs = Path(__file__).parents[2] / "docs"
    if not docs.is_dir():
        pytest.skip("docs/ is not part of this checkout")

    for prompt in PROMPTS:
        source = docs / prompt["filename"]
        if not source.is_file():
            pytest.skip(f"{source} is not present in this checkout")
        assert prompt["path"].read_text(encoding="utf-8") == source.read_text(
            encoding="utf-8"
        ), f"{source} drifted from backend/app/prompts/{prompt['path'].name}"


def test_casebook_prompt_embeds_the_canonical_schema():
    canonical = json.loads(SCHEMA.read_text(encoding="utf-8"))
    prompt = (BACKEND / "app" / "prompts" / "ai-casebook.md").read_text(
        encoding="utf-8"
    )

    match = SCHEMA_BLOCK.search(prompt)

    assert match, "the casebook prompt must embed the schema between the markers"
    assert json.loads(match.group("schema")) == canonical
    assert canonical["properties"]["casebook"]["const"] == "1.0"
    assert canonical["additionalProperties"] is False
```

- [ ] **Step 5: 运行测试确认失败**

```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test \
  .venv/bin/python -m pytest tests/test_ai_prompts.py -q
```

预期：FAIL，`app.prompts` 不存在。

- [ ] **Step 6: 实现提示词接口**

新建 `backend/app/prompts.py`：

```python
"""Serve the AI prompt documents that the import page hands to the user."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends

from app.auth import require_admin


PROMPT_DIR = Path(__file__).parent / "prompts"

PROMPTS: tuple[dict[str, Any], ...] = (
    {
        "id": "cases",
        "title": "文本用例 → 可导入格式",
        "summary": "把手上没有配图的用例整理成 CSV / JSON / Markdown，导入后直接执行。",
        "filename": "AI-CASE-PROMPT.md",
        "path": PROMPT_DIR / "ai-cases.md",
    },
    {
        "id": "casebook",
        "title": "用例 + 原型图 → 带图用例包",
        "summary": "把已有用例和导出的设计稿图片整理成 casebook.json，导入后可以逐条核对原型。",
        "filename": "AI-CASEBOOK-PROMPT.md",
        "path": PROMPT_DIR / "ai-casebook.md",
    },
)

router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])


@router.get("/ai-prompts")
def list_prompts() -> list[dict[str, Any]]:
    return [
        {
            "id": prompt["id"],
            "title": prompt["title"],
            "summary": prompt["summary"],
            "filename": prompt["filename"],
            "markdown": prompt["path"].read_text(encoding="utf-8"),
        }
        for prompt in PROMPTS
    ]
```

`backend/app/main.py` 注册：

```python
from app.prompts import router as prompts_router

app.include_router(prompts_router)
```

- [ ] **Step 7: 前端提示词面板测试**

新建 `frontend/src/components/AiPromptPanel.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { AiPromptPanel } from "./AiPromptPanel";

const prompts = [
  {
    id: "cases",
    title: "文本用例 → 可导入格式",
    summary: "把手上没有配图的用例整理成 CSV。",
    filename: "AI-CASE-PROMPT.md",
    markdown: "# 文本用例提示词"
  },
  {
    id: "casebook",
    title: "用例 + 原型图 → 带图用例包",
    summary: "把用例和设计稿整理成 casebook.json。",
    filename: "AI-CASEBOOK-PROMPT.md",
    markdown: "# 带图用例包提示词"
  }
];

it("lists both prompts with a copy action", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  render(<AiPromptPanel prompts={prompts} />);

  expect(screen.getByText("文本用例 → 可导入格式")).toBeVisible();
  expect(screen.getByText("用例 + 原型图 → 带图用例包")).toBeVisible();

  await userEvent.click(screen.getAllByRole("button", { name: "复制提示词" })[1]);

  expect(writeText).toHaveBeenCalledWith("# 带图用例包提示词");
  expect(await screen.findByText("已复制")).toBeVisible();
});

it("renders a download action per prompt", () => {
  render(<AiPromptPanel prompts={prompts} />);

  expect(
    screen.getByRole("button", { name: "下载 AI-CASEBOOK-PROMPT.md" })
  ).toBeVisible();
});
```

- [ ] **Step 8: 实现提示词面板并接到导入页**

新建 `frontend/src/components/AiPromptPanel.tsx`：

```tsx
import { useState } from "react";
import { Copy, FileDown, Sparkles } from "lucide-react";

export type AiPrompt = {
  id: string;
  title: string;
  summary: string;
  filename: string;
  markdown: string;
};

type Props = { prompts: AiPrompt[] };

export function AiPromptPanel({ prompts }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function copy(prompt: AiPrompt) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(prompt.markdown);
      setCopied(prompt.id);
      setError("");
    } catch {
      setError("复制失败，请改用下载按钮");
    }
  }

  function download(prompt: AiPrompt) {
    const blob = new Blob([prompt.markdown], {
      type: "text/markdown;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = prompt.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (prompts.length === 0) return null;

  return (
    <section className="ai-prompt-panel" aria-label="让 AI 先整理格式">
      <header className="ai-prompt-heading">
        <Sparkles size={18} />
        <div>
          <h3>先用 AI 整理格式，再上传</h3>
          <p>
            把提示词复制给 AI，连同你的需求和已有用例；AI 输出的就是这里能直接导入的格式。
            校验是严格模式，格式不对会整包拒绝并指出具体位置。
          </p>
        </div>
      </header>
      <div className="ai-prompt-cards">
        {prompts.map((prompt) => (
          <article className="ai-prompt-card" key={prompt.id}>
            <div>
              <strong>{prompt.title}</strong>
              <p>{prompt.summary}</p>
            </div>
            <div className="ai-prompt-actions">
              <button type="button" className="primary" onClick={() => void copy(prompt)}>
                <Copy size={15} />
                {copied === prompt.id ? "已复制" : "复制提示词"}
              </button>
              <button
                type="button"
                className="ghost-button"
                aria-label={`下载 ${prompt.filename}`}
                onClick={() => download(prompt)}
              >
                <FileDown size={15} />
                {prompt.filename}
              </button>
            </div>
          </article>
        ))}
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </section>
  );
}
```

`frontend/src/api.ts` 增加类型与方法：

```typescript
export type AiPrompt = {
  id: string;
  title: string;
  summary: string;
  filename: string;
  markdown: string;
};

// in the api object:
  aiPrompts: () => request<AiPrompt[]>("/api/ai-prompts"),
```

`frontend/src/views/Import.tsx`：`Props` 增加 `loadPrompts?: () => Promise<AiPrompt[]>`，用 `useEffect` 加载并把 `<AiPromptPanel prompts={prompts} />` 放在 `section-heading` 之后、上传列表之前；加载失败只显示一行非阻塞提示。`App.tsx` 传 `loadPrompts={api.aiPrompts}`。

样式追加：

```css
.ai-prompt-panel { margin-bottom: 22px; padding: 16px; background: #f7faf9; border: 1px solid #dde1e3; border-radius: 8px; }
.ai-prompt-heading { display: flex; align-items: flex-start; gap: 10px; color: #176b57; }
.ai-prompt-heading h3 { margin-bottom: 4px; }
.ai-prompt-heading p { margin: 0; color: #687178; font-size: .8rem; }
.ai-prompt-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 12px; margin-top: 14px; }
.ai-prompt-card { display: flex; flex-direction: column; justify-content: space-between; gap: 12px; padding: 14px; background: #fff; border: 1px solid #e9eced; border-radius: 7px; }
.ai-prompt-card p { margin: 6px 0 0; color: #687178; font-size: .78rem; }
.ai-prompt-actions { display: flex; flex-wrap: wrap; gap: 8px; }
```

- [ ] **Step 9: 运行测试确认通过**

```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test \
  .venv/bin/python -m pytest tests/test_ai_prompts.py -q
cd frontend && npx vitest run src/components/AiPromptPanel.test.tsx src/views/Import.test.tsx
cd frontend && npm run build
```

预期：PASS，构建成功。

- [ ] **Step 10: 提交**

```bash
git add backend/app/schemas/casebook.schema.json backend/app/prompts backend/app/prompts.py \
  backend/app/main.py backend/tests/test_ai_prompts.py docs/AI-CASEBOOK-PROMPT.md \
  frontend/src/components/AiPromptPanel.tsx frontend/src/components/AiPromptPanel.test.tsx \
  frontend/src/api.ts frontend/src/views/Import.tsx frontend/src/App.tsx frontend/src/styles.css
git commit -m "feat: embed the casebook schema in both AI prompts"
```

---

### Task 7: 执行页展示原型参考图

**Files:**
- Create: `frontend/src/components/ReferenceGallery.tsx`
- Create: `frontend/src/components/ReferenceGallery.test.tsx`
- Modify: `frontend/src/components/CaseDetail.tsx`
- Modify: `frontend/src/views/Execution.tsx`
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: 写组件失败测试**

新建 `frontend/src/components/ReferenceGallery.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ReferenceAsset, ReferenceFocus } from "../api";
import { ReferenceGallery } from "./ReferenceGallery";

function asset(
  overrides: Partial<ReferenceAsset> & { id: string; name: string }
): ReferenceAsset {
  return {
    link_id: `${overrides.id}-link`,
    asset_key: overrides.id,
    mime: "image/png",
    width: 340,
    height: 1658,
    asset_type: "page",
    screen: "节点发售",
    state: "发售中",
    prototype_version: "v2.0",
    role: "expected",
    caption: null,
    focus: [],
    ...overrides
  };
}

const focus: ReferenceFocus = {
  label: "确认按钮",
  note: "文案应为「确认购买」",
  box: [0.62, 0.78, 0.3, 0.08]
};

const url = (id: string) => `/api/case-reference-assets/${id}`;

it("renders nothing without reference images", () => {
  const { container } = render(<ReferenceGallery assets={[]} assetUrl={url} />);

  expect(container).toBeEmptyDOMElement();
});

it("keeps locators out of the stepper and shows focus notes", () => {
  render(
    <ReferenceGallery
      assets={[
        asset({ id: "a1", name: "节点发售", focus: [focus] }),
        asset({ id: "a2", name: "购买确认" }),
        asset({ id: "a3", name: "个人中心入口", role: "locator", caption: "从这里进" })
      ]}
      assetUrl={url}
    />
  );

  expect(screen.getByRole("img", { name: "节点发售" })).toHaveAttribute(
    "src",
    "/api/case-reference-assets/a1"
  );
  expect(screen.getByText("1 / 2")).toBeVisible();
  expect(screen.getByText("确认按钮")).toBeVisible();
  expect(screen.getByText("文案应为「确认购买」")).toBeVisible();
  expect(screen.getByText("定位辅助图")).toBeVisible();
  expect(screen.getByText("个人中心入口")).toBeVisible();
});

it("switches images with the stepper without leaving the expected group", async () => {
  render(
    <ReferenceGallery
      assets={[
        asset({ id: "a1", name: "节点发售" }),
        asset({ id: "a2", name: "购买确认" }),
        asset({ id: "a3", name: "个人中心入口", role: "locator" })
      ]}
      assetUrl={url}
    />
  );

  await userEvent.click(screen.getByRole("button", { name: "下一张原型图" }));

  expect(screen.getByText("2 / 2")).toBeVisible();
  expect(screen.getByRole("img", { name: "购买确认" })).toBeVisible();
  expect(screen.getByRole("button", { name: "下一张原型图" })).toBeDisabled();
});

it("falls back to every image when a case has only locators", () => {
  render(
    <ReferenceGallery
      assets={[asset({ id: "a3", name: "个人中心入口", role: "locator" })]}
      assetUrl={url}
    />
  );

  expect(screen.getByRole("img", { name: "个人中心入口" })).toBeVisible();
});

it("opens a zoom dialog and closes it with Escape", async () => {
  render(
    <ReferenceGallery assets={[asset({ id: "a1", name: "节点发售" })]} assetUrl={url} />
  );

  await userEvent.click(screen.getByRole("button", { name: "放大查看 节点发售" }));
  expect(screen.getByRole("dialog", { name: "节点发售" })).toBeVisible();

  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd frontend && npx vitest run src/components/ReferenceGallery.test.tsx
```

预期：FAIL，组件不存在。

- [ ] **Step 3: 实现组件**

新建 `frontend/src/components/ReferenceGallery.tsx`：

```tsx
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import type { ReferenceAsset } from "../api";

type Props = {
  assets: ReferenceAsset[];
  assetUrl: (assetId: string) => string;
};

export function ReferenceGallery({ assets, assetUrl }: Props) {
  const expected = assets.filter((asset) => asset.role === "expected");
  // A case can legitimately hold only locator images; then they are all we have.
  const primary = expected.length > 0 ? expected : assets;
  const locators = assets.filter((asset) => asset.role === "locator");
  const [index, setIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIndex(0);
    setZoomed(false);
  }, [assets]);

  // Focus the overlay so its own keys win over the execution shortcuts.
  useEffect(() => {
    if (zoomed) dialog.current?.focus();
  }, [zoomed]);

  if (primary.length === 0) return null;
  const current = primary[Math.min(index, primary.length - 1)];

  function step(delta: number) {
    setIndex((value) => Math.min(Math.max(value + delta, 0), primary.length - 1));
  }

  return (
    <section className="reference-gallery" aria-label="原型参考图">
      <header className="reference-gallery-heading">
        <div>
          <p className="eyebrow">REFERENCE</p>
          <h3>原型参考图</h3>
        </div>
        <span className="case-count">{index + 1} / {primary.length}</span>
      </header>
      <button
        type="button"
        className="reference-gallery-main"
        aria-label={`放大查看 ${current.name}`}
        onClick={() => setZoomed(true)}
      >
        <img src={assetUrl(current.id)} alt={current.name} />
      </button>
      <p className="reference-gallery-name">
        <span>{current.caption ?? current.name}</span>
        {current.prototype_version ? <em>原型 {current.prototype_version}</em> : null}
      </p>
      {current.focus.length > 0 ? (
        <ul className="reference-gallery-focus">
          {current.focus.map((item) => (
            <li key={item.label}>
              <strong>{item.label}</strong>
              {item.note ? <span>{item.note}</span> : null}
              {item.box ? (
                <span className="reference-gallery-box">
                  {item.box.map((value) => `${Math.round(value * 100)}%`).join(" / ")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {primary.length > 1 ? (
        <div className="reference-gallery-stepper">
          <button
            type="button"
            className="icon-button"
            aria-label="上一张原型图"
            disabled={index === 0}
            onClick={() => step(-1)}
          >
            <ChevronLeft size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="下一张原型图"
            disabled={index >= primary.length - 1}
            onClick={() => step(1)}
          >
            <ChevronRight size={17} />
          </button>
        </div>
      ) : null}
      {locators.length > 0 ? (
        <div className="reference-gallery-locators">
          <p className="eyebrow">定位辅助图</p>
          <ul>
            {locators.map((asset) => (
              <li key={asset.link_id}>
                <img src={assetUrl(asset.id)} alt="" />
                <span>{asset.caption ?? asset.name}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {zoomed ? (
        <div
          className="reference-gallery-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={current.name}
          tabIndex={-1}
          ref={dialog}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setZoomed(false);
            } else if (event.key === "ArrowLeft") {
              event.stopPropagation();
              step(-1);
            } else if (event.key === "ArrowRight") {
              event.stopPropagation();
              step(1);
            }
          }}
        >
          <div className="reference-gallery-dialog-bar">
            <span>{current.name}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭原型图"
              onClick={() => setZoomed(false)}
            >
              <X size={17} />
            </button>
          </div>
          <img src={assetUrl(current.id)} alt={current.name} />
        </div>
      ) : null}
    </section>
  );
}
```

`event.stopPropagation()` 是必要的：执行工作台在 `window` 上监听 Enter / Backspace / 方向键，放大态下方向键只能切换原型图。

- [ ] **Step 4: 接入用例详情**

`frontend/src/components/CaseDetail.tsx`：

```tsx
import { ChevronLeft, ChevronRight } from "lucide-react";

import type { GroupCase } from "../api";
import { ReferenceGallery } from "./ReferenceGallery";

type Props = {
  testCase: GroupCase;
  position: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  referenceAssetUrl?: (assetId: string) => string;
};

const defaultAssetUrl = (assetId: string) => `/api/case-reference-assets/${assetId}`;
```

在 `</dl>` 之后、`</article>` 之前插入：

```tsx
      {testCase.expect_absent.length > 0 ? (
        <ul className="expect-absent" aria-label="不应出现">
          {testCase.expect_absent.map((text) => (
            <li key={text}>不应出现：{text}</li>
          ))}
        </ul>
      ) : null}
      <ReferenceGallery
        assets={testCase.reference_assets}
        assetUrl={referenceAssetUrl ?? defaultAssetUrl}
      />
      {testCase.prototype_note ? (
        <p className="prototype-note">
          <strong>原型备注</strong>
          <span>{testCase.prototype_note}</span>
        </p>
      ) : null}
```

`frontend/src/views/Execution.tsx` 的 `Props` 增加 `referenceAssetUrl?: (assetId: string) => string;`，解构后传给 `CaseDetail`：

```tsx
            <CaseDetail
              testCase={activeCase}
              position={caseIndex + 1}
              total={cases.length}
              onPrevious={() => void showCase(caseIndex - 1)}
              onNext={() => void showCase(caseIndex + 1)}
              referenceAssetUrl={referenceAssetUrl}
            />
```

- [ ] **Step 5: 增加样式**

`frontend/src/styles.css` 末尾追加（沿用现有调色板）：

```css
.reference-gallery { margin-top: 16px; padding: 12px; background: #fbfcfc; border: 1px solid #dde1e3; border-radius: 8px; }
.reference-gallery-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.reference-gallery-main { display: block; width: 100%; padding: 0; background: none; border: 0; cursor: zoom-in; }
.reference-gallery-main img { display: block; width: 100%; max-height: 320px; object-fit: contain; background: #fff; border: 1px solid #e9eced; border-radius: 6px; }
.reference-gallery-name { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin: 8px 0 0; color: #687178; font-size: .76rem; overflow-wrap: anywhere; }
.reference-gallery-name em { flex-shrink: 0; color: #8b620e; font-style: normal; }
.reference-gallery-focus { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.reference-gallery-focus li { display: flex; flex-wrap: wrap; gap: 8px; padding: 7px 9px; background: #fffdf5; border-left: 3px solid #8b620e; font-size: .78rem; }
.reference-gallery-focus strong { color: #8b620e; }
.reference-gallery-box { color: #8a9297; font-variant-numeric: tabular-nums; }
.reference-gallery-stepper { display: flex; gap: 6px; margin-top: 8px; }
.reference-gallery-locators { margin-top: 12px; }
.reference-gallery-locators ul { display: flex; gap: 10px; margin: 6px 0 0; padding: 0 0 4px; list-style: none; overflow-x: auto; }
.reference-gallery-locators li { display: grid; gap: 4px; justify-items: center; min-width: 72px; color: #687178; font-size: .68rem; text-align: center; }
.reference-gallery-locators img { display: block; width: 64px; height: 64px; object-fit: cover; border: 1px solid #e9eced; border-radius: 5px; }
.reference-gallery-dialog { position: fixed; inset: 0; z-index: 40; display: flex; flex-direction: column; gap: 12px; padding: 16px; background: rgba(20, 25, 30, .9); outline: none; }
.reference-gallery-dialog-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: #fff; font-size: .84rem; }
.reference-gallery-dialog img { flex: 1; min-height: 0; width: 100%; object-fit: contain; }
.expect-absent { display: grid; gap: 6px; margin: 14px 0 0; padding: 10px 12px 10px 28px; background: #fff5f5; border-left: 3px solid #a23b36; border-radius: 0 6px 6px 0; color: #a23b36; font-size: .78rem; }
.prototype-note { display: flex; gap: 9px; margin: 12px 0 0; padding: 10px 12px; background: #fffdf5; border-left: 3px solid #8b620e; border-radius: 0 6px 6px 0; color: #4d555b; font-size: .8rem; overflow-wrap: anywhere; }
.prototype-note strong { flex-shrink: 0; color: #8b620e; }
.case-asset-count { display: inline-flex; align-items: center; gap: 5px; color: #176b57; font-weight: 700; white-space: nowrap; }
.pip-surface .reference-gallery-main img { max-height: 220px; }
@media (max-width: 900px) {
  .reference-gallery-main img { max-height: 220px; }
  .reference-gallery-locators img { width: 52px; height: 52px; }
}
```

- [ ] **Step 6: 运行测试确认通过**

```bash
cd frontend && npx vitest run src/components/ReferenceGallery.test.tsx src/views/Execution.test.tsx src/usePiP.test.tsx
cd frontend && npm run build
```

预期：PASS，构建成功。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/components/ReferenceGallery.tsx frontend/src/components/ReferenceGallery.test.tsx \
  frontend/src/components/CaseDetail.tsx frontend/src/views/Execution.tsx frontend/src/styles.css
git commit -m "feat: show reference images during case execution"
```

---

### Task 8: 报告图片计数与测试组列表标识

**Files:**
- Modify: `backend/app/reports.py`
- Modify: `backend/tests/test_reports.py`
- Modify: `frontend/src/views/Groups.tsx`
- Modify: `frontend/src/views/Groups.test.tsx`

- [ ] **Step 1: 写失败测试**

`backend/tests/test_reports.py` 顶部加 `from tests.casebook_fixture import casebook_zip`，追加：

```python
def test_report_counts_reference_images_separately(authenticated_client, upload_dir):
    preview = authenticated_client.post(
        "/api/import/preview",
        files={"file": ("casebook.zip", casebook_zip(), "application/zip")},
    )
    group_id = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview.json()["ticket_id"], "name": "Odyssey"},
    ).json()["id"]

    rows = _rows(authenticated_client.get(f"/api/groups/{group_id}/reports.csv"))

    # C-05 references two images; C-11 references one locator.
    assert rows[0]["reference_image_count"] == "2"
    assert rows[1]["reference_image_count"] == "1"
    assert rows[0]["screenshot_count"] == "0"
    assert rows[0]["source"] == ""
    assert list(rows[0])[-1] == "source"
```

`frontend/src/views/Groups.test.tsx` 追加：

```tsx
it("marks cases that carry reference images", async () => {
  const reference = {
    id: "asset-1",
    link_id: "link-1",
    asset_key: "sale-stage-selling",
    name: "节点发售",
    mime: "image/png",
    width: 340,
    height: 1658,
    asset_type: "page",
    screen: "节点发售",
    state: "发售中",
    prototype_version: "v2.0",
    role: "expected" as const,
    caption: null,
    focus: []
  };
  const withImages: GroupCase = {
    id: "c1",
    code: "C-05",
    position: 1,
    title: "认购主流程-准确",
    module: null,
    layer: null,
    priority: null,
    preconditions: null,
    test_data: null,
    steps: null,
    expected: null,
    expect_absent: ["已售罄"],
    visual_check: "text_and_visual",
    prototype_note: null,
    reference_assets: [reference, { ...reference, id: "asset-2", link_id: "link-2" }]
  };
  render(<GroupsView
    refreshKey={0}
    loadGroups={async () => [
      { id: "a", name: "Group A", source_name: "a.zip", source_version: "1", count: 1, created_at: "2026-09-16" }
    ]}
    loadCases={async () => [withImages]}
  />);

  await userEvent.click(await screen.findByRole("button", { name: /Group A/ }));
  expect(await screen.findByText("原型 2 张")).toBeVisible();
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test \
  .venv/bin/python -m pytest tests/test_reports.py -q
cd frontend && npx vitest run src/views/Groups.test.tsx
```

预期：FAIL，缺 `reference_image_count` 列与「原型 N 张」。

- [ ] **Step 3: 后端统计**

`backend/app/reports.py`：

```python
from sqlalchemy import func, select

from app.models import Attempt, CaseReferenceLink, Group, GroupCase


def _reference_counts(db: Session, group: Group) -> dict[UUID, int]:
    rows = db.execute(
        select(CaseReferenceLink.group_case_id, func.count(CaseReferenceLink.id))
        .join(GroupCase, CaseReferenceLink.group_case_id == GroupCase.id)
        .where(GroupCase.group_id == group.id)
        .group_by(CaseReferenceLink.group_case_id)
    ).all()
    return dict(rows)
```

`HEADERS` 在 `"screenshot_count"` 之后插入 `"reference_image_count"`（`source` 仍是最后一列）；`_report_rows` 里取 `reference_counts = _reference_counts(db, group)`，并在行字典的 `screenshot_count` 之后加：

```python
                "reference_image_count": reference_counts.get(group_case.id, 0),
```

报告只导出数量，不导出图片 URL，也不内嵌二进制。

- [ ] **Step 4: 前端标识**

`frontend/src/views/Groups.tsx` 导入 `Images` 图标，表头加「原型」列：

```tsx
import { ChevronRight, FileStack, Images, LoaderCircle, RefreshCw } from "lucide-react";
```

```tsx
<table><thead><tr><th>顺序</th><th>编号</th><th>标题</th><th>优先级</th><th>原型</th></tr></thead><tbody>{cases.map((testCase) => <tr key={testCase.id}><td>{testCase.position}</td><td><code>{testCase.code}</code></td><td>{testCase.title}</td><td>{testCase.priority ?? "-"}</td><td>{testCase.reference_assets.length > 0 ? <span className="case-asset-count"><Images size={14} />原型 {testCase.reference_assets.length} 张</span> : "-"}</td></tr>)}</tbody></table>
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test \
  .venv/bin/python -m pytest tests/test_reports.py -q
cd frontend && npx vitest run src/views/Groups.test.tsx
```

预期：PASS。

- [ ] **Step 6: 提交**

```bash
git add backend/app/reports.py backend/tests/test_reports.py frontend/src/views/Groups.tsx frontend/src/views/Groups.test.tsx
git commit -m "feat: report reference image counts"
```

---

### Task 9: 格式规范文档与真实目录验收

**Files:**
- Create: `docs/CASEBOOK-FORMAT.md`
- Modify: `docs/IMPORT-FORMAT.md`
- Modify: `docs/superpowers/plans/README.md`

- [ ] **Step 1: 写格式规范**

新建 `docs/CASEBOOK-FORMAT.md`：把本计划开头「输入包契约：casebook v1」整节搬过去（包结构、**完整 schema**、合法样例、严格校验清单、设计理由），schema 同样放在 `<!-- casebook-schema:start -->` / `<!-- casebook-schema:end -->` 标记之间，并在开头加：

```markdown
# 带图用例包格式（casebook v1，严格模式）

这份文档是「用例 + 原型图」用例包的机器可校验规范，也是 AI 生成提示词的 schema 来源。

- 给 AI 的提示词见 [AI-CASEBOOK-PROMPT.md](AI-CASEBOOK-PROMPT.md)；导入页有「复制提示词」按钮。
- schema 真源是 `backend/app/schemas/casebook.schema.json`；本文件与提示词里内嵌的是同一份，有测试锁一致性。
- 导入端不做类型转换、不做默认值兜底、不兼容旧结构：不符合 schema 的包直接 422 作废，并返回失败的 JSON 路径。
- 没有配图的纯文本用例继续用 CSV / JSON / Markdown，见 [IMPORT-FORMAT.md](IMPORT-FORMAT.md)。
```

- [ ] **Step 2: 更新导入格式文档与计划索引**

`docs/IMPORT-FORMAT.md` 第 1 节支持表格加一行 `.zip`，并在文末追加：

```markdown
## 7. 带原型图的用例包（ZIP）

要把「用例 + 设计稿图片」一起导入，用 casebook 用例包：

```text
odyssey-casebook.zip
├── casebook.json
└── assets/
    ├── sale-stage-selling.png
    └── sale-confirm-modal.png
```

- 文件名（去扩展名）就是 asset key，没有第二份 manifest；引用不存在的 key 会整包拒绝。
- 完整字段与严格校验规则见 [CASEBOOK-FORMAT.md](CASEBOOK-FORMAT.md)。
- 让 AI 把现有用例改写成这个格式：用 [AI-CASEBOOK-PROMPT.md](AI-CASEBOOK-PROMPT.md) 或在导入页点「复制提示词」。
- 图片需要你自己从设计稿导出；AI 只写 JSON。
```

`docs/superpowers/plans/README.md` 编号列表末尾追加：

```markdown
7. `2026-09-16-image-case-bundle-import.md` - import a strict casebook v1 ZIP (`casebook.json` + `assets/`), attach reference images to each case, show them beside the case during execution, and hand both AI prompts (with the embedded schema) to the user on the import page.
```

- [ ] **Step 3: 运行后端全量测试**

```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test \
  .venv/bin/python -m pytest -q
```

预期：全部 PASS（基线 245 条，加上本计划约 30 条）。

- [ ] **Step 4: 运行前端全量测试与构建**

```bash
cd frontend && npx vitest run
cd frontend && npm run build
```

预期：全部 PASS，生产构建成功。

- [ ] **Step 5: 用真实 Odyssey 目录做转换 + 导入验收**

真实目录：`C:\Users\Lucascool\WorkBuddy\2026-09-16-13-35-47\proto`（67 条用例、99 张图、182 处引用、`protoNote` 21 条）。

1. 把 `proto/shots/app`、`proto/shots/admin` 的图片按业务语义重命名成 kebab-case key（`s23` → `sale-confirm-modal` 这类），放进 `assets/`。`s05` 这类编号也是合法 key，所以这一步可以先跳过、先跑通链路。
2. 把 `docs/AI-CASEBOOK-PROMPT.md` 第一部分整段给 AI（含内嵌 schema），`【需求】` 贴 PRD、`【已有用例】` 贴 `proto/cases.json` 的 `sections`、`【图片清单】` 贴 `assets/` 的真实文件名，要求输出 `casebook.json`；`protoNote` 落到 `visual.note` 或 `not_verifiable`。
3. 打包：

```bash
cd /mnt/c/Users/Lucascool/WorkBuddy/2026-09-16-13-35-47
python3 - <<'PY'
import pathlib, zipfile
root = pathlib.Path("casebook")
target = pathlib.Path("/tmp/odyssey-casebook.zip")
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
    archive.write(root / "casebook.json", "casebook.json")
    for image in sorted((root / "assets").rglob("*")):
        if image.is_file():
            archive.write(image, image.relative_to(root).as_posix())
print(target, target.stat().st_size)
PY
```

4. 导入页上传，逐项核对：

   - 预览显示 67 条用例、99 张图、182 处引用，原型版本与 `doc.prototype.version` 一致（与旧目录的 67 / 99 / 182 完全对齐，这是转换的 parity 检查）。
   - 测试组列表里 C-05 显示「原型 3 张」。
   - 执行页打开 C-05：`expected` 图在大图区，`locator` 图出现在「定位辅助图」区域且不进入大图切换；有 `focus` 的图显示核图重点；有 `expect_absent` 的用例显示「不应出现」清单；带 `protoNote` 的用例显示原型备注。
   - 保存一条「不通过」并上传实际截图，历史里的执行截图仍正常（参考图与执行截图互不影响）。
   - 导出该组 CSV，`reference_image_count` 与 `screenshot_count` 是两列不同的数字。

5. 负向验收（严格模式必须成立）：

   - 把 `casebook.json` 里某个 `role` 改成 `Expected`，重新打包上传 → 422，`detail` 指出 `cases[i].visual.references[j].role`。
   - 删掉一条 `references`，但保留对应的 `assets` 文件与 registry 条目 → 422，提示 `registry entries never referenced` 或 `image(s) never referenced`。
   - 把某条 `steps` 改成字符串 → 422，提示 `must be an array of strings`。

6. 关掉浏览器、重启 API 后再打开，参考图仍能显示（图片落在持久化卷的 `reference/` 目录）。

- [ ] **Step 6: 提交文档**

```bash
git add docs/CASEBOOK-FORMAT.md docs/IMPORT-FORMAT.md docs/superpowers/plans/README.md
git commit -m "docs: document the strict casebook v1 format"
```

---

## 完成标准

- 导入页提供两条路径：没有配图的用例用文本提示词；有设计稿的用例用带图提示词（内嵌完整 schema），两条都能「复制提示词」和「下载 .md」。
- `backend/app/schemas/casebook.schema.json` 是唯一真源；`docs/CASEBOOK-FORMAT.md`、`docs/AI-CASEBOOK-PROMPT.md`、运行时提示词三处内嵌同一份 schema，并有测试锁一致性。
- 严格模式生效：未知字段、类型不符、枚举越界、三处集合不一致、`not_verifiable` 缺 note 全部 422 作废并指出 JSON 路径。
- 图片按组去重（asset 表）+ 按用例引用（link 表），`role` / `caption` / `focus` 存在 link 上；执行页把目标核对图与定位辅助图分开显示，支持多图切换、放大、核图重点与「不应出现」清单。
- 报告新增 `reference_image_count`，不导出图片二进制或私有 URL。
- 旧 CSV / JSON / Markdown 导入与既有 245 条后端用例、101 条前端用例行为不变，`npm run build` 通过。
