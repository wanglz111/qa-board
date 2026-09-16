import { useEffect, useState } from "react";
import { FileSpreadsheet, FileStack, FlaskConical, ListChecks, LogOut, ShieldCheck, Upload } from "lucide-react";

import { ApiError, api, type User } from "./api";
import { ExecutionView } from "./views/Execution";
import { GroupsView } from "./views/Groups";
import { ImportView } from "./views/Import";
import { LarkCheckView } from "./views/LarkCheck";
import { LoginView } from "./views/Login";
import { ReportsView } from "./views/Reports";

type View = "execute" | "groups" | "import" | "reports" | "lark";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState<View>("execute");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    api.me().then(setUser).catch((error) => {
      if (!(error instanceof ApiError) || error.status !== 401) console.error(error);
    }).finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => setUser(null);
    window.addEventListener("testdeck:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("testdeck:unauthorized", handleUnauthorized);
  }, []);

  if (checking) return <main className="loading-screen"><FlaskConical size={28} /><span>TestDeck</span></main>;
  if (!user) return <LoginView login={async (email, password) => setUser(await api.login(email, password))} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand"><FlaskConical size={21} /><strong>TestDeck</strong></div>
        <nav aria-label="主导航">
          <button className={view === "execute" ? "active" : ""} onClick={() => setView("execute")}><ListChecks size={17} />执行</button>
          <button className={view === "groups" ? "active" : ""} onClick={() => setView("groups")}><FileStack size={17} />测试组</button>
          <button className={view === "import" ? "active" : ""} onClick={() => setView("import")}><Upload size={17} />导入</button>
          <button className={view === "reports" ? "active" : ""} onClick={() => setView("reports")}><FileSpreadsheet size={17} />报告</button>
          <button className={view === "lark" ? "active" : ""} onClick={() => setView("lark")}><ShieldCheck size={17} />Lark 检查</button>
        </nav>
        <div className="account"><span>{user.email}</span><button className="icon-button" title="退出登录" aria-label="退出登录" onClick={async () => { await api.logout(); setUser(null); }}><LogOut size={17} /></button></div>
      </header>
      <main className="main-content">
        {view === "execute" ? (
          <ExecutionView
            loadGroups={api.groups}
            loadCases={api.cases}
            loadProgress={api.progress}
            loadAttempts={api.attempts}
            submit={api.submitAttempt}
            reserveRetest={api.reserveRetest}
            commitReserved={api.submitReserved}
            uploadScreenshot={api.uploadScreenshot}
            loadSync={api.syncStatus}
          />
        ) : view === "groups" ? (
          <GroupsView loadGroups={api.groups} loadCases={api.cases} refreshKey={refreshKey} />
        ) : view === "reports" ? (
          <ReportsView loadGroups={api.groups} reportUrl={api.reportUrl} />
        ) : view === "lark" ? (
          <LarkCheckView
            loadGroups={api.groups}
            loadCheck={api.larkCheck}
            loadConfirmation={api.larkConfirmation}
            confirm={api.confirmLark}
            loadSync={api.syncStatus}
            enqueueSync={api.enqueueSync}
          />
        ) : (
          <ImportView preview={api.preview} confirm={api.confirm} onImported={() => setRefreshKey((key) => key + 1)} />
        )}
      </main>
    </div>
  );
}
