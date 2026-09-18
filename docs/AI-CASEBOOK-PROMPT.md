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
15. 每条用例都必须带 `priority` 和 `layer`：沿用「已有用例」里该条的「优先级」和「执行分层」，分别写进 `priority`（只能 `P0` / `P1` / `P2`）和 `layer`（只能 `Smoke` / `Core` / `Regression`），写法与枚举完全一致，不要改名、不要换大小写。已有用例写的是中文分层时按 冒烟层→`Smoke`、核心层→`Core`、完整层 / 回归层→`Regression` 映射后再输出，不要照抄中文——`layer` 是严格枚举，写中文会被校验器整包拒绝。已有用例没写这两个值、或某条确实判断不出来时，**先停下来问我**（一次把缺的条目列清楚），不要自己猜、也不允许省略：漏写不会报错，但优先级和执行分层会整批丢失，属于缺陷。

**JSON Schema（必须逐条满足）**

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
          "position": { "type": "integer", "minimum": 1, "maximum": 2147483647 },
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

**输出前自检（逐条核对，不满足就改）**

1. 只输出了一个 JSON 对象，没有代码块围栏和解释文字？
2. 每个对象里都没有 schema 之外的字段？
3. 所有 `references[].asset` 都在图片清单里？清单里的图片都被引用了？
4. 每条用例的 `code` 唯一、`title` 非空、`steps`/`expected` 是字符串数组？
5. 所有 `not_verifiable` 都带了 `visual.note`，其它 check 都至少有一条 `references`？
6. `box` 是否都是 0–1 之间的 4 个数字？
7. `expect_absent` 只放了明确要求「不应出现」的内容？
8. 逐条核对（不是抽查）每条用例的 `priority` 和 `layer` 都写了，且取值分别在 `P0`/`P1`/`P2` 与 `Smoke`/`Core`/`Regression` 之内（`layer` 必须是英文枚举，「冒烟层 / 核心层 / 完整层」不算）？

【需求】
（在这里粘贴 PRD / 页面说明）

【已有用例】
（在这里粘贴你手上的用例）

【图片清单】
（在这里粘贴 assets 目录里的真实文件名，一行一个）

---

## 第二部分：格式速查（人工参考；AI 即使读到也不得放宽第一部分）

> 本节和第三部分是给人看的补充说明，**不是对第一部分的放宽**：哪个字段必填、能不能省，一律以第一部分「硬性要求」为准。若你正在生成 JSON，读到本节也不能据此省掉 `priority`、`layer` 或任何第一部分要求的字段。

完整说明见 [CASEBOOK-FORMAT.md](CASEBOOK-FORMAT.md)。要点：

- 包结构只有一个 JSON 加一棵图片树：`casebook.json` + `assets/<key>.<png|jpg|jpeg|webp>`；**文件名就是 key**。
- 图片按组去重：同一张图被多条用例引用时只存一份，用例侧保留 role / caption / focus。
- ZIP ≤ 100 MB，解压后 ≤ 250 MB，单张图 ≤ 20 MB 且 ≤ 5000 万像素，用例 1–5000 条。
- 校验是严格模式：字段、类型、枚举、三处集合任一不符都会 422 作废；`position`、`focus`、`box` 这类**可省字段**要么按类型写对，要么整个不写，写 `null` 会被拒绝。
- `priority` / `layer` 是第一部分的必填纪律：漏写**不会**报错，但导入和 Lark 都拿不到值，线上表现就是整批优先级落成 P2——不要把它当成上一条里的「可省字段」。
- 图片由人从设计稿导出，AI 只写 JSON。

## 第三部分：常见错误写法

| 写法 | 结果 |
| --- | --- |
| 用例里漏写 `priority` / `layer` | 导入不报错，但优先级和执行分层整批丢失，Lark 里全部显示 P2（见第一部分硬性要求第 15 条） |
| `"priority": "p0"` / `"layer": "smoke"` | `cases[0].priority: expected one of P0\|P1\|P2`（枚举大小写严格） |
| `"layer": "冒烟层"` | `cases[0].layer: expected one of Smoke\|Core\|Regression`（中文分层是硬失败，整包 422） |
| 顶层多写 `"slices": [...]` | `casebook.json: unknown field(s) slices` |
| 用例里写 `"steps": "1. 打开页面"` | `cases[0].steps: must be an array of strings` |
| `"role": "Expected"` | `references[0].role: expected one of expected\|locator` |
| 引用清单里没有的图片 | `references[0].asset: unknown asset 'xxx'` |
| 导出了图但没有用例引用 | `assets: image(s) never referenced: xxx` |
| `not_verifiable` 不写 note | `visual.note: required when check is 'not_verifiable'` |
| `box` 写成 `[62, 78, 30, 8]` | `box[0]: must be normalised between 0 and 1` |
| 中文编号 `登录-001` | `cases[0].code: must look like <MODULE>-<number>` |
