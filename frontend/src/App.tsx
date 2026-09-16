import { useEffect, useState } from "react";
import { FileStack, FlaskConical, LogOut, Upload } from "lucide-react";

import { ApiError, api, type User } from "./api";
import { GroupsView } from "./views/Groups";
import { ImportView } from "./views/Import";
import { LoginView } from "./views/Login";

type View = "groups" | "import";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState<View>("groups");
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
          <button className={view === "groups" ? "active" : ""} onClick={() => setView("groups")}><FileStack size={17} />测试组</button>
          <button className={view === "import" ? "active" : ""} onClick={() => setView("import")}><Upload size={17} />导入</button>
        </nav>
        <div className="account"><span>{user.email}</span><button className="icon-button" title="退出登录" aria-label="退出登录" onClick={async () => { await api.logout(); setUser(null); }}><LogOut size={17} /></button></div>
      </header>
      <main className="main-content">
        {view === "groups" ? <GroupsView loadGroups={api.groups} loadCases={api.cases} refreshKey={refreshKey} /> : <ImportView preview={api.preview} confirm={api.confirm} onImported={() => setRefreshKey((key) => key + 1)} />}
      </main>
    </div>
  );
}
