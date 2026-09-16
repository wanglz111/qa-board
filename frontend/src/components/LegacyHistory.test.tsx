import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import type { Attempt, LegacyHistory as LegacyHistoryData } from "../api";
import { LegacyHistory } from "./LegacyHistory";

const VERIFIED: LegacyHistoryData = {
  available: true,
  code: "B-001",
  read_errors: [],
  source_table_name: "执行记录",
  base_name: "旧版测试管理",
  bug_table_name: "缺陷记录",
  read_at: "2026-09-16T10:00:00Z",
  certainty: "verified",
  uncertainty: null,
  ambiguous: false,
  original: [
    {
      record_id: "old1",
      case_text: "B-001 Login",
      result: "不通过",
      note: "绑定未触发",
      console_text: null,
      observed_at: 1_700_000_000,
      ref_id: "ref-1",
      attachments: [{ index: 0, name: "old shot.png", mime: "image/png" }]
    }
  ],
  retests: [
    {
      record_id: "new1",
      case_text: "B-001-R0918-01 Login",
      result: "通过",
      note: null,
      console_text: null,
      observed_at: 1_700_100_000,
      ref_id: "ref-2",
      attachments: []
    }
  ],
  bugs: [
    {
      record_id: "bug1",
      description: "B-001 绑定未触发",
      status: "待修复",
      priority: "P0",
      matched_by: "问题描述"
    }
  ],
  unknown_count: 0
};

const ATTEMPTS: Attempt[] = [
  {
    id: "attempt-1",
    label: "B-001",
    sequence: 1,
    state: "committed",
    result: "不通过",
    note: "本组失败说明",
    console_text: null,
    source: "execution",
    created_at: "2026-09-16T11:00:00Z"
  }
];

it("keeps the legacy failure separate from this group's progress", async () => {
  render(<LegacyHistory code="B-001" loadHistory={async () => VERIFIED} />);

  expect(await screen.findByText("上次失败：绑定未触发")).toBeVisible();
  expect(screen.queryByText("本组已失败")).not.toBeInTheDocument();
});

it("shows the source table, read time and read-only bug status", async () => {
  render(<LegacyHistory code="B-001" loadHistory={async () => VERIFIED} />);

  expect(await screen.findByText(/来源：执行记录/)).toBeVisible();
  expect(screen.getByText("旧缺陷 待修复")).toBeVisible();
  expect(screen.getByText(/本工具只新增记录，不会关闭或修改旧缺陷/)).toBeVisible();
  expect(screen.getByText("B-001-R0918-01 Login")).toBeVisible();
});

it("does not invent a previous failure when the match is uncertain", async () => {
  render(
    <LegacyHistory
      code="B-001"
      loadHistory={async () => ({
        ...VERIFIED,
        certainty: "uncertain",
        uncertainty: "缺少可验证的日期或修改时间",
        ambiguous: true
      })}
    />
  );

  expect(await screen.findByText(/旧表匹配不确定/)).toBeVisible();
  expect(screen.queryByText(/上次失败：/)).not.toBeInTheDocument();
});

it("offers a retest that starts a new label and never claims to close the old bug", async () => {
  const onStartRetest = vi.fn();
  render(
    <LegacyHistory
      code="B-001"
      loadHistory={async () => VERIFIED}
      onStartRetest={onStartRetest}
      reservedLabel="B-001-R0918-a1b2c3-01"
    />
  );

  await userEvent.click(await screen.findByRole("button", { name: /复测（新标签/ }));
  expect(onStartRetest).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/已预留 B-001-R0918-a1b2c3-01/)).toBeVisible();
  expect(screen.queryByRole("button", { name: /关闭|修复旧缺陷/ })).not.toBeInTheDocument();
});

it("switches between legacy and current views", async () => {
  render(
    <LegacyHistory code="B-001" loadHistory={async () => VERIFIED} attempts={ATTEMPTS} />
  );

  expect(await screen.findByText("上次失败：绑定未触发")).toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: /本组测试/ }));

  expect(screen.getByText("说明：本组失败说明")).toBeVisible();
  expect(screen.queryByText("上次失败：绑定未触发")).not.toBeInTheDocument();
});

it("surfaces unmatched legacy rows honestly", async () => {
  render(
    <LegacyHistory
      code="B-001"
      loadHistory={async () => ({ ...VERIFIED, unknown_count: 3 })}
    />
  );
  expect(await screen.findByText(/另有 3 条旧记录无法解析/)).toBeVisible();
});

it("reports unavailable Lark without pretending there is a previous failure", async () => {
  render(
    <LegacyHistory
      code="B-001"
      loadHistory={async () => ({
        ...VERIFIED,
        available: false,
        read_errors: ["Lark request failed: ConnectError"],
        original: [],
        retests: [],
        bugs: []
      })}
    />
  );
  expect(await screen.findByText("旧表当前不可读，未显示历史结果")).toBeVisible();
  expect(screen.queryByText(/上次失败：/)).not.toBeInTheDocument();
});
