# 带图用例包格式（casebook v1，严格模式）

这份文档是「用例 + 原型图」用例包的机器可校验规范，也是 AI 生成提示词的 schema 来源。

- 给 AI 的提示词见 [AI-CASEBOOK-PROMPT.md](AI-CASEBOOK-PROMPT.md)；导入页有「复制提示词」按钮。
- schema 真源是 `backend/app/schemas/casebook.schema.json`；本文件与提示词里内嵌的是同一份，有测试锁一致性。
- 导入端不做类型转换、不做默认值兜底、不兼容旧结构：不符合 schema 的包直接 422 作废，并返回失败的 JSON 路径。
- 没有配图的纯文本用例继续用 CSV / JSON / Markdown，见 [IMPORT-FORMAT.md](IMPORT-FORMAT.md)。

## 1. 包结构

```text
odyssey-casebook.zip
├── casebook.json
└── assets/
    ├── sale-stage-selling.png
    ├── sale-confirm-modal.png
    └── sale-24h-countdown.png
```

根目录只有 `casebook.json` 和 `assets/`，**图片文件名去扩展名就是 asset key**，用例只写一次引用，没有第二份 manifest 可以漂移。

## 2. 规范文件与一致性

机器可读规范：`backend/app/schemas/casebook.schema.json`。三处引用同一份文本，并用测试锁死：

1. `backend/app/schemas/casebook.schema.json` —— 唯一真源；
2. `docs/CASEBOOK-FORMAT.md` 与 `docs/AI-CASEBOOK-PROMPT.md` 里的 `<!-- casebook-schema:start -->` / `<!-- casebook-schema:end -->` 区块；
3. 运行时提示词 `backend/app/prompts/ai-casebook.md`（与 docs 逐字节相同）。

## 3. 完整 schema

<!-- casebook-schema:start -->
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
<!-- casebook-schema:end -->

## 4. 合法样例（两个用例共用一张图）

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

## 5. 严格校验清单

任一不满足 → 422 作废，`detail` 给出 JSON 路径（如 `cases[3].visual.references[0].role`）或文件名：

- 每个对象 `additionalProperties: false`：出现 schema 之外的字段（`slices`、`manifest`、拼错的 `refferences`）直接拒绝。
- 不做类型转换：`steps`/`expected` 必须是字符串数组，写成字符串失败；`position` 必须是整数；`box` 必须是 4 个 0–1 数字。
- 枚举精确匹配（大小写不宽容）：`role`、`type`、`check`、`priority`、`layer`。
- 三处集合必须完全一致：`assets/` 下的文件名（去扩展名）、`assets` 对象的 key、被 `references[].asset` 引用到的 key。多一张没被引用、少一张被引用、引用不存在的 key，全部拒绝。
- 用例 `code` 必须匹配 `<字母/数字>-<数字>` 且包内唯一；给了 `position` 就必须包内唯一；用例数 1–5000。
- ZIP 内 `casebook.json` 恰好一份；图片只允许 PNG / JPEG / WebP；ZIP ≤ 100 MB，解压后 ≤ 250 MB，单张图 ≤ 20 MB。

## 6. 为什么这样定

- **文件名即 key**：旧格式要 `slices: ["s05"]` 再去 `manifest.json` 查 `shots/app/s05.png`，两处同步是 AI 生成的主要失败源；现在只有一处。
- **严格优于兜底**：AI 输出错了就整包拒绝并指出路径，人拿到明确错误去改提示词；宽容解析只会把脏数据带进库。
- **图片按组去重**：Odyssey 实测 67 条用例、182 次引用、99 张唯一图，同一张图会被多条用例引用，因此拆「asset（文件）」+「link（用例→图）」两表。
- **`role` 区分目标图与辅助图**，**`focus` / `expect_absent`** 把原先写在 `protoNote` 散文里的「看这里」「不该出现 XXX」变成结构化清单。
- **图片始终是文件**：JSON 里只有 key，没有 Base64，也不联网抓图。

AI 生成纪律（写进提示词）：先列 `assets/` 真实文件名再写 JSON；图片由人从设计稿导出，AI 不编造、不抓取；原型覆盖不了的断言标 `not_verifiable` 并写 `note`。
