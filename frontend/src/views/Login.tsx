import { FormEvent, useState } from "react";
import { ArrowRight, FlaskConical } from "lucide-react";

type Props = {
  login: (email: string, password: string) => Promise<void>;
};

export function LoginView({ login }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await login(email, password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="brand-mark"><FlaskConical size={24} /></div>
        <p className="brand-name">TestDeck</p>
        <h1 id="login-title">管理员登录</h1>
        <form onSubmit={submit}>
          <label>邮箱<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
          <label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary wide" disabled={submitting}>
            {submitting ? "登录中" : "进入工作台"}<ArrowRight size={17} />
          </button>
        </form>
      </section>
    </main>
  );
}
