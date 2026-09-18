import { LoaderCircle, Upload } from "lucide-react";

import type { SyncStatus } from "../../api";

type StepSyncProps = {
  sync: SyncStatus | null;
  confirmed: boolean;
  queueing: boolean;
  retrying: boolean;
  onEnqueue: () => void;
  onRetry: (releaseUncertain: boolean) => void;
};

export function StepSync({ sync, confirmed, queueing, retrying, onEnqueue, onRetry }: StepSyncProps) {
  const failed = sync?.failed ?? 0;
  const uncertain = sync?.uncertain ?? 0;
  const parked = sync?.parked ?? 0;
  // 现状的可见条件原样保留：没确认、又没有待管理员处理的行时，这块没有可说的话。
  if (!confirmed && parked === 0) return null;
  return (
    <div className="lark-queue">
      <p className="inline-status">
        待同步 {sync?.queued ?? 0} · 已同步 {sync?.synced ?? 0} · 失败 {failed} · 待人工确认 {uncertain} ·
        待管理员处理 {parked}
        {sync?.last_error_kind ? ` · 最近错误 ${sync.last_error_kind}` : ""}
      </p>
      {/* 类别本身不可行动：这是他真的答了什么，加上 API 已经写好的补救办法。 */}
      {sync?.last_error ? (
        <p className="inline-status error" role="alert">
          {sync.last_error}
        </p>
      ) : null}
      <div className="lark-queue-actions">
        {confirmed ? (
          <button
            type="button"
            className="ghost-button"
            disabled={queueing || (sync?.pending_attempts ?? 0) === 0}
            title="把已保存、还没有同步任务的本地结果排入队列。同步只新增执行记录；不通过时会新增缺陷，旧记录与旧缺陷不会被修改。"
            onClick={onEnqueue}
          >
            {queueing ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}
            把已保存的本地结果排入同步
          </button>
        ) : null}
        {confirmed && failed > 0 ? (
          <button
            type="button"
            className="ghost-button"
            disabled={retrying}
            title="重新排入此前失败的行；已经写入远端的记录不会重复排队。"
            onClick={() => onRetry(false)}
          >
            {retrying ? <LoaderCircle className="spin" size={16} /> : null}
            重试失败的同步（{failed} 条）
          </button>
        ) : null}
        {parked > 0 ? (
          <button
            type="button"
            className="ghost-button"
            disabled={retrying}
            title="把等待管理员处理的记录重新指向当前已确认的目标表；只有管理员确认它们应写入当前目标表后才会继续。"
            onClick={() => onRetry(false)}
          >
            {retrying ? <LoaderCircle className="spin" size={16} /> : null}
            重新指向当前目标表（{parked} 条）
          </button>
        ) : null}
        {confirmed && uncertain > 0 ? (
          <button
            type="button"
            className="ghost-button"
            disabled={retrying}
            title="释放前请先在旧表搜索该复测标签：若远端其实已写入，释放后会再新增一条记录。"
            onClick={() => onRetry(true)}
          >
            {retrying ? <LoaderCircle className="spin" size={16} /> : null}
            已核对远端，释放待人工确认（{uncertain} 条）
          </button>
        ) : null}
      </div>
      {/* 下面两段都是「只在对应计数 > 0 时」出现：健康态一段都不渲染。 */}
      {confirmed && uncertain > 0 ? (
        <p className="attachment-hint">
          释放待人工确认前，请先在旧表搜索该复测标签：若远端其实已写入，释放后会再新增一条记录。
        </p>
      ) : null}
      {parked > 0 ? (
        <p className="attachment-hint">
          {parked} 条记录正在等待管理员处理，不会自行同步：只有管理员确认它们应写入当前目标表后才会继续。若目标表确实更换过，按「重新指向当前目标表」或「把已保存的本地结果排入同步」都会把它们重新指向当前目标表；若本组的写入确认已被撤销，需要先重新确认。
          {confirmed ? null : "本组目前尚未确认写入目标，这些记录不会同步。"}
        </p>
      ) : null}
    </div>
  );
}
